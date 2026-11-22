// Experimental WhatsApp Web transport. Not the official Meta API.
// Run with: node src/baileys-server.js
import 'dotenv/config';
import makeWASocket, { useMultiFileAuthState, DisconnectReason, downloadMediaMessage } from '@whiskeysockets/baileys';
import pino from 'pino';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { repackVideo } from './ffmpeg.js';

const log = pino({ level: process.env.LOG_LEVEL || 'info' });
const authDir = process.env.BAILEYS_AUTH_DIR || './baileys-auth';
const phone = (process.env.BAILEYS_PHONE_NUMBER || '').replace(/\D/g, '');
const maxBytes = Number(process.env.MAX_INPUT_BYTES || 16 * 1024 * 1024);
const seen = new Set();
let busy = false;

async function start() {
  await mkdir(authDir, { recursive: true, mode: 0o700 });
  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const sock = makeWASocket({ auth: state, logger: log, printQRInTerminal: false });
  sock.ev.on('creds.update', saveCreds);
  let pairingRequested = false;
  sock.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
    if (!state.creds.registered && phone && !pairingRequested && (connection === 'connecting' || connection === 'open')) {
      pairingRequested = true;
      try {
        const code = await sock.requestPairingCode(phone);
        // Pairing codes are credentials: view privately, never publish logs.
        log.warn({ pairingCode: code }, 'Temporary pairing code; protect your logs');
      } catch (err) { pairingRequested = false; log.error({ err }, 'Pairing failed'); }
    }
    if (connection === 'open') log.info('WhatsApp linked');
    if (connection === 'close') {
      const status = lastDisconnect?.error?.output?.statusCode;
      if (status !== DisconnectReason.loggedOut) setTimeout(start, 5000);
      else log.error('Logged out: remove stale auth and pair again');
    }
  });
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      const jid = msg.key.remoteJid;
      if (!jid || jid.endsWith('@g.us') || msg.key.fromMe || !msg.message) continue;
      const id = msg.key.id;
      if (seen.has(id)) continue;
      seen.add(id);
      if (seen.size > 1000) seen.clear();
      const payload = msg.message.ephemeralMessage?.message || msg.message;
      const media = payload.videoMessage || (payload.documentMessage && /^(video\/|application\/octet-stream)/.test(payload.documentMessage.mimetype || '') ? payload.documentMessage : null);
      if (!media) {
        const command = (payload.conversation || payload.extendedTextMessage?.text || '').trim().toUpperCase();
        if (command === 'PING') await sock.sendMessage(jid, { text: '🏓 Pong!' });
        else if (command === 'HELP') await sock.sendMessage(jid, { text: 'Send an MP4/MOV video or video document to convert it for WhatsApp Status.' });
        continue;
      }
      if (busy) { await sock.sendMessage(jid, { text: '⏳ Bot is processing another video. Try again shortly.' }); continue; }
      busy = true;
      const dir = await mkdtemp(path.join(os.tmpdir(), 'wa-baileys-'));
      try {
        await sock.sendMessage(jid, { text: '⏳ Video diterima, sedang diproses...' });
        const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: log, reuploadRequest: sock.updateMediaMessage });
        if (buffer.length > maxBytes) throw new Error('Video exceeds configured size limit');
        const input = path.join(dir, crypto.randomUUID() + '.input');
        const output = path.join(dir, crypto.randomUUID() + '.mp4');
        await writeFile(input, buffer, { mode: 0o600 });
        await repackVideo(input, output);
        await sock.sendMessage(jid, { video: await readFile(output), mimetype: 'video/mp4', caption: '✅ Video siap untuk diuji di WhatsApp Status.' });
      } catch (err) {
        log.error({ err }, 'Video processing failed');
        await sock.sendMessage(jid, { text: '❌ Video gagal diproses. Cuba fail MP4 lebih pendek.' }).catch(() => {});
      } finally {
        busy = false;
        await rm(dir, { recursive: true, force: true });
      }
    }
  });
}
start().catch(err => { log.fatal({ err }, 'Failed to start'); process.exitCode = 1; });
