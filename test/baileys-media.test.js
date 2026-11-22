import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { promisify } from 'node:util';
import { createMessageHandler } from '../src/baileys-media.js';

const run = promisify(execFile);

test('Baileys video handler streams, repacks, replies and cleans up', async t => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'wa-media-test-'));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));
  const fixture = path.join(tempRoot, 'source.mov');
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=10',
    '-f', 'lavfi', '-i', 'sine=frequency=1000',
    '-t', '0.5', '-c:v', 'mpeg4', '-c:a', 'aac', fixture]);
  const input = await readFile(fixture);
  const sent = [];
  const errors = [];
  const handler = createMessageHandler({
    maxBytes: input.length,
    tempRoot,
    log: { error: message => errors.push(message) },
    async downloadMediaMessage(msg, type) {
      assert.equal(type, 'stream');
      if (msg.key.id === 'oversize') return Readable.from([input, Buffer.from('extra')]);
      if (msg.key.id === 'invalid') return Readable.from([Buffer.from('invalid video')]);
      return Readable.from([input]);
    }
  });
  const sock = { sendMessage: async (jid, message) => sent.push({ jid, ...message }) };
  function event(id, media) {
    return { type: 'notify', messages: [{ key: { remoteJid: 'test@s.whatsapp.net', id }, message: media }] };
  }

  await handler(sock, event('video', { videoMessage: {} }));
  assert.deepEqual(await readdir(tempRoot), ['source.mov']);
  const [reply] = sent.filter(message => message.video);
  assert.equal(reply.mimetype, 'video/mp4');
  assert.equal(reply.jid, 'test@s.whatsapp.net');
  const output = path.join(tempRoot, 'reply.mp4');
  await writeFile(output, reply.video);
  const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,pix_fmt', '-of', 'json', output]);
  assert.deepEqual(JSON.parse(stdout).streams, [{ codec_name: 'h264', pix_fmt: 'yuv420p' }, { codec_name: 'aac' }]);

  await handler(sock, event('oversize', { documentMessage: { mimetype: 'video/quicktime' } }));
  await handler(sock, event('invalid', { videoMessage: {} }));
  assert.equal(errors.length, 2);
  assert.equal(sent.filter(message => message.text?.startsWith('❌')).length, 2);
  assert.equal(sent.filter(message => message.video).length, 1);
  assert.deepEqual((await readdir(tempRoot)).sort(), ['reply.mp4', 'source.mov']);
});
