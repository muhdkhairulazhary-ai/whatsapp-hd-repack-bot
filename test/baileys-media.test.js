import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { EventEmitter, once } from 'node:events';
import { decodeMessageNode, getHttpStream, proto } from '@whiskeysockets/baileys';
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
  const recorded = [];
  const stages = [];
  const handler = createMessageHandler({
    telemetry: { start() {
      const fail = () => { throw new Error('Synthetic telemetry failure'); };
      return { update: fail, finish: fail, discard: fail };
    } },
    accounts: { async record(jid, kind) { recorded.push([jid, kind]); } },
    maxBytes: input.length,
    tempRoot,
    log: { error: message => errors.push(message), info: fields => { if (fields.stage) stages.push(fields); } },
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

  await handler(sock, event('video', { videoMessage: { caption: 'private original caption' } }));
  assert.deepEqual((await readdir(tempRoot)).sort(), ['source.mov', 'reply.mp4'].sort());
  const [reply] = sent.filter(message => message.video);
  assert.equal(Object.hasOwn(reply, 'caption'), false);
  assert.deepEqual(stages.map(fields => fields.stage), ['download', 'ffprobe', 'ffmpeg', 'verification', 'upload', 'total']);
  assert.ok(stages.every(fields => fields.outcome === 'ok' && fields.elapsedMs >= 0));
  assert.equal(reply.mimetype, 'video/mp4');
  assert.equal(reply.jid, 'test@s.whatsapp.net');
  const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,pix_fmt', '-of', 'json', output]);
  assert.deepEqual(JSON.parse(stdout).streams, [{ codec_name: 'h264', pix_fmt: 'yuv420p' }, { codec_name: 'aac' }]);

  await handler(sock, event('oversize', { documentMessage: { mimetype: 'video/quicktime' } }));
  await handler(sock, event('invalid', { videoMessage: {} }));
  assert.equal(errors.length, 2);
  assert.deepEqual(recorded, [['test@s.whatsapp.net', 'video']]);
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
    tempRoot, log: { info: fields => { if (fields.input) logs.push(fields); }, error: fields => errors.push(fields) },
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

test('1080×1920 HEVC conversion keeps frame rate and rejects an impossible size budget', async t => {
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
    tempRoot,
    log: { info: fields => { if (fields.input) logs.push(fields); }, error: fields => errors.push(fields) },
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
  assert.deepEqual(errors, []);
  assert.equal(sent.some(message => message.video), true);
  const tinyBudget = createMessageHandler({
    tempRoot, maxOutputBytes: 1, log: { error: fields => errors.push(fields) },
    downloadMediaMessage: async () => Readable.from([original])
  });
  await tinyBudget({ sendMessage: async (jid, message) => sent.push(message) }, videoEvent('impossible-budget'));
  assert.equal(errors[0].reason, 'size_quality_limit');
  assert.equal(sent.filter(message => message.video).length, 1);
  assert.match(sent.at(-1).text, /kualiti yang sesuai/);
});

test('FFmpeg progress only reports numeric metrics and distinguishes job deadlines and crashes', async () => {
  const { runTool } = await import('../src/ffmpeg.js');
  const updates = [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('job_deadline'), 150);
  try {
    await assert.rejects(runTool('sh', ['-c', 'printf "frame=42\\nspeed=1.5x\\nout_time_us=2000000\\nprivate=secret\\n" >&3; exec sleep 30'], {
      stage: 'ffmpeg', timeoutMs: 1000, signal: controller.signal, progressIntervalMs: 30,
      onProgress: update => updates.push(update)
    }), error => error.reason === 'timeout' && error.details.stopSource === 'job_deadline');
  } finally {
    clearTimeout(timer);
  }
  assert.ok(updates.some(update => update.frames === 42 && update.outputTimeMs === 2000 && update.speed === 1.5));
  assert.doesNotMatch(JSON.stringify(updates), /private|secret/);
  await assert.rejects(runTool('sh', ['-c', 'ulimit -c 0; kill -SEGV $$'], {
    stage: 'ffmpeg', timeoutMs: 1000
  }), error => error.reason === 'tool_crashed' && error.details.signal === 'SIGSEGV');
});

test('a rotated compatible MOV is remuxed with its display matrix and audio offset preserved', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wa-rotate-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const raw = path.join(dir, 'raw.mov');
  const rotated = path.join(dir, 'rotated.mov');
  const output = path.join(dir, 'out.mp4');
  await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=160x96:rate=30',
    '-itsoffset', '0.18', '-f', 'lavfi', '-i', 'sine=frequency=500', '-t', '0.8',
    '-c:v', 'libx264', '-c:a', 'aac', raw]);
  const { stdout: help } = await run('ffmpeg', ['-hide_banner', '-h', 'full'], { maxBuffer: 2 ** 22 });
  const metadata = help.includes('-display_rotation');
  await run('ffmpeg', ['-v', 'error', ...(metadata ? ['-display_rotation', '90'] : []),
    '-i', raw, '-c', 'copy', ...(!metadata ? ['-metadata:s:v:0', 'rotate=90'] : []), rotated]);

  const { repackVideo } = await import('../src/ffmpeg.js');
  const timings = [];
  const metrics = await repackVideo(rotated, output, { statusVideo: true, onStage: stage => timings.push(stage) });
  assert.equal(metrics.videoMode, 'copy');
  assert.equal(metrics.audioMode, 'copy');
  assert.equal(metrics.output.width, 96);
  assert.equal(metrics.output.height, 160);
  assert.deepEqual(timings.map(stage => stage.stage), ['ffprobe', 'ffmpeg', 'verification']);
  async function starts(file) {
    const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'stream=start_time:stream_side_data=rotation', '-of', 'json', file]);
    const [video, audio] = JSON.parse(stdout).streams;
    return { rotation: video.side_data_list[0].rotation, offset: Number(audio.start_time) - Number(video.start_time) };
  }
  const inputTiming = await starts(rotated);
  const outputTiming = await starts(output);
  assert.equal(outputTiming.rotation, 90);
  assert.ok(Math.abs(inputTiming.offset - outputTiming.offset) < 0.01);

  await run('ffmpeg', ['-v', 'error', '-y', '-i', raw, '-c:v', 'libx265',
    '-x265-params', 'pools=none:frame-threads=1:log-level=error', '-c:a', 'copy', raw + '.mov']);
  await run('ffmpeg', ['-v', 'error', '-y', ...(metadata ? ['-display_rotation', '90'] : []),
    '-i', raw + '.mov', '-c', 'copy', ...(!metadata ? ['-metadata:s:v:0', 'rotate=90'] : []), rotated]);
  const encoded = await repackVideo(rotated, output, { statusVideo: true });
  assert.equal(encoded.videoMode, 'encode');
  assert.equal(encoded.output.width, 96);
  assert.equal(encoded.output.height, 160);
  assert.equal(encoded.output.fps, '30/1');
});

test('H.264 4:4:4 is converted and a broken remux falls back to encoding', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wa-verify-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const input = path.join(dir, 'input.mp4');
  const output = path.join(dir, 'out.mp4');
  const fixture = pixFmt => run('ffmpeg', ['-v', 'error', '-y', '-filter_threads', '1',
    '-f', 'lavfi', '-i', 'testsrc2=size=128x96:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=700',
    '-t', '0.5', '-c:v', 'libx264', '-pix_fmt', pixFmt, '-c:a', 'aac', input]);
  const { repackVideo } = await import('../src/ffmpeg.js');
  await fixture('yuv444p');
  const recoded = await repackVideo(input, output, { statusVideo: true });
  assert.equal(recoded.videoMode, 'encode');
  assert.equal(recoded.audioMode, 'copy');
  assert.equal(recoded.output.width, 128);

  await fixture('yuv420p');
  const { stdout: actualFfmpeg } = await run('sh', ['-c', 'command -v ffmpeg']);
  const pathBefore = process.env.PATH;
  t.after(() => { process.env.PATH = pathBefore; });
  process.env.PATH = `${dir}:${pathBefore}`;
  await writeFile(path.join(dir, 'ffmpeg'), `#!/bin/sh
copy=no
for argument do
  if [ "$argument" = copy ]; then copy=yes; fi
  output=$argument
done
if [ "$copy" = yes ]; then printf 'invalid MP4' > "$output"; exit 0; fi
exec "${actualFfmpeg.trim()}" "$@"
`, { mode: 0o700 });
  const timings = [];
  const repaired = await repackVideo(input, output, { statusVideo: true, onStage: fields => timings.push(fields) });
  assert.equal(repaired.videoMode, 'encode');
  assert.deepEqual(timings.filter(timing => timing.stage === 'verification').map(timing => timing.outcome), ['failed', 'ok']);
  await writeFile(path.join(dir, 'ffmpeg'), '#!/bin/sh\nfor argument do output=$argument; done\nprintf invalid > "$output"\n');
  await assert.rejects(repackVideo(input, output, { statusVideo: true }), { stage: 'verification', reason: 'output_invalid' });
});

test('512 MiB refuses UHD HEVC before encoding and keeps UHD Smart Copy with an exact upload cap', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wa-uhd-budget-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const hevc = path.join(dir, 'uhd.mov');
  const avc = path.join(dir, 'compatible.mp4');
  const fixture = ['-v', 'error', '-f', 'lavfi', '-i', 'color=size=3840x2160:rate=10',
    '-f', 'lavfi', '-i', 'sine=frequency=500', '-t', '0.2', '-threads:v', '1', '-c:a', 'aac'];
  await run('ffmpeg', [...fixture, '-c:v', 'libx265', '-preset', 'ultrafast',
    '-x265-params', 'pools=none:frame-threads=1:log-level=error', hevc]);
  await run('ffmpeg', [...fixture, '-c:v', 'libx264', '-preset', 'ultrafast', avc]);

  const mib = 1024 ** 2;
  const readMemory = () => ({ cgroupLimitBytes: 512 * mib, cgroupBytes: 128 * mib, rssBytes: 80 * mib });
  const { repackVideo } = await import('../src/ffmpeg.js');
  const output = path.join(dir, 'copy.mp4');
  const metrics = await repackVideo(avc, output, { statusVideo: true, readMemory });
  assert.equal(metrics.videoMode, 'copy');
  assert.equal(metrics.output.width, 3840);
  assert.equal(metrics.output.height, 2160);

  const sent = [];
  const errors = [];
  const stages = [];
  const sock = { sendMessage: async (_, message) => { sent.push(message); } };
  const create = maxOutputBytes => createMessageHandler({
    tempRoot: dir, maxOutputBytes, readMemory,
    log: { info: fields => { if (fields.stage) stages.push(fields.stage); }, error: fields => errors.push(fields) },
    async downloadMediaMessage(msg) {
      return Readable.from([await readFile(msg.key.id === 'uhd-hevc' ? hevc : avc)]);
    }
  });
  const send = (handler, id) => handler(sock, videoEvent(id));
  await send(create(metrics.output.bytes), 'uhd-hevc');
  assert.equal(errors.at(-1).reason, 'video_memory_budget');
  assert.match(sent.at(-1).text, /1080p/);
  assert.equal(stages.includes('ffmpeg'), false);
  await send(create(metrics.output.bytes), 'exact-cap');
  assert.equal(sent.filter(message => message.video).length, 1);
  await send(create(metrics.output.bytes - 1), 'over-cap');
  assert.equal(sent.filter(message => message.video).length, 1);
  assert.equal(errors.at(-1).reason, 'output_limit');
  assert.equal(errors.at(-1).outputBytes, metrics.output.bytes);
  assert.deepEqual((await readdir(dir)).sort(), ['compatible.mp4', 'copy.mp4', 'uhd.mov']);

  // A failed UHD remux must not fall through to a memory-unsafe video encode.
  const previousPath = process.env.PATH;
  t.after(() => { process.env.PATH = previousPath; });
  await writeFile(path.join(dir, 'ffmpeg'), '#!/bin/sh\nfor argument do output=$argument; done\nprintf invalid > "$output"\n',
    { mode: 0o700 });
  process.env.PATH = `${dir}:${previousPath}`;
  const attempts = [];
  await assert.rejects(repackVideo(avc, output, {
    statusVideo: true, readMemory, onStage: fields => attempts.push(fields.stage)
  }), { reason: 'video_memory_budget' });
  assert.deepEqual(attempts, ['ffprobe', 'ffmpeg', 'verification']);
});

test('command send failures are diagnosed without logging the message or recipient', async () => {
  const warnings = [];
  const handler = createMessageHandler({ log: { warn: fields => warnings.push(fields), error() {} } });
  await handler({ async sendMessage() {
    throw Object.assign(new Error('private transport payload'), { output: { statusCode: 408 } });
  } }, { type: 'notify', messages: [{
    key: { remoteJid: 'fixture@s.whatsapp.net', id: 'ping-test' }, message: { conversation: '.ping' }
  }] });
  assert.match(warnings[0].trace, /^[a-f0-9]{16}$/);
  assert.deepEqual(warnings.map(({ trace, ...fields }) => fields), [{ stage: 'command_reply', reason: 'timeout', statusCode: 408 }]);
  await handler.stop();
});

test('Baileys v7 keeps a wrapped command on its native LID route and distinguishes send from ACK', async () => {
  const entries = [];
  const replies = [];
  const handler = createMessageHandler({ log: { info: fields => entries.push(fields), error() {} } });
  const sock = {
    ev: new EventEmitter(), ws: new EventEmitter(), authState: { creds: { me: { id: '999@s.whatsapp.net' } } },
    async sendMessage(jid, payload, { messageId }) {
      replies.push({ jid, payload });
      this.ws.emit('CB:ack,class:message', { attrs: { id: messageId } });
      this.ev.emit('messages.update', [{ key: { fromMe: true, id: messageId },
        update: { status: proto.WebMessageInfo.Status.DELIVERY_ACK } }]);
    }
  };
  const wrapped = proto.Message.decode(proto.Message.encode({
    ephemeralMessage: { message: { ephemeralMessage: { message: { extendedTextMessage: { text: '.ping' } } } } }
  }).finish());
  const deliver = async (id, attrs = {}, overrides = {}) => {
    const { fullMessage } = decodeMessageNode({
      tag: 'message', attrs: { from: '111@lid', t: '12', id, ...attrs }
    }, '999@s.whatsapp.net', '222@lid');
    await handler(sock, { type: 'notify', messages: [{ ...fullMessage, message: wrapped,
      key: { ...fullMessage.key, ...overrides } }] });
  };
  await deliver('native-lid', { sender_pn: '333@s.whatsapp.net' });
  assert.deepEqual(replies, [{ jid: '111@lid', payload: { text: '🏓 Pong!' } }]);
  assert.deepEqual(entries.map(entry => entry.stage), ['received', 'handler_invoked', 'reply_prepared', 'sending',
    'server_acknowledged', 'delivery_receipt', 'send_resolved']);
  assert.equal(new Set(entries.map(entry => entry.trace)).size, 1);
  assert.doesNotMatch(JSON.stringify(entries), /@|ping|Pong/);

  await deliver('own', { sender_pn: '333@s.whatsapp.net' }, { fromMe: true });
  assert.equal(replies.length, 1);
  assert.equal(entries.at(-1).reason, 'own_message');
  sock.authState.creds.me.lid = '222@lid';
  await deliver('normal-lid');
  assert.equal(replies.at(-1).jid, '111@lid');
  await handler.stop();
  assert.equal(sock.ws.listenerCount('CB:ack,class:message'), 0);
  assert.equal(sock.ev.listenerCount('messages.update'), 0);
});

test('v7 sender aliases preserve a registered PN account while replies stay on the LID route', async () => {
  const lookup = [];
  const sends = [];
  const accounts = { async get(jid) {
    lookup.push(jid);
    return jid === '333@s.whatsapp.net'
      ? { name: 'Fixture', registeredAt: '2026-01-01T00:00:00Z', videos: 2, images: 1 } : {};
  } };
  const handler = createMessageHandler({ accounts, log: { error() {} } });
  const { fullMessage } = decodeMessageNode({ tag: 'message', attrs: {
    from: '111@lid', sender_pn: '333@s.whatsapp.net', id: 'fixture', t: '12'
  } }, '444@s.whatsapp.net', '555@lid');
  await handler({ async sendMessage(jid, payload) { sends.push({ jid, payload }); } }, {
    type: 'notify', messages: [{ ...fullMessage, message: { conversation: '.status' } }]
  });
  assert.ok(lookup.includes('333@s.whatsapp.net'));
  assert.equal(sends[0].jid, '111@lid');
  assert.match(sends[0].payload.text, /Fixture/);
  await handler.stop();
});

test('v7 download deadline closes a real pending media request before headers arrive', async t => {
  const server = createServer(() => {});
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const errors = [];
  const handler = createMessageHandler({
    log: { error: fields => errors.push(fields) }, downloadTimeoutMs: 100,
    downloadMediaMessage: (_msg, _type, { options }) =>
      getHttpStream(`http://127.0.0.1:${server.address().port}`, options)
  });
  await handler({ async sendMessage() {} }, videoEvent('v7-http-deadline'));
  assert.equal(errors[0].stage, 'download');
  assert.equal(errors[0].reason, 'timeout');
  await handler.stop();
});

test('a repeated media stanza using Baileys PN and LID aliases starts one job', async () => {
  let downloads = 0;
  const lid = '123456@lid';
  const pn = '15550000111@s.whatsapp.net';
  const handler = createMessageHandler({
    log: { info() {}, error() {} },
    async downloadMediaMessage() {
      downloads++;
      return Readable.from([Buffer.from('invalid fixture video')]);
    }
  });
  const sock = { async sendMessage() {} };
  const delivery = (remoteJid, remoteJidAlt) => ({
    type: 'notify',
    messages: [{ key: { id: 'duplicate-stanza', remoteJid, remoteJidAlt }, message: { videoMessage: {} } }]
  });
  await Promise.all([handler(sock, delivery(pn, lid)), handler(sock, delivery(lid, pn))]);
  assert.equal(downloads, 1);
  assert.equal(handler.snapshot().activeJobs, 0);
  assert.equal(handler.snapshot().queuedJobs, 0);
  await handler.stop();
});

test('.linkstudio explicitly reports an unavailable bridge and still follows the delivery guard', async () => {
  const replies = [];
  const guard = { blocked: false };
  const onMessages = createMessageHandler({ log: { info() {}, error() {} }, deliveryGuard: guard });
  const socket = { async sendMessage(jid, message) { replies.push({ jid, ...message }); } };
  const event = id => ({ type: 'notify', messages: [{ key: { id, remoteJid: '123456@lid' },
    message: { conversation: '.linkstudio example-code' } }] });
  await onMessages(socket, event('link-disabled'));
  assert.equal(replies.length, 1);
  assert.match(replies[0].text, /Web Studio tidak tersedia/);
  assert.doesNotMatch(replies[0].text, /example-code/);
  guard.blocked = true;
  await onMessages(socket, event('restricted'));
  assert.equal(replies.length, 1);
  await onMessages.stop();
});
