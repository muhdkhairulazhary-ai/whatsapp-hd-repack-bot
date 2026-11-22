import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import os from 'node:os';
import path from 'node:path';
import { repackVideo } from './ffmpeg.js';

export function createMessageHandler({ downloadMediaMessage, maxBytes, log, privateLogger, tempRoot = os.tmpdir() }) {
  const seen = new Set();
  let busy = false;

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
      const media = payload.videoMessage || (payload.documentMessage && /^(video\/|application\/octet-stream)/.test(payload.documentMessage.mimetype || '') ? payload.documentMessage : null);
      if (!media) {
        const command = (payload.conversation || payload.extendedTextMessage?.text || '').trim().toUpperCase();
        if (command === 'PING') await sock.sendMessage(jid, { text: '🏓 Pong!' });
        else if (command === 'HELP') await sock.sendMessage(jid, { text: 'Send an MP4/MOV video or video document to convert it for WhatsApp Status.' });
        continue;
      }
      if (busy) { await sock.sendMessage(jid, { text: '⏳ Bot is processing another video. Try again shortly.' }); continue; }
      busy = true;
      let dir;
      try {
        dir = await mkdtemp(path.join(tempRoot, 'wa-baileys-'));
        await sock.sendMessage(jid, { text: '⏳ Video diterima, sedang diproses...' });
        if (Number(media.fileLength) > maxBytes) throw new Error('Video exceeds configured size limit');
        const input = path.join(dir, 'input');
        const output = path.join(dir, 'output.mp4');
        const mediaStream = await downloadMediaMessage(msg, 'stream', {}, {
          logger: privateLogger, reuploadRequest: sock.updateMediaMessage
        });
        await pipeline(mediaStream, async function* limit(source) {
          let bytes = 0;
          for await (const chunk of source) {
            bytes += chunk.length;
            if (bytes > maxBytes) throw new Error('Video exceeds configured size limit');
            yield chunk;
          }
        }, createWriteStream(input, { mode: 0o600 }));
        await repackVideo(input, output);
        await sock.sendMessage(jid, { video: await readFile(output), mimetype: 'video/mp4', caption: '✅ Video siap untuk diuji di WhatsApp Status.' });
      } catch {
        log.error('Video processing failed');
        await sock.sendMessage(jid, { text: '❌ Video gagal diproses. Cuba fail MP4 lebih pendek.' }).catch(() => {});
      } finally {
        busy = false;
        if (dir) await rm(dir, { recursive: true, force: true });
      }
    }
  };
}
