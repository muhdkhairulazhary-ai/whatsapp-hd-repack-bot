import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { promisify } from 'node:util';
import { generateWAMessageContent, proto } from '@whiskeysockets/baileys';
import { createFfmpegProgressReader } from '../src/ffmpeg-progress.js';
import { createEncodingProgress, createVideoProgress } from '../src/video-progress.js';
import { createMessageHandler } from '../src/baileys-media.js';

const run = promisify(execFile);
const flush = () => new Promise(resolve => setImmediate(resolve));
const ownKey = { remoteJid: '10000000001@s.whatsapp.net', fromMe: true, id: 'progress-key' };

test('reads actual FFmpeg progress time units and handles split, invalid and legacy fields', async () => {
  const { stdout } = await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=s=32x32:r=10',
    '-t', '1', '-progress', 'pipe:1', '-f', 'null', '-']);
  const last = key => [...stdout.matchAll(new RegExp(`^${key}=(\\d+)$`, 'gm'))].at(-1)?.[1];
  const microseconds = Number(last('out_time_us'));
  assert.ok(microseconds >= 900_000 && microseconds <= 1_000_000);
  assert.equal(Number(last('out_time_ms')), microseconds);
  const real = createFfmpegProgressReader();
  real.feed(stdout);
  assert.equal(real.snapshot().outputTimeMs, microseconds / 1000);
  assert.equal(real.snapshot().progress, 'end');

  const sample = createFfmpegProgressReader();
  sample.feed('out_time_ms=12');
  sample.feed('34567\nspeed= 0.5x\nprogress=continue\n');
  assert.equal(sample.snapshot().outputTimeMs, 1234.567);
  assert.equal(sample.snapshot().speed, 0.5);
  sample.feed('out_time_us=3000000\nout_time_ms=2000000\n');
  assert.equal(sample.snapshot().outputTimeMs, 3000);
  sample.feed('out_time_us=N/A\nout_time_ms=-1\nout_time=00:00:04.123456\n');
  assert.equal(sample.snapshot().outputTimeMs, 4123.456);
  sample.feed('out_time=' + 'a'.repeat(4000) + '\nout_time=invalid\nspeed=N/A\n');
  assert.equal(sample.snapshot().outputTimeMs, undefined);
  assert.equal(sample.snapshot().speed, undefined);
});

test('clamps encoding progress, handles invalid duration, and only estimates from repeated advancing samples', () => {
  for (const invalid of [undefined, 0, -1, NaN, Infinity]) {
    assert.deepEqual(createEncodingProgress(invalid)({ outputTimeMs: 1000, elapsedMs: 2000 }), {});
  }
  const compute = createEncodingProgress(10);
  assert.deepEqual(compute({ outputTimeMs: 1000, elapsedMs: 3000, speed: 0.5 }), { percent: 10, etaSeconds: undefined });
  const next = compute({ outputTimeMs: 3000, elapsedMs: 7000, speed: 0.5 });
  assert.equal(next.percent, 30);
  assert.equal(next.etaSeconds, 14);
  assert.deepEqual(compute({ outputTimeMs: 2500, elapsedMs: 8000 }), { percent: 30, etaSeconds: undefined });
  assert.equal(compute({ outputTimeMs: 12_000, elapsedMs: 25_000 }).percent, 99);
});

function clock() {
  let now = 0;
  const timers = new Map();
  return {
    options: {
      now: () => now,
      schedule(fn, ms) {
        const timer = Symbol();
        timers.set(timer, { fn, at: now + ms });
        return timer;
      },
      cancel: timer => timers.delete(timer)
    },
    timers,
    async advance(ms) {
      now += ms;
      for (const [timer, { fn, at }] of timers) {
        if (now < at) continue;
        timers.delete(timer);
        fn();
      }
      await flush();
    }
  };
}

test('one message observes throttle, resets on size retry and displays 100 only on delivery', async () => {
  const time = clock();
  const sent = [];
  let closed = 0;
  const progress = createVideoProgress({
    ...time.options, initialStage: 'queued', title: 'Shelby+ HD Bot',
    async send(content) { sent.push(content); return { key: ownKey }; },
    onClose: () => closed++, onFailedEdit: () => assert.fail('unexpected failure')
  });
  await flush();
  progress.startAttempt({ videoMode: 'encode', durationSeconds: 10, attempt: 1 });
  progress.sample({ outputTimeMs: 6800, elapsedMs: 15_000 });
  await time.advance(11_999);
  assert.equal(sent.length, 1);
  await time.advance(1);
  assert.equal(sent.length, 2);
  assert.equal(sent[1].edit, ownKey);
  assert.match(sent[1].text, /68%/);
  progress.sample({ outputTimeMs: 6800, elapsedMs: 16_000 });
  await time.advance(12_000);
  assert.equal(sent.length, 2);
  progress.update('validating');
  progress.startAttempt({ videoMode: 'encode', durationSeconds: 10, attempt: 2 });
  progress.sample({ outputTimeMs: 1000, elapsedMs: 1000 });
  await time.advance(12_000);
  assert.match(sent.at(-1).text, /Percubaan semula/);
  assert.match(sent.at(-1).text, /10%/);
  progress.sample({ outputTimeMs: 15_000, elapsedMs: 20_000 });
  progress.update('sending');
  await time.advance(12_000);
  assert.equal(sent.some(content => /100%/.test(content.text)), false);
  progress.finish('completed');
  progress.finish('completed');
  await time.advance(12_000);
  assert.equal(sent.filter(content => /100%/.test(content.text)).length, 1);
  assert.equal(closed, 1);
  assert.equal(time.timers.size, 0);
});

test('failed edit disables updates and a failure has at most one standalone error', async () => {
  const time = clock();
  const errors = [];
  const sent = [];
  const progress = createVideoProgress({
    ...time.options, title: 'Shelby+', initialStage: 'queued', onClose() {}, onFailedEdit: detail => errors.push(detail),
    async send(content) {
      sent.push(content);
      if (content.edit) throw new Error('unavailable');
      return { key: ownKey };
    }
  });
  await flush();
  progress.update('downloading');
  await time.advance(12_000);
  progress.update('validating');
  progress.finish('failed', 'Cuba lagi.');
  progress.finish('failed', 'Cuba lagi.');
  await time.advance(30_000);
  assert.equal(sent.length, 2);
  assert.deepEqual(errors, ['Cuba lagi.']);
  assert.equal(time.timers.size, 0);
});

test('closing cancels scheduled edits and ignores an in-flight response', async () => {
  const time = clock();
  let resolveSend;
  const sent = [];
  const progress = createVideoProgress({
    ...time.options, title: 'Shelby+', initialStage: 'queued', onClose() {}, onFailedEdit: () => assert.fail(),
    send(content) { sent.push(content); return new Promise(resolve => { resolveSend = resolve; }); }
  });
  await flush();
  progress.update('downloading', 30);
  progress.close();
  resolveSend({ key: ownKey });
  progress.finish('completed');
  await time.advance(20_000);
  assert.equal(sent.length, 1);
  assert.equal(time.timers.size, 0);
});

test('installed Baileys serializes a progress edit as MESSAGE_EDIT', async () => {
  const content = await generateWAMessageContent({ text: 'Progress', edit: ownKey }, {});
  assert.equal(content.protocolMessage.type, proto.Message.ProtocolMessage.Type.MESSAGE_EDIT);
  assert.equal(content.protocolMessage.key.id, ownKey.id);
  assert.equal(content.protocolMessage.editedMessage.conversation || content.protocolMessage.editedMessage.extendedTextMessage?.text, 'Progress');
});

test('queued videos keep separate edit keys; Smart Copy completes only after upload resolves', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wa-progress-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fixture = path.join(directory, 'fixture.mp4');
  await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=s=32x32:r=10',
    '-f', 'lavfi', '-i', 'sine=frequency=500', '-t', '0.5', '-c:v', 'libx264', '-c:a', 'aac', fixture]);
  const bytes = await readFile(fixture);
  const time = clock();
  const seen = [];
  let openUpload;
  let atUpload;
  const arrived = new Promise(resolve => { atUpload = resolve; });
  const release = new Promise(resolve => { openUpload = resolve; });
  const first = '10000000001@s.whatsapp.net';
  const second = '10000000002@s.whatsapp.net';
  const handler = createMessageHandler({
    tempRoot: directory, progressOptions: time.options, log: { error() {} },
    downloadMediaMessage: async () => Readable.from([bytes])
  });
  t.after(() => handler.stop());
  const sock = { async sendMessage(jid, content) {
    seen.push({ jid, content });
    if (content.video && jid === first) {
      atUpload();
      await release;
    }
    if (content.video && jid === second) throw new Error('delivery unavailable');
    return { key: { remoteJid: jid, fromMe: true, id: jid === first ? 'first' : 'second' } };
  } };
  const submit = (id, jid) => handler(sock, { type: 'notify', messages: [{
    key: { id, remoteJid: jid }, message: { videoMessage: { fileLength: bytes.length } }
  }] });
  const active = submit('1', first);
  const queued = submit('2', second);
  await arrived;
  await time.advance(12_000);
  assert.ok(seen.some(({ jid, content }) => jid === second && /Menunggu giliran/.test(content.text || '')));
  assert.ok(seen.some(({ jid, content }) => jid === first && content.edit?.id === 'first' && /Menghantar/.test(content.text)));
  assert.ok(!seen.some(({ content }) => /100%/.test(content.text || '')));
  openUpload();
  await Promise.all([active, queued]);
  await time.advance(12_000);
  assert.ok(seen.some(({ jid, content }) => jid === first && content.edit?.id === 'first' && /100%/.test(content.text)));
  assert.ok(seen.some(({ jid, content }) => jid === second && content.edit?.id === 'second' && /gagal/i.test(content.text)));
  assert.ok(!seen.some(({ jid, content }) => jid === second && /100%/.test(content.text || '')));
  assert.equal(seen.filter(({ content }) => content.text && !content.edit).length, 2);
  assert.equal(time.timers.size, 0);
});

test('SIGTERM cleanup cancels active and queued progress timers', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wa-progress-stop-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const time = clock();
  const messages = [];
  let start;
  const started = new Promise(resolve => { start = resolve; });
  const handler = createMessageHandler({
    tempRoot: directory, progressOptions: time.options, log: { error() {} },
    downloadMediaMessage: async () => { start(); return new Readable({ read() {} }); }
  });
  const sock = { async sendMessage(jid, content) { messages.push(content); return { key: ownKey }; } };
  const submit = id => handler(sock, { type: 'notify', messages: [{
    key: { id, remoteJid: ownKey.remoteJid }, message: { videoMessage: {} }
  }] });
  const active = submit('1');
  const queued = submit('2');
  await started;
  await flush();
  await handler.stop();
  await Promise.all([active, queued]);
  await time.advance(30_000);
  assert.equal(messages.length, 2);
  assert.ok(messages.every(content => !content.edit && !content.video));
  assert.equal(time.timers.size, 0);
});
