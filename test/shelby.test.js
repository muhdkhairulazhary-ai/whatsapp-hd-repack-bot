import { execFile } from 'node:child_process';
import assert from 'node:assert/strict';
import { copyFile, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { promisify } from 'node:util';
import { createMessageHandler } from '../src/baileys-media.js';
import { createAccountStore } from '../src/shelby-accounts.js';
import { commandReply } from '../src/shelby-commands.js';

const run = promisify(execFile);
const jid = '1234567890@s.whatsapp.net';
const logger = { info() {}, error() {} };

async function temporary(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'shelby-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function event(id, message, key = {}) {
  return { type: 'notify', messages: [{ key: { id, remoteJid: jid, ...key }, message }] };
}

test('registration is free, sanitized, idempotent and persistent with actual account counts', async t => {
  const directory = await temporary(t);
  const accounts = createAccountStore(directory);
  assert.match(await commandReply('.status', jid, accounts), /belum berdaftar/);
  assert.match(await commandReply('.daftar Nama*\nRahsia', jid, accounts), /Nama tidak sah/);
  const results = await Promise.all([
    commandReply('.daftar Ａzhary', jid, accounts),
    commandReply('.daftar Pengganti', jid, accounts)
  ]);
  assert.equal(results.filter(result => result.includes('Pendaftaran berjaya')).length, 1);
  assert.equal(results.filter(result => result.includes('sudah aktif')).length, 1);
  const record = await accounts.get(jid);
  assert.equal(record.name, 'Azhary');
  assert.ok(Math.abs(Date.now() - Date.parse(record.registeredAt)) < 60_000);
  for (let i = 0; i < 35; i++) await accounts.record(jid, 'video');
  await Promise.all([accounts.record(jid, 'image'), accounts.record(jid, 'image')]);
  const reopened = createAccountStore(directory);
  const status = await commandReply('.status', jid, reopened);
  assert.match(status, /Azhary/);
  assert.match(status, /Video diproses: 35/);
  assert.match(status, /Gambar diproses: 2/);
  assert.match(status, /Unlimited Free/);
  assert.match(await commandReply('.menu', jid, reopened), /SHELBY\+ \| MAIN MENU[\s\S]*HD VIDEO[\s\S]*HD IMAGE/);
  assert.match(await commandReply('.help', jid, reopened), /150 MB dan 60 saat[\s\S]*tanpa kapsyen/);
  const custom = { name: 'Uji', fullName: 'Uji HD', tagline: 'Tagline ujian', prefix: '!' };
  assert.match(await commandReply('!menu', jid, reopened, custom), /UJI \| MAIN MENU[\s\S]*!daftar/);
  const [file] = await readdir(directory);
  assert.equal((await stat(path.join(directory, file))).mode & 0o777, 0o600);
  assert.doesNotMatch(await readFile(path.join(directory, file), 'utf8'), /1234567890|credit/i);
});

test('JPEG orientation, PNG transparency and HEIC decoding preserve size and return caption-free images', async t => {
  const directory = await temporary(t);
  const jpeg = path.join(directory, 'jpeg.jpg');
  const png = path.join(directory, 'png.png');
  const output = path.join(directory, 'reply');
  await run('convert', ['-size', '37x23', 'xc:red', jpeg]);
  await run('convert', ['-size', '34x21', 'xc:none', '-fill', 'red', '-draw', 'rectangle 1,1 9,9', png]);
  const original = await readFile(jpeg);
  // EXIF IFD0 orientation 6 (rotate 90 degrees clockwise).
  const exif = Buffer.from('ffe1002245786966000049492a0008000000010012010300010000000600000000000000', 'hex');
  const imageData = {
    jpeg: Buffer.concat([original.subarray(0, 2), exif, original.subarray(2)]),
    png: await readFile(png),
    heic: await readFile(new URL('./fixtures/shelby-sample.heic', import.meta.url)),
    corrupted: Buffer.from([255, 216, 255, 224, 0, 255])
  };
  const accounts = createAccountStore(path.join(directory, 'accounts'));
  const errors = [];
  const sent = [];
  const handler = createMessageHandler({
    accounts, tempRoot: directory,
    log: { info() {}, error: fields => errors.push(fields) },
    async downloadMediaMessage(msg) { return Readable.from([imageData[msg.key.id]]); }
  });
  const sock = { async sendMessage(target, message) {
    sent.push(message);
    if (message.image) await copyFile(message.image.url, output);
  } };

  await handler(sock, event('jpeg', { imageMessage: { caption: 'private source caption' } }));
  let metadata = await run('identify', ['-format', '%m %w %h %[orientation]', output]);
  assert.match(metadata.stdout, /^JPEG 23 37 (Undefined|TopLeft)$/);

  await handler(sock, event('png', { documentMessage: { mimetype: 'image/png', caption: 'original' } }));
  metadata = await run('identify', ['-format', '%m %w %h %[channels]', output]);
  assert.match(metadata.stdout, /^PNG 34 21 .*a/i);

  await handler(sock, event('heic', { documentMessage: { mimetype: 'application/octet-stream' } }));
  metadata = await run('identify', ['-format', '%m %w %h', output]);
  assert.equal(metadata.stdout, 'JPEG 24 16');

  await handler(sock, event('corrupted', { imageMessage: {} }));
  assert.equal(errors.at(-1).stage, 'image');
  assert.match(sent.at(-1).text, /Gambar gagal diproses/);
  const media = sent.filter(message => message.image);
  assert.equal(media.length, 3);
  assert.ok(media.every(message => !Object.hasOwn(message, 'caption')));
  assert.equal((await accounts.get(jid)).images, 3);
  assert.deepEqual((await readdir(directory)).sort(), ['accounts', 'jpeg.jpg', 'png.png', 'reply']);
});

test('bounded queue processes one job at a time, ignores duplicates and its own messages', async t => {
  const directory = await temporary(t);
  const png = path.join(directory, 'test.png');
  await run('convert', ['-size', '20x20', 'xc:blue', png]);
  const bytes = await readFile(png);
  const calls = [];
  const texts = [];
  let releaseFirst;
  let startFirst;
  const firstStarted = new Promise(resolve => { startFirst = resolve; });
  const firstGate = new Promise(resolve => { releaseFirst = resolve; });
  const handler = createMessageHandler({
    queueCapacity: 1, concurrency: 1, tempRoot: directory, log: logger,
    async downloadMediaMessage(msg) {
      calls.push(msg.key.id);
      if (msg.key.id === 'first') {
        startFirst();
        await firstGate;
      }
      return Readable.from([bytes]);
    }
  });
  const sock = { async sendMessage(target, message) { if (message.text) texts.push(message.text); } };
  const send = id => handler(sock, event(id, { imageMessage: {} }));
  const first = send('first');
  await firstStarted;
  const second = send('second');
  await send('second');
  await send('overflow');
  await handler(sock, event('own', { imageMessage: {} }, { fromMe: true }));
  assert.deepEqual(calls, ['first']);
  assert.ok(texts.some(text => /dalam barisan/.test(text)));
  assert.ok(texts.some(text => /barisan pemprosesan penuh/i.test(text)));
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(calls, ['first', 'second']);
  assert.deepEqual(await readdir(directory), ['test.png']);
  await handler.stop();
});

test('a stalled job times out and a queued job gets its own full deadline', async t => {
  const directory = await temporary(t);
  const png = path.join(directory, 'queue-fixture.png');
  await run('convert', ['-size', '12x12', 'xc:red', png]);
  const bytes = await readFile(png);
  const errors = [];
  let downloading;
  const downloadStarted = new Promise(resolve => { downloading = resolve; });
  const handler = createMessageHandler({
    jobTimeoutMs: 1000, tempRoot: directory,
    log: { error: fields => errors.push(fields) },
    async downloadMediaMessage(msg) {
      if (msg.key.id === 'stalled') {
        downloading();
        return new Readable({ read() {} });
      }
      return Readable.from([bytes]);
    }
  });
  const sent = [];
  const sock = { sendMessage: async (_, message) => { sent.push(message); } };
  const stalled = handler(sock, event('stalled', { imageMessage: {} }));
  await downloadStarted;
  const queued = handler(sock, event('queued', { imageMessage: {} }));
  await Promise.all([stalled, queued]);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].stage, 'download');
  assert.equal(errors[0].reason, 'timeout');
  assert.equal(sent.filter(message => message.image).length, 1);
  assert.deepEqual(await readdir(directory), ['queue-fixture.png']);
  await handler.stop();
});

test('Baileys credentials survive storage reload and network reconnect without relinking', async t => {
  const { EventEmitter } = await import('node:events');
  const { DisconnectReason, useMultiFileAuthState } = await import('@whiskeysockets/baileys');
  const { createConnectionManager } = await import('../src/baileys-connection.js');
  const directory = await temporary(t);
  const previous = await useMultiFileAuthState(directory);
  previous.state.creds.account = { details: Buffer.from([1, 2, 3]) };
  previous.state.creds.me = { id: jid, name: 'Fixture' };
  await previous.saveCreds();
  await previous.state.keys.set({ 'pre-key': { '1': { private: Buffer.from([4, 5, 6]) } } });

  const sockets = [];
  let retry;
  const manager = createConnectionManager({
    phone: '', reasons: DisconnectReason, log: logger,
    async loadAuth() {
      const auth = await useMultiFileAuthState(directory);
      const records = await auth.state.keys.get('pre-key', ['1']);
      assert.deepEqual(records['1'].private, Buffer.from([4, 5, 6]));
      return auth;
    },
    requestPairingCode() { assert.fail('Saved credentials must not request pairing'); },
    makeSocket(state) {
      assert.deepEqual(state.creds.account.details, Buffer.from([1, 2, 3]));
      assert.equal(state.creds.me.id, jid);
      const sock = { ev: new EventEmitter(), ws: new EventEmitter(), end() {} };
      sockets.push(sock);
      return sock;
    },
    schedule(fn, delay) {
      if (delay === 1000) retry = fn;
      return fn;
    },
    cancel() {}
  });
  await manager.start();
  sockets[0].ev.emit('connection.update', { connection: 'open' });
  assert.equal(manager.connected, true);
  sockets[0].ev.emit('connection.update', {
    connection: 'close', lastDisconnect: { error: { output: { statusCode: 428 } } }
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(manager.connected, false);
  retry();
  // Wait until the actual disk-backed auth loader has created the new socket.
  for (let i = 0; i < 40 && sockets.length < 2; i++) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(sockets.length, 2);
  sockets[1].ev.emit('connection.update', { connection: 'open' });
  assert.equal(manager.connected, true);
  sockets[1].ev.emit('connection.update', {
    connection: 'close', lastDisconnect: { error: { output: { statusCode: 401 } } }
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(manager.requestPairing().reason, 'logged_out');
  assert.equal((await useMultiFileAuthState(directory)).state.creds.me.id, jid);
  await manager.stop();
});

test('service shutdown logs SIGTERM and cancels a live job without claiming OOM', async t => {
  const { createShutdown } = await import('../src/runtime-diagnostics.js');
  const directory = await temporary(t);
  const records = [];
  const listener = fields => records.push(fields);
  let begin;
  const started = new Promise(resolve => { begin = resolve; });
  const media = createMessageHandler({
    tempRoot: directory,
    log: { info: listener, error: listener },
    async downloadMediaMessage() { begin(); return new Readable({ read() {} }); }
  });
  const job = media({ sendMessage: async () => {} }, event('shutdown-private', { videoMessage: {} }));
  await started;
  let serverClosed = 0;
  let connectionStopped = 0;
  const stop = createShutdown({
    server: { close() { serverClosed++; } },
    connection: { async stop() { connectionStopped++; } },
    media, log: { info: listener },
    snapshot: () => ({ rssBytes: 100, oomKills: 2 })
  });
  const stopping = stop('SIGTERM');
  assert.equal(stop('SIGINT'), stopping);
  await Promise.all([job, stopping]);
  assert.equal(serverClosed, 1);
  assert.equal(connectionStopped, 1);
  assert.equal(records.find(record => record.signal)?.activeJobs, 1);
  assert.equal(records.at(-1).signal, 'SIGTERM');
  assert.equal(records.at(-1).oomKillCounterChanged, false);
  assert.ok(records.some(record => record.reason === 'shutdown'));
  assert.ok(records.some(record => record.stage === 'download' && record.outcome === 'failed'));
  assert.doesNotMatch(JSON.stringify(records), /shutdown-private/);
  assert.deepEqual(await readdir(directory), []);
});
