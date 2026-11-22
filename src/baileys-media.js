import { mkdtemp, rm } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import os from 'node:os';
import path from 'node:path';
import { repackVideo, VideoError } from './ffmpeg.js';

export const MAX_STATUS_INPUT_BYTES = 150_000_000;
const DOWNLOAD_TIMEOUT_MS = 180_000;
const UPLOAD_TIMEOUT_MS = 60_000;

const userMessages = {
  unsupported_video: 'Format video tidak disokong atau fail rosak. Sila hantar fail MP4 atau MOV.',
  timeout: 'Masa pemprosesan tamat. Sila cuba video yang lebih kecil atau pendek.',
  memory_exhausted: 'Memori pelayan tidak mencukupi. Sila cuba video beresolusi lebih rendah.',
  tool_terminated: 'Pemprosesan video terhenti. Sila cuba video beresolusi lebih rendah.',
  disk_full: 'Storan sementara penuh. Sila cuba lagi kemudian.',
  download: 'Video gagal dimuat turun. Sila hantar semula video.',
  upload: 'Video siap diproses tetapi gagal dihantar. Sila cuba lagi.',
  upload_size_rejected: 'WhatsApp menolak saiz video yang diproses. Sila cuba klip yang lebih pendek.',
  output_limit: 'Video yang diproses masih terlalu besar untuk dihantar. Sila cuba klip yang lebih pendek.'
};

function failureDetails(error, stage, downloadTimedOut) {
  if (error instanceof VideoError) return { stage: error.stage, reason: error.reason, ...error.details };
  let reason = 'operation_failed';
  if ((stage === 'download' && downloadTimedOut) || ['ETIMEDOUT', 'ECONNABORTED'].includes(error?.code)) reason = 'timeout';
  if (stage === 'upload' && (error?.response?.status === 413 || error?.output?.statusCode === 413)) reason = 'upload_size_rejected';
  if (error?.code === 'ENOMEM') reason = 'memory_exhausted';
  if (error?.code === 'ENOSPC') reason = 'disk_full';
  const statusCode = error?.response?.status ?? error?.output?.statusCode;
  return { stage, reason, ...(Number.isInteger(statusCode) && statusCode >= 100 && statusCode <= 599 && { statusCode }) };
}

function replyFor({ stage, reason, limitBytes, limitSeconds }) {
  if (reason === 'input_limit') return `Fail terlalu besar. Had saiz ialah ${limitBytes / 1_000_000} MB.`;
  if (reason === 'output_limit' && limitBytes) return `Video siap diproses tetapi melebihi had penghantaran bot (${limitBytes / 1_000_000} MB). Sila cuba klip yang lebih pendek.`;
  if (reason === 'duration_limit') return `Video terlalu panjang. Had tempoh ialah ${limitSeconds} saat.`;
  return userMessages[reason] || userMessages[stage] || 'Video gagal diproses. Sila cuba fail MP4 atau MOV yang lebih pendek.';
}

export function createMessageHandler({
  downloadMediaMessage, log, privateLogger, tempRoot = os.tmpdir(),
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
  const seen = new Set();
  let busy = false;

  async function processVideo(sock, jid, msg, media) {
    const started = Date.now();
    let dir;
    let bytes = 0;
    let stage = 'validation';
    let downloadTimer;
    let downloadTimedOut = false;
    const download = new AbortController();
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
      const output = path.join(dir, 'output.mp4');
      await sock.sendMessage(jid, { text: '⏳ Video diterima, sedang diproses...' }).catch(() => {});

      stage = 'download';
      downloadTimer = setTimeout(() => {
        downloadTimedOut = true;
        download.abort();
      }, downloadTimeoutMs);
      const { signal } = download;
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
      stage = 'ffmpeg';
      const metrics = await repackVideo(input, output, { statusVideo: true });
      log.info?.(metrics, 'Video processing completed');
      stage = 'upload';
      if (metrics.output.bytes > maxOutputBytes) {
        throw new VideoError(stage, 'output_limit', 'Output exceeds the upload size limit.', {
          outputBytes: metrics.output.bytes, limitBytes: maxOutputBytes
        });
      }
      await sock.sendMessage(jid, {
        video: { url: output }, mimetype: 'video/mp4', caption: '✅ Video siap untuk diuji di WhatsApp Status.'
      }, { mediaUploadTimeoutMs: UPLOAD_TIMEOUT_MS });
    } catch (error) {
      download.abort();
      const failure = failureDetails(error, stage, downloadTimedOut);
      log.error({ ...failure, downloadedBytes: bytes, elapsedMs: Date.now() - started }, 'Video processing failed');
      await sock.sendMessage(jid, { text: `❌ ${replyFor(failure)}` }).catch(() => {});
    } finally {
      clearTimeout(downloadTimer);
      if (dir) {
        await rm(dir, { recursive: true, force: true }).catch(() => log.error({
          stage: 'cleanup', reason: 'cleanup_failed'
        }, 'Video processing failed'));
      }
    }
  }

  return async function handleMessages(sock, { messages, type }) {
    if (type !== 'notify') return;
    for (const msg of messages) {
      const jid = msg.key.remoteJid;
      if (!jid || jid.endsWith('@g.us') || msg.key.fromMe || !msg.message) continue;
      const id = msg.key.id;
      if (seen.has(id)) continue;
      seen.add(id);
      if (seen.size > 1000) seen.clear();
      const payload = msg.message.ephemeralMessage?.message || msg.message;
      const media = payload.videoMessage || payload.documentMessage;
      if (!media) {
        const command = (payload.conversation || payload.extendedTextMessage?.text || '').trim().toUpperCase();
        if (command === 'PING') await sock.sendMessage(jid, { text: '🏓 Pong!' });
        else if (command === 'HELP') await sock.sendMessage(jid, { text: 'Hantar video MP4 atau MOV sehingga 150 MB dan 60 saat untuk WhatsApp Status.' });
        continue;
      }
      const document = payload.documentMessage;
      if (document && !/^video\//i.test(document.mimetype || '') &&
          !/\.(mp4|mov)$/i.test(document.fileName || '') &&
          document.mimetype && document.mimetype !== 'application/octet-stream') {
        log.error({ stage: 'validation', reason: 'unsupported_document_type' }, 'Video processing failed');
        await sock.sendMessage(jid, { text: `❌ ${userMessages.unsupported_video}` });
        continue;
      }
      if (busy) {
        await sock.sendMessage(jid, { text: '⏳ Bot sedang memproses video lain. Sila cuba sebentar lagi.' });
        continue;
      }
      busy = true;
      try {
        await processVideo(sock, jid, msg, media);
      } finally {
        busy = false;
      }
    }
  };
}
