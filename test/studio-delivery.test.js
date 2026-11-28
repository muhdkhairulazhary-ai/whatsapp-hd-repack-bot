import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { EventEmitter, once } from 'node:events';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { repackVideo } from '../src/ffmpeg.js';
import { createStudioDelivery } from '../src/studio-delivery.js';
import { DELIVERY_PATH, LINK_PATH, signedHeaders } from '../src/studio-bridge.js';
import { sendProcessedMedia } from '../src/baileys-send-media.js';

const key = Buffer.alloc(32, 7);
const jid = '15551234567@lid';

test('Studio transfer verifies bytes and sends the same media and options, once, guarded by ACKs', async t => {
  const root = await mkdtemp(join(tmpdir(), 'studio-bridge-'));
  const normal = join(root, 'normal.mp4');
  await repackVideo(fileURLToPath(new URL('./fixtures/dolby-vision-84.mov', import.meta.url)), normal, {
    statusVideo: true, preserveHdr: true
  });
  const video = await readFile(normal);
  const sha256 = createHash('sha256').update(video).digest('hex');
  const captures = [];
  const ws = new EventEmitter();
  const ev = new EventEmitter();
  let rejection;
  const guard = { blocked: false };
  const fake = { ws, ev, user: { id: '15551111111@s.whatsapp.net' },
    async sendMessage(target, message, { messageId, ...options }) {
      const { video: file, ...media } = message;
      captures.push({ target, bytes: await readFile(file.url), media, options });
      if (messageId) ws.emit('CB:ack,class:message', { attrs: { id: messageId, ...(rejection && { error: rejection }) } });
    }
  };
  const reservations = new Set();
  const bridge = createStudioDelivery({ key, origin: 'https://studio.example.test', socket: () => fake, guard, root,
    maxBytes: video.length, async reserve(id) { if (reservations.has(id)) return false; reservations.add(id); return true; }
  });
  const server = createServer(bridge.route);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await bridge.stop();
    await rm(root, { recursive: true, force: true });
  });
  const url = 'http://127.0.0.1:' + server.address().port + DELIVERY_PATH;
  const fields = { id: randomUUID(), jid, bytes: video.length, sha256, width: 1080, height: 1920 };
  const request = (data, { body = video, headers = signedHeaders(key, DELIVERY_PATH, data) } = {}) =>
    fetch(url, { method: 'POST', headers: { ...headers, 'content-type': 'video/mp4' }, body });

  await sendProcessedMedia(fake, jid, { ...fields, path: normal }, { signal: new AbortController().signal });

  assert.equal((await request(fields, { headers: signedHeaders(key, LINK_PATH, fields) })).status, 401);
  assert.equal((await request(fields, { headers: signedHeaders(key, DELIVERY_PATH, fields, Date.now() - 100_000) })).status, 401);
  assert.equal((await request({ ...fields, bytes: video.length + 1 })).status, 400);
  assert.equal((await request({ ...fields, id: randomUUID(), sha256: '0'.repeat(64) })).status, 422);
  assert.equal(captures.length, 1);
  assert.deepEqual(await (await request(fields)).json(), { state: 'sent' });
  assert.deepEqual(captures[0], captures[1]);
  assert.equal((await request(fields)).status, 409);
  assert.equal(captures.length, 2);

  rejection = '463';
  assert.deepEqual(await (await request({ ...fields, id: randomUUID() })).json(), { state: 'failed', reason: 'restricted' });
  guard.blocked = true;
  assert.equal((await request({ ...fields, id: randomUUID() })).status, 503);
  assert.equal(captures.length, 3);
  await bridge.stop();
  assert.deepEqual(await readdir(root), ['normal.mp4']);
});
