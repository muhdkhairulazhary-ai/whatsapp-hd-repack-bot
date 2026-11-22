import { mkdtemp, rm } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import os from 'node:os';
import path from 'node:path';
import { getWAUploadToServer, jidNormalizedUser } from '@whiskeysockets/baileys';
import { commandReply } from './shelby-commands.js';
import { detectImageFormat, processImage } from './shelby-image.js';
import { repackVideo, VideoError } from './ffmpeg.js';

export const MAX_STATUS_INPUT_BYTES = 150_000_000;
const DOWNLOAD_TIMEOUT_MS = 180_000;
const UPLOAD_TIMEOUT_MS = 60_000;

const unavailable = 'Perkhidmatan tidak tersedia buat sementara waktu. Sila cuba lagi.';
const userMessages = {
  unsupported_image: 'Format gambar tidak disokong. Sila hantar JPEG, PNG atau HEIC.',
  image_conversion_failed: 'Gambar gagal diproses. Fail mungkin rosak atau format ini tidak disokong.',
  image_pixel_limit: 'Resolusi gambar melebihi had 50 megapiksel.',
  image: 'Gambar gagal diproses. Cuba hantar fail JPEG, PNG atau HEIC lain.',
  unsupported_video: 'Format video tidak disokong atau fail rosak. Sila hantar fail MP4 atau MOV.',
  timeout: 'Masa pemprosesan tamat. Sila cuba video yang lebih kecil atau pendek.',
  memory_exhausted: 'Memori pelayan tidak mencukupi. Sila cuba video beresolusi lebih rendah.',
  tool_terminated: 'Pemprosesan video terhenti. Sila cuba video beresolusi lebih rendah.',
  disk_full: 'Storan sementara penuh. Sila cuba lagi kemudian.',
  download: 'Media gagal dimuat turun. Sila hantar semula fail.',
  upload: 'Media siap diproses tetapi gagal dihantar. Sila cuba lagi.',
  upload_size_rejected: 'WhatsApp menolak saiz media yang diproses. Sila cuba fail yang lebih kecil.',
  output_limit: 'Video yang diproses masih terlalu besar untuk dihantar. Sila cuba klip yang lebih pendek.'
};

function failureDetails(error, stage, downloadTimedOut) {
  if (error instanceof VideoError) return { stage: error.stage, reason: error.reason, ...error.details };
  let reason = 'operation_failed';
  if (downloadTimedOut || ['ETIMEDOUT', 'ECONNABORTED'].includes(error?.code)) reason = 'timeout';
  if (stage === 'upload' && (error?.response?.status === 413 || error?.output?.statusCode === 413)) reason = 'upload_size_rejected';
  if (error?.code === 'ENOMEM') reason = 'memory_exhausted';
  if (error?.code === 'ENOSPC') reason = 'disk_full';
  const statusCode = error?.response?.status ?? error?.output?.statusCode;
  return { stage, reason, ...(Number.isInteger(statusCode) && statusCode >= 100 && statusCode <= 599 && { statusCode }) };
}

function replyFor({ stage, reason, limitBytes, limitSeconds }) {
  if (reason === 'input_limit') return `Fail terlalu besar. Had saiz ialah ${limitBytes / 1_000_000} MB.`;
  if (reason === 'output_limit' && limitBytes) return `Media siap diproses tetapi melebihi had penghantaran bot (${limitBytes / 1_000_000} MB). Sila cuba fail yang lebih kecil.`;
  if (reason === 'duration_limit') return `Video terlalu panjang. Had tempoh ialah ${limitSeconds} saat.`;
  return userMessages[reason] || userMessages[stage] || 'Video gagal diproses. Sila cuba fail MP4 atau MOV yang lebih pendek.';
}

export function createMessageHandler({
  downloadMediaMessage, log, privateLogger, accounts, tempRoot = os.tmpdir(),
  concurrency = Number(process.env.BOT_MEDIA_CONCURRENCY ?? 1),
  queueCapacity = Number(process.env.BOT_MEDIA_QUEUE_SIZE ?? 4),
  jobTimeoutMs = Number(process.env.BOT_MEDIA_JOB_TIMEOUT_MS ?? 900_000),
  maxBytes = Number(process.env.BAILEYS_MAX_INPUT_BYTES ?? MAX_STATUS_INPUT_BYTES),
  maxOutputBytes = Number(process.env.BAILEYS_MAX_OUTPUT_BYTES ?? MAX_STATUS_INPUT_BYTES),
  downloadTimeoutMs = DOWNLOAD_TIMEOUT_MS
}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > MAX_STATUS_INPUT_BYTES) {
    throw new Error('BAILEYS_MAX_INPUT_BYTES must be an integer between 1 and 150000000.');
  }
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0 || maxOutputBytes > MAX_STATUS_INPUT_BYTES) {
    throw new Error('BAILEYS_MAX_OUTPUT_BYTES must be an integer between 1 and 150000000.');
  }
  for (const [name, value, min, max] of [
    ['BOT_MEDIA_CONCURRENCY', concurrency, 1, 4],
    ['BOT_MEDIA_QUEUE_SIZE', queueCapacity, 0, 32],
    ['BOT_MEDIA_JOB_TIMEOUT_MS', jobTimeoutMs, 1000, 900_000]
  ]) {
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Invalid ${name}`);
  }
  const seen = new Set();
  const accepted = new Set();
  const queue = [];
  const active = new Map();
  let stopping = false;

  const sendText = (sock, jid, text) => Promise.resolve().then(() =>
    sock.sendMessage(jid, { text })).catch(() => {});

  function pump() {
    while (!stopping && active.size < concurrency && queue.length) {
      const job = queue.shift();
      const controller = new AbortController();
      const task = processMedia(job, controller).catch(() => {
        log.error({ stage: 'processing', reason: 'unexpected_failure' }, 'Media processing failed');
      }).finally(() => {
        active.delete(controller);
        accepted.delete(job.key);
        job.done();
        pump();
      });
      active.set(controller, task);
    }
  }

  async function processMedia({ sock, jid, msg, media, kind }, controller) {
    const started = Date.now();
    let dir;
    let bytes = 0;
    let stage = 'validation';
    let downloadTimer;
    let downloadTimedOut = false;
    const { signal } = controller;
    const jobTimer = setTimeout(() => controller.abort('job_deadline'), jobTimeoutMs);
    const rejectSize = () => new VideoError('validation', 'input_limit', 'Input exceeds the size limit.', { limitBytes: maxBytes });
    try {
      const declaredBytes = Number(media.fileLength);
      if (declaredBytes > maxBytes) {
        throw new VideoError('validation', 'input_limit', 'Input exceeds the size limit.', {
          limitBytes: maxBytes, ...(Number.isSafeInteger(declaredBytes) && { declaredBytes })
        });
      }
      stage = 'storage';
      dir = await mkdtemp(path.join(tempRoot, 'wa-baileys-'));
      const input = path.join(dir, 'input');
      const label = kind === 'image' ? 'Gambar' : kind === 'video' ? 'Video' : 'Fail';
      await sendText(sock, jid, `⏳ ${label} diterima, sedang diproses…`);

      stage = 'download';
      downloadTimer = setTimeout(() => {
        downloadTimedOut = true;
        controller.abort('download_deadline');
      }, downloadTimeoutMs);
      const mediaStream = await downloadMediaMessage(msg, 'stream', { options: { signal } }, {
        logger: privateLogger, reuploadRequest: sock.updateMediaMessage
      });
      await pipeline(mediaStream, async function* limit(source) {
        for await (const chunk of source) {
          bytes += chunk.length;
          if (bytes > maxBytes) throw rejectSize();
          yield chunk;
        }
      }, createWriteStream(input, { mode: 0o600 }), { signal });

      clearTimeout(downloadTimer);
      const imageFormat = kind === 'video' ? null : await detectImageFormat(input);
      const image = kind === 'image' || Boolean(imageFormat);
      stage = image ? 'image' : 'ffmpeg';
      let output = path.join(dir, 'output.mp4');
      let mimetype = 'video/mp4';
      let metrics;
      if (image) {
        const result = await processImage(input, dir, imageFormat, signal);
        ({ path: output, mimetype, metrics } = result);
      } else {
        metrics = await repackVideo(input, output, {
          statusVideo: true, signal,
          onProgress: fields => log.info?.(fields, 'FFmpeg progress')
        });
      }
      log.info?.({ ...metrics, kind: image ? 'image' : 'video', elapsedMs: Date.now() - started }, 'Media processing completed');
      stage = 'upload';
      if (metrics.output.bytes > maxOutputBytes) {
        throw new VideoError(stage, 'output_limit', 'Output exceeds the upload size limit.', {
          outputBytes: metrics.output.bytes, limitBytes: maxOutputBytes
        });
      }
      if (signal.aborted) throw new VideoError(stage, 'timeout', 'Media job timed out.');
      const options = { mediaUploadTimeoutMs: UPLOAD_TIMEOUT_MS };
      if (sock.refreshMediaConn) {
        const upload = getWAUploadToServer({ customUploadHosts: [], logger: privateLogger, options: { signal } },
          sock.refreshMediaConn);
        options.upload = async (...args) => {
          signal.throwIfAborted();
          const result = await upload(...args);
          signal.throwIfAborted();
          return result;
        };
      }
      await sock.sendMessage(jid, {
        [image ? 'image' : 'video']: { url: output },
        mimetype,
        // Shelby+ already bounded conversion. Skip Baileys' second full-media decode.
        jpegThumbnail: Buffer.alloc(0),
        width: metrics.output.width,
        height: metrics.output.height
      }, options);
      try {
        await accounts?.record(jid, image ? 'image' : 'video');
      } catch {
        log.error({ stage: 'account', reason: 'statistics_write_failed' }, 'Account update failed');
      }
    } catch (error) {
      const failure = failureDetails(error, stage, downloadTimedOut || signal.aborted);
      controller.abort();
      log.error({ ...failure, downloadedBytes: bytes, elapsedMs: Date.now() - started }, 'Media processing failed');
      if (!stopping) await sendText(sock, jid, `❌ ${replyFor(failure)}`);
    } finally {
      clearTimeout(jobTimer);
      clearTimeout(downloadTimer);
      if (dir) {
        await rm(dir, { recursive: true, force: true }).catch(() => log.error({
          stage: 'cleanup', reason: 'cleanup_failed'
        }, 'Video processing failed'));
      }
    }
  }

  async function handleMessages(sock, { messages, type }) {
    if (stopping || type !== 'notify') return;
    const jobs = [];
    for (const msg of messages) {
      if (stopping) break;
      const jid = jidNormalizedUser(msg.key.remoteJid || '');
      if (!/@(?:s\.whatsapp\.net|lid)$/.test(jid) || msg.key.fromMe || !msg.message) continue;
      const key = msg.key.id && `${jid}:${msg.key.id}`;
      if (key && (seen.has(key) || accepted.has(key))) continue;
      if (key) {
        seen.add(key);
        if (seen.size > 2048) seen.delete(seen.values().next().value);
      }
      const content = msg.message.ephemeralMessage?.message || msg.message;
      const payload = content.documentWithCaptionMessage?.message || content;
      const document = payload.documentMessage;
      const media = payload.videoMessage || payload.imageMessage || document;
      if (!media) {
        const text = payload.conversation || payload.extendedTextMessage?.text || '';
        try {
          const reply = await commandReply(text, jid, accounts);
          if (reply) await sendText(sock, jid, reply);
        } catch {
          log.error({ stage: 'account', reason: 'account_command_failed' }, 'Account command failed');
          await sendText(sock, jid, unavailable);
        }
        continue;
      }
      const mime = document?.mimetype || '';
      const filename = document?.fileName || '';
      let kind = payload.imageMessage ? 'image' : payload.videoMessage ? 'video' : 'document';
      if (document && (/^image\//i.test(mime) || /\.(jpe?g|png|hei[cf])$/i.test(filename))) kind = 'image';
      if (document && (/^video\//i.test(mime) || /\.(mp4|mov)$/i.test(filename))) kind = 'video';
      if (document && kind === 'document' && mime && mime !== 'application/octet-stream') {
        log.error({ stage: 'validation', reason: 'unsupported_document_type' }, 'Media processing failed');
        await sendText(sock, jid, '❌ Format fail tidak disokong. Hantar MP4, MOV, JPEG, PNG atau HEIC.');
        continue;
      }
      if (active.size >= concurrency && queue.length >= queueCapacity) {
        await sendText(sock, jid, '⏳ Barisan pemprosesan penuh. Sila hantar semula fail sebentar lagi.');
        continue;
      }
      const waiting = active.size >= concurrency;
      if (key) accepted.add(key);
      jobs.push(new Promise(done => queue.push({ sock, jid, msg, media, kind, key, done })));
      pump();
      if (waiting) await sendText(sock, jid, '⏳ Fail anda dalam barisan pemprosesan.');
    }
    await Promise.all(jobs);
  }

  handleMessages.stop = async () => {
    stopping = true;
    for (const job of queue.splice(0)) {
      accepted.delete(job.key);
      job.done();
    }
    for (const controller of active.keys()) controller.abort('shutdown');
    await Promise.all(active.values());
  };
  return handleMessages;
}
