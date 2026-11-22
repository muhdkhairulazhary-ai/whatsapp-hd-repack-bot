import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile, copyFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { promisify } from 'node:util';
import { config } from '../src/config.js';
import { MAX_STATUS_INPUT_BYTES, createMessageHandler } from '../src/baileys-media.js';

const run = promisify(execFile);

test('Baileys video handler streams, repacks, replies and cleans up', async t => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'wa-media-test-'));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));
  const fixture = path.join(tempRoot, 'source.mov');
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=10',
    '-f', 'lavfi', '-i', 'sine=frequency=1000',
    '-t', '0.5', '-c:v', 'libx265', '-x265-params', 'pools=none:frame-threads=1:log-level=error',
    '-pix_fmt', 'yuv420p10le', '-tag:v', 'hvc1', '-c:a', 'aac', fixture]);
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
  const output = path.join(tempRoot, 'reply.mp4');
  const sock = { async sendMessage(jid, message) {
    if (message.video) await copyFile(message.video.url, output);
    sent.push({ jid, ...message });
  } };
  function event(id, media) {
    return { type: 'notify', messages: [{ key: { remoteJid: 'test@s.whatsapp.net', id }, message: media }] };
  }

  await handler(sock, event('video', { videoMessage: {} }));
  assert.deepEqual((await readdir(tempRoot)).sort(), ['source.mov', 'reply.mp4'].sort());
  const [reply] = sent.filter(message => message.video);
  assert.equal(reply.mimetype, 'video/mp4');
  assert.equal(reply.jid, 'test@s.whatsapp.net');
  const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,pix_fmt', '-of', 'json', output]);
  assert.deepEqual(JSON.parse(stdout).streams, [{ codec_name: 'h264', pix_fmt: 'yuv420p' }, { codec_name: 'aac' }]);

  await handler(sock, event('oversize', { documentMessage: { mimetype: 'video/quicktime' } }));
  await handler(sock, event('invalid', { videoMessage: {} }));
  assert.equal(errors.length, 2);
  assert.equal(sent.filter(message => message.text?.startsWith('❌')).length, 2);
  assert.equal(sent.filter(message => message.video).length, 1);
  assert.deepEqual((await readdir(tempRoot)).sort(), ['reply.mp4', 'source.mov']);
});

function videoEvent(id, media = {}) {
  return { type: 'notify', messages: [{
    key: { remoteJid: 'private@s.whatsapp.net', id }, message: { videoMessage: media }
  }] };
}

test('150 MB boundary is enforced in metadata and during download', async t => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'wa-limit-test-'));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));
  const errors = [];
  const sent = [];
  const sock = { sendMessage: async (jid, message) => sent.push(message) };
  let downloads = 0;
  let signal;
  const handler = createMessageHandler({
    tempRoot, log: { error: fields => errors.push(fields) },
    async downloadMediaMessage(msg, type, options) {
      downloads++;
      signal = options.options.signal;
      const chunk = Buffer.alloc(1_000_000);
      return Readable.from((function* () {
        for (let i = 0; i < 150; i++) yield chunk;
        if (msg.key.id === 'stream-over') yield Buffer.from([0]);
      })());
    }
  });

  await handler(sock, videoEvent('declared-over', { fileLength: MAX_STATUS_INPUT_BYTES + 1 }));
  assert.equal(downloads, 0);
  assert.equal(errors.at(-1).reason, 'input_limit');
  assert.match(sent.at(-1).text, /150 MB/);
  await handler(sock, videoEvent('at-limit', { fileLength: MAX_STATUS_INPUT_BYTES }));
  assert.equal(downloads, 1);
  assert.equal(errors.at(-1).reason, 'unsupported_video');
  assert.equal(errors.at(-1).downloadedBytes, MAX_STATUS_INPUT_BYTES);
  await handler(sock, videoEvent('stream-over'));
  assert.equal(errors.at(-1).reason, 'input_limit');
  assert.equal(signal.aborted, true);
  assert.deepEqual(await readdir(tempRoot), []);
});

test('22.2 MB and exactly 60 seconds are supported, and longer clips are rejected', async t => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'wa-duration-test-'));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));
  const fixture = path.join(tempRoot, 'source.mp4');
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=size=32x48:rate=1',
    '-t', '60', '-c:v', 'libx264', fixture]);
  const file = await readFile(fixture);
  const padding = Buffer.alloc(22_200_000 - file.length);
  padding.writeUInt32BE(padding.length);
  padding.write('free', 4);
  const errors = [];
  const sent = [];
  const sock = { async sendMessage(jid, message) {
    sent.push(message);
    if (message.video) {
      const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,width,height', '-of', 'csv=p=0', message.video.url]);
      assert.match(stdout, /h264,32,48/);
      assert.match(stdout, /aac/);
    }
  } };
  const handler = createMessageHandler({
    tempRoot, log: { error: fields => errors.push(fields) },
    async downloadMediaMessage(msg) {
      return msg.key.id === 'full-minute' ? Readable.from([file, padding]) : Readable.from([await readFile(fixture)]);
    }
  });
  const legacyLimit = createMessageHandler({
    maxBytes: 16 * 1024 * 1024, tempRoot, log: { error: fields => errors.push(fields) },
    async downloadMediaMessage() { assert.fail('The old limit rejects before download'); }
  });
  await legacyLimit(sock, videoEvent('old-limit', { fileLength: 22_200_000 }));
  assert.equal(errors.pop().reason, 'input_limit');
  await handler(sock, videoEvent('full-minute', { fileLength: 22_200_000 }));
  assert.equal(errors.length, 0);
  assert.ok(sent.some(message => message.video));

  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=size=32x48:rate=1',
    '-t', '61', '-c:v', 'libx264', fixture]);
  await handler(sock, videoEvent('too-long'));
  assert.equal(errors.at(-1).reason, 'duration_limit');
  assert.match(sent.at(-1).text, /60 saat/);
  assert.deepEqual(await readdir(tempRoot), ['source.mp4']);
});

test('download, timeout, memory, FFmpeg and upload failures are distinct and private', async t => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'wa-errors-test-'));
  const originalPath = process.env.PATH;
  const originalTimeout = config.ffmpegTimeoutMs;
  t.after(async () => {
    process.env.PATH = originalPath;
    config.ffmpegTimeoutMs = originalTimeout;
    await rm(tempRoot, { recursive: true, force: true });
  });
  const fixture = path.join(tempRoot, 'source.mp4');
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=size=32x48:rate=1',
    '-t', '1', '-c:v', 'libx264', fixture]);
  const buffer = await readFile(fixture);
  const errors = [];
  const sent = [];
  const sock = { async sendMessage(jid, message) {
    if (message.video) throw Object.assign(new Error('private-upload-url'), { output: { statusCode: 503 } });
    sent.push(message);
  } };
  const handler = createMessageHandler({
    tempRoot, downloadTimeoutMs: 250, log: { error: fields => errors.push(fields) },
    async downloadMediaMessage(msg) {
      if (msg.key.id === 'download') {
        throw Object.assign(new Error('private-download-url'), { response: { status: 404 } });
      }
      if (msg.key.id === 'stalled') return new Readable({ read() {} });
      return Readable.from([buffer]);
    }
  });
  await handler(sock, videoEvent('download'));
  await handler(sock, videoEvent('stalled'));
  await handler(sock, videoEvent('upload'));
  assert.deepEqual(errors.map(({ stage, reason, statusCode }) => [stage, reason, statusCode]), [
    ['download', 'operation_failed', 404], ['download', 'timeout', undefined], ['upload', 'operation_failed', 503]
  ]);
  assert.match(sent.at(-1).text, /gagal dihantar/);

  const bin = path.join(tempRoot, 'bin');
  await mkdir(bin);
  process.env.PATH = `${bin}:${originalPath}`;
  const executable = path.join(bin, 'ffmpeg');
  await writeFile(executable, '#!/bin/sh\necho "Cannot allocate memory: private filename" >&2\nexit 1\n', { mode: 0o700 });
  await handler(sock, videoEvent('memory'));
  assert.equal(errors.at(-1).reason, 'memory_exhausted');
  await writeFile(executable, '#!/bin/sh\necho "private codec error" >&2\nexit 7\n');
  await handler(sock, videoEvent('encode'));
  assert.equal(errors.at(-1).reason, 'encode_failed');
  assert.equal(errors.at(-1).exitCode, 7);
  await writeFile(executable, '#!/bin/sh\nexec sleep 30\n');
  config.ffmpegTimeoutMs = 50;
  await handler(sock, videoEvent('encode-timeout'));
  assert.equal(errors.at(-1).reason, 'timeout');
  assert.equal(errors.at(-1).stage, 'ffmpeg');
  assert.equal(errors.at(-1).signal, 'SIGKILL');
  assert.doesNotMatch(JSON.stringify(errors), /private|wa-errors-test/);
  assert.deepEqual((await readdir(tempRoot)).sort(), ['bin', 'source.mp4']);
});

test('compatible 1080×1920 60 fps MP4 is copied packet-for-packet and logged safely', async t => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'wa-copy-test-'));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));
  const fixture = path.join(tempRoot, 'source.mp4');
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=size=1080x1920:rate=60',
    '-f', 'lavfi', '-i', 'sine=frequency=1000', '-t', '0.25',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-threads:v', '2', '-c:a', 'aac', fixture]);
  async function packetHashes(file, stream) {
    const { stdout } = await run('ffprobe', ['-v', 'error', '-select_streams', stream, '-show_packets',
      '-show_entries', 'packet=data_hash', '-show_data_hash', 'sha256', '-of', 'json', file]);
    return JSON.parse(stdout).packets.map(packet => packet.data_hash);
  }

  const original = await readFile(fixture);
  const logs = [];
  const errors = [];
  const sock = { async sendMessage(jid, message) {
    if (!message.video) return;
    for (const stream of ['v:0', 'a:0']) {
      assert.deepEqual(await packetHashes(message.video.url, stream), await packetHashes(fixture, stream));
    }
  } };
  const handler = createMessageHandler({
    tempRoot, log: { info: fields => logs.push(fields), error: fields => errors.push(fields) },
    downloadMediaMessage: async () => Readable.from([original])
  });
  await handler(sock, videoEvent('private-message-id'));
  assert.deepEqual(errors, []);
  assert.equal(logs.length, 1);
  const [metrics] = logs;
  assert.equal(metrics.videoMode, 'copy');
  assert.equal(metrics.audioMode, 'copy');
  for (const media of [metrics.input, metrics.output]) {
    assert.equal(media.width, 1080);
    assert.equal(media.height, 1920);
    assert.equal(media.fps, '60/1');
    assert.ok(media.bitrateBps > 0);
  }
  assert.equal(metrics.input.bytes, original.length);
  assert.ok(Math.abs(metrics.output.bytes - original.length) < 2048);
  assert.doesNotMatch(JSON.stringify(logs), /source\.mp4|private-message|wa-copy-test/);
});

test('1080×1920 HEVC conversion keeps frame rate and rejects over-limit output without retrying at lower quality', async t => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'wa-hd-test-'));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));
  const fixture = path.join(tempRoot, 'source.mov');
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1080x1920:rate=48',
    '-t', '0.25', '-c:v', 'libx265', '-preset', 'ultrafast', '-threads:v', '1',
    '-x265-params', 'pools=none:frame-threads=1:log-level=error', '-tag:v', 'hvc1', fixture]);
  const original = await readFile(fixture);
  const logs = [];
  const errors = [];
  const sent = [];
  const handler = createMessageHandler({
    tempRoot, maxOutputBytes: 1,
    log: { info: fields => logs.push(fields), error: fields => errors.push(fields) },
    downloadMediaMessage: async () => Readable.from([original])
  });
  await handler({ sendMessage: async (jid, message) => sent.push(message) }, videoEvent('too-big-output'));

  assert.equal(logs.length, 1);
  assert.equal(logs[0].videoMode, 'encode');
  assert.equal(logs[0].input.videoCodec, 'hevc');
  assert.equal(logs[0].output.videoCodec, 'h264');
  assert.equal(logs[0].output.width, 1080);
  assert.equal(logs[0].output.height, 1920);
  assert.equal(logs[0].output.fps, '48/1');
  assert.equal(errors[0].stage, 'upload');
  assert.equal(errors[0].reason, 'output_limit');
  assert.equal(sent.some(message => message.video), false);
  assert.match(sent.at(-1).text, /had penghantaran/);
});
