import express from 'express';
import converterRouter from './converter.js';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import pino from 'pino';
import { config, assertConfigured } from './config.js';
import { verifyMetaSignature } from './security.js';
import { parseCommand, HELP_TEXT } from './commands.js';
import { repackVideo } from './ffmpeg.js';
import { downloadMedia, sendText, uploadMedia, sendVideo } from './whatsapp.js';

const logger = pino({ level: config.logLevel, redact: ['*.authorization', '*.headers.Authorization'] });
const app = express();
// In-memory conversation state. Resets when the service restarts.
const pendingMedia = new Map();
const MEDIA_TTL_MS = 30 * 60 * 1000;
const recentMessages = new Map();
app.use(express.static('public'));
app.use(converterRouter);

// Keep the exact raw bytes for Meta's X-Hub-Signature-256 verification.
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === config.verifyToken && typeof challenge === 'string') {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

app.post('/webhook', express.raw({ type: 'application/json', limit: '2mb' }), (req, res) => {
  const signature = req.get('x-hub-signature-256');
  if (!verifyMetaSignature(req.body, signature, config.appSecret)) {
    logger.warn('Rejected webhook with invalid signature');
    return res.sendStatus(401);
  }

  let payload;
  try {
    payload = JSON.parse(req.body.toString('utf8'));
  } catch {
    return res.sendStatus(400);
  }

  // Acknowledge Meta quickly; process the message asynchronously.
  res.sendStatus(200);
  void handleWebhook(payload).catch(error => logger.error({ err: error }, 'Webhook processing failed'));
});

app.get('/health', (_req, res) => res.status(200).json({ ok: true, service: 'whatsapp-hd-repack-bot' }));

async function handleWebhook(payload) {
  if (payload?.object !== 'whatsapp_business_account') return;
  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      for (const message of change.value?.messages ?? []) {
        const sender = message.from;
        if (!sender) continue;
        const now = Date.now();
        for (const [id, expiry] of recentMessages) if (expiry < now) recentMessages.delete(id);
        if (message.id && recentMessages.has(message.id)) continue;
        if (message.id) recentMessages.set(message.id, now + MEDIA_TTL_MS);
        try {
          if (message.type === 'text') {
            const command = parseCommand(message.text?.body);
            if (command === 'media') {
              pendingMedia.set(sender, { expires: Date.now() + MEDIA_TTL_MS });
              await sendText(sender, 'Caption disimpan. Sekarang kirim video sebagai Dokumen agar kualitasnya terjaga.');
            }
            else if (command === 'help') await sendText(sender, HELP_TEXT);
            else if (command === 'ping') await sendText(sender, '🏓 Pong! The bot is responding.');
            else if (command === 'status') await sendText(sender, '✅ Bot is online and ready to process videos.');
            else await sendText(sender, 'I did not recognise that command. Send HELP for instructions, or send me a video.');
            continue;
          }

          const media = message.type === 'document' ? message.document : message.video;
          const isDocument = message.type === 'document';
          if (!['video', 'document'].includes(message.type) || !media?.id) {
            await sendText(sender, 'Please send a video message, or send HELP to see available commands.');
            continue;
          }

          const session = pendingMedia.get(sender);
          if (session && session.expires < Date.now()) pendingMedia.delete(sender);
          await sendText(sender, '⏳ Video diterima. Sedang memproses, sila tunggu...');
          const workDir = await mkdtemp(path.join(os.tmpdir(), 'wa-repack-'));
          const inputPath = path.join(workDir, `${crypto.randomUUID()}.input`);
          const outputPath = path.join(workDir, `${crypto.randomUUID()}.mp4`);
          try {
            const mime = (media.mime_type || '').split(';')[0].toLowerCase();
            const filename = isDocument ? (media.filename || '') : '';
            const supportedExtension = /\.(mp4|mov|m4v|3gp|avi|webm)$/i.test(filename);
            if (isDocument && !supportedExtension && !['video/mp4', 'video/quicktime', 'video/3gpp', 'video/x-msvideo', 'video/webm'].includes(mime)) {
              throw new Error('Unsupported video format. Please send a video document in MP4 or MOV format.');
            }
            if (!['video/mp4', 'video/quicktime', 'video/3gpp', 'video/x-msvideo', 'video/webm'].includes(mime) && !supportedExtension) {
              throw new Error('Unsupported video format. Please send MP4, MOV, 3GP, AVI or WebM.');
            }
            await downloadMedia(media.id, inputPath, config.maxInputBytes);
            await repackVideo(inputPath, outputPath);
            const mediaId = await uploadMedia(outputPath);
            await sendVideo(sender, mediaId);
            pendingMedia.delete(sender);
          } catch (error) {
            logger.warn({ err: error, sender }, 'Could not process incoming video');
            const safeMessage = error.message.includes('larger than') || error.message.includes('too large') || error.message.includes('Unsupported') || error.message.includes('timed out') || error.message.includes('longer than')
              ? error.message
              : 'Sorry, I could not process that video. Please try a shorter MP4 video and send it again.';
            await sendText(sender, `❌ ${safeMessage}`).catch(() => {});
          } finally {
            await rm(workDir, { recursive: true, force: true }).catch(error => logger.warn({ err: error }, 'Temporary file cleanup failed'));
          }
        } catch (error) {
          logger.error({ err: error }, 'Message handling failed');
        }
      }
    }
  }
}

assertConfigured();
app.listen(config.port, '0.0.0.0', () => logger.info({ port: config.port }, 'WhatsApp HD Repack Bot listening'));
