// Experimental WhatsApp Web transport. Not the official Meta API.
// Run with: node src/baileys-server.js
import 'dotenv/config';
import makeWASocket, { useMultiFileAuthState, DisconnectReason, downloadMediaMessage } from '@whiskeysockets/baileys';
import pino from 'pino';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { repackVideo } from './ffmpeg.js';

const log = pino({ level: process.env.LOG_LEVEL || 'info' });
const authDir = process.env.BAILEYS_AUTH_DIR || './baileys-auth';
const phone = (process.env.BAILEYS_PHONE_NUMBER || '').replace(/\D/g, '');
const maxBytes = Number(process.env.MAX_INPUT_BYTES || 16 * 1024 * 1024);
const seen = new Set();
const port = Number(process.env.PORT || 3000);
let connected = false;
let pairingCode = null;
let pairingExpires = 0;
const pairingToken = process.env.PAIRING_ACCESS_TOKEN || '';
http.createServer((req, res) => {
  if (req.url === '/pairing' && req.method === 'POST') {
    res.setHeader('cache-control', 'no-store');
    const supplied = req.headers.authorization?.replace(/^Bearer /i, '') || '';
    const a = Buffer.from(supplied), b = Buffer.from(pairingToken);
    if (!pairingToken || a.length !== b.length || !crypto.timingSafeEqual(a,b)) { res.writeHead(403); return res.end('Forbidden'); }
    if (!pairingCode || Date.now() > pairingExpires) { res.writeHead(404); return res.end('Pairing code unavailable'); }
    const code = pairingCode; pairingCode = null;
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ code }));
  }
  if (req.url !== '/health') { res.writeHead(404); return res.end('Not found'); }
  res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify({ ok: true, whatsappConnected: connected }));
}).listen(port, '0.0.0.0', () => log.info({ port }, 'Health server listening'));
let busy = false;

async function start() {
  await mkdir(authDir, { recursive: true, mode: 0o700 });
  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const sock = makeWASocket({
    auth: state,
    logger: log,
    printQRInTerminal: false,
    connectTimeoutMs: 60000,
    keepAliveIntervalMs: 30000,
  });
  let socketClosed = false;
  let pairingTimer = null;
  let pairingAttempted = false;
  sock.ev.on('creds.update', saveCreds);
  let pairingRequested = false;
  sock.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
    // Request a phone-number pairing code when the websocket is connected.
    // A QR event is not required for phone-number pairing.
    if (!state.creds.registered && phone && pairingToken && !pairingAttempted && !socketClosed && connection === 'connecting') {
      pairingAttempted = true;
      const attemptPairing = async (retries = 0) => {
        if (socketClosed) return;
        if (sock.ws?.readyState !== 1) {
          if (retries < 20) pairingTimer = setTimeout(() => attemptPairing(retries + 1), 500);
          else log.warn('Pairing not attempted: websocket never became ready');
          return;
        }
        try {
          const code = await sock.requestPairingCode(phone);
          if (!socketClosed) {
            pairingCode = code;
            pairingExpires = Date.now() + 120000;
            log.info('Pairing code available via authenticated endpoint');
          }
        } catch (err) {
          log.warn({ message: err?.message, statusCode: err?.output?.statusCode }, 'Pairing request unsuccessful');
        }
      };
      pairingTimer = setTimeout(() => attemptPairing(), 500);
    }
    if (connection === 'open') { connected = true; pairingCode = null; log.info('WhatsApp linked'); }
    if (connection === 'close') {
      socketClosed = true;
      if (pairingTimer) clearTimeout(pairingTimer);
      pairingCode = null;
      connected = false;
      const status = lastDisconnect?.error?.output?.statusCode;
      log.warn({ statusCode: status, reason: lastDisconnect?.error?.message }, 'WhatsApp connection closed');
      if (status !== DisconnectReason.loggedOut) setTimeout(() => {
        start().catch(err => log.error({ err }, 'Reconnect failed'));
      }, 10000);
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
