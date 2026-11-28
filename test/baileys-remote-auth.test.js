import assert from 'node:assert/strict';
import { execFile, spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { useMultiFileAuthState, proto, addTransactionCapability, jidNormalizedUser } from '@whiskeysockets/baileys';
import { createRemoteAuthLoader, openRemoteAuth } from '../src/baileys-remote-auth.js';
import { createConnectionManager } from '../src/baileys-connection.js';

const exec = promisify(execFile);
const hasRedis = ['redis-server', 'redis-cli'].every(tool => spawnSync(tool, ['--version']).status === 0);
const jid = '18005550000@s.whatsapp.net';
const options = { session: 'test', key: randomBytes(32) };

async function redis(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wa-redis-'));
  const socket = path.join(root, 'redis.sock');
  const child = spawn('redis-server', ['--port', '0', '--unixsocket', socket, '--save', '', '--appendonly', 'no'],
    { stdio: ['ignore', 'ignore', 'ignore'] });
  const closed = once(child, 'close');
  t.after(async () => {
    child.kill();
    await closed;
    await rm(root, { recursive: true, force: true });
  });
  async function command(args) {
    const { stdout } = await exec('redis-cli', ['--json', '-s', socket, ...args.map(String)]);
    return JSON.parse(stdout);
  }
  for (let attempts = 0; attempts < 40; attempts++) {
    try {
      if (await command(['PING']) === 'PONG') return { command, root };
    } catch {
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
  throw new Error('Local test Redis did not start');
}

function link(creds) {
  creds.me = { id: jid };
  creds.account = { details: Buffer.from('synthetic-account') };
}

test('Redis restores credentials and Signal keys, encrypts all values, and fences competing writers', { skip: !hasRedis }, async t => {
  const { command } = await redis(t);
  const env = {
    BAILEYS_AUTH_REDIS_URL: ' https://redis.example.test/// ',
    BAILEYS_AUTH_REDIS_TOKEN: 'synthetic-token',
    BAILEYS_AUTH_ENCRYPTION_KEY: options.key.toString('base64'),
    BAILEYS_AUTH_SESSION_ID: options.session
  };
  const loadAuth = createRemoteAuthLoader({ env, fetchImpl: async (url, init) => {
    assert.equal(url, 'https://redis.example.test/');
    assert.equal(init.headers.authorization, 'Bearer synthetic-token');
    assert.equal(init.redirect, 'error');
    return Response.json({ result: await command(JSON.parse(init.body)) });
  } });
  const first = await loadAuth();
  await first.state.keys.set({ session: { [jid]: Buffer.from('synthetic-session') } });
  assert.equal(await command(['HLEN', 'shelby:auth:{test}:state']), 0);
  await assert.rejects(loadAuth(), { authReason: 'auth_storage_busy' });
  link(first.state.creds);
  first.state.creds.pairingCode = 'TESTCODE';
  await first.saveCreds();
  await first.state.keys.set({ 'app-state-sync-key': { a: { keyData: Buffer.from([1, 2]) } } });
  const stored = JSON.stringify(await command(['HGETALL', 'shelby:auth:{test}:state']));
  assert.doesNotMatch(stored, /synthetic|18005550000|TESTCODE|app-state-sync-key/);
  await first.release();

  await assert.rejects(openRemoteAuth({ command, ...options, key: randomBytes(32) }), { authReason: 'auth_data_invalid' });
  const second = await loadAuth();
  assert.equal(second.state.creds.me.id, jid);
  assert.equal(second.state.creds.pairingCode, undefined);
  assert.deepEqual((await second.state.keys.get('session', [jid]))[jid], Buffer.from('synthetic-session'));
  const sync = (await second.state.keys.get('app-state-sync-key', ['a'])).a;
  assert.ok(sync instanceof proto.Message.AppStateSyncKeyData);
  await second.state.keys.set({ session: { [jid]: null } });
  await command(['DEL', 'shelby:auth:{test}:lease']);
  const takeover = await loadAuth();
  await assert.rejects(second.state.keys.set({ session: { [jid]: Buffer.from('stale') } }), { authReason: 'auth_lease_lost' });
  await second.release();
  assert.equal((await takeover.state.keys.get('session', [jid]))[jid], undefined);
  await takeover.release();
});

test('valid local auth migrates atomically and interrupted writes recover without partial state', { skip: !hasRedis }, async t => {
  const { root, command } = await redis(t);
  const local = await useMultiFileAuthState(root);
  link(local.state.creds);
  await local.saveCreds();
  await local.state.keys.set({ session: { [jid + ':1']: Buffer.from('existing-session') } });
  const original = await readFile(path.join(root, 'creds.json'));
  await writeFile(path.join(root, 'session-malformed.json'), '{');
  await assert.rejects(openRemoteAuth({ command, ...options, authDir: root, migrate: true }), { authReason: 'auth_migration_failed' });
  assert.equal(await command(['HLEN', 'shelby:auth:{test}:state']), 0);
  await rm(path.join(root, 'session-malformed.json'));
  const first = await openRemoteAuth({ command, ...options, authDir: root, migrate: true });
  assert.deepEqual((await first.state.keys.get('session', [jid + ':1']))[jid + ':1'], Buffer.from('existing-session'));
  assert.deepEqual(await readFile(path.join(root, 'creds.json')), original);
  await first.release();

  for (const committed of [false, true]) {
    const broken = await openRemoteAuth({
      ...options, async command(args) {
        if (args[0] !== 'EVAL' || args[2] !== 2) return command(args);
        if (committed) await command(args);
        throw new Error('synthetic transport interruption');
      }
    });
    const failures = [];
    broken.onFailure(reason => failures.push(reason));
    broken.state.creds.counter = committed ? 2 : 1;
    await assert.rejects(broken.state.keys.set({ 'pre-key': { '1': Buffer.from('a'), '2': Buffer.from('b') } }));
    assert.deepEqual(failures, ['auth_storage_unavailable']);
    await broken.release();

    const restored = await openRemoteAuth({ command, ...options });
    assert.equal(restored.state.creds.me.id, jid);
    assert.equal(restored.state.creds.counter, committed ? 2 : undefined);
    const records = await restored.state.keys.get('pre-key', ['1', '2']);
    assert.deepEqual(Object.keys(records), committed ? ['1', '2'] : []);
    await restored.release();
  }
});

test('connection backs off while storage is unavailable and resumes without requesting a code', async () => {
  const { EventEmitter } = await import('node:events');
  let attempt = 0;
  let retry;
  let socket;
  let releases = 0;
  const manager = createConnectionManager({
    phone: '18005550000', reasons: { loggedOut: 401 }, log: { info() {}, error() {} },
    async loadAuth() {
      if (++attempt === 1) throw Object.assign(new Error(), { authReason: 'auth_storage_busy' });
      return { state: { creds: { account: {}, me: { id: jid } } }, release: async () => { releases++; } };
    },
    makeSocket() {
      socket = { ev: new EventEmitter(), ws: new EventEmitter(), end() {} };
      return socket;
    },
    requestPairingCode: () => assert.fail('Must restore linked credentials'),
    schedule(fn, delay) {
      if (delay === 1000) retry = fn;
      return fn;
    },
    cancel() {}
  });
  await manager.start();
  assert.equal(manager.requestPairing().reason, 'auth_storage_busy');
  retry();
  await new Promise(resolve => setImmediate(resolve));
  socket.ev.emit('connection.update', { connection: 'open' });
  assert.equal(manager.connected, true);
  await manager.stop();
  assert.equal(releases, 1);
});

test('restart waits for the old lease, then delivers commands across Baileys startup buffering', { skip: !hasRedis }, async t => {
  const { EventEmitter } = await import('node:events');
  const { DisconnectReason, makeEventBuffer } = await import('@whiskeysockets/baileys');
  const { default: pino } = await import('pino');
  const { createMessageHandler } = await import('../src/baileys-media.js');
  const { command } = await redis(t);
  const entries = [];
  const log = {
    info: fields => entries.push(fields), warn: fields => entries.push(fields),
    error: fields => entries.push(fields)
  };
  const loadAuth = () => openRemoteAuth({ command, ...options, log });
  const old = await loadAuth();
  link(old.state.creds);
  await old.saveCreds();
  t.after(() => old.release());

  const timers = new Set();
  const sockets = [];
  const replies = [];
  const manager = createConnectionManager({
    phone: '18005550000', reasons: DisconnectReason, log, loadAuth,
    requestPairingCode: () => assert.fail('Restored session must not require a pairing code'),
    onMessages: createMessageHandler({ log }),
    now: () => 1700000000000,
    makeSocket(state) {
      assert.equal(state.creds.me.id, jid);
      const sock = {
        ev: makeEventBuffer(pino({ level: 'silent' })),
        ws: new EventEmitter(),
        end() {},
        sendMessage: async (target, message) => { replies.push({ target, message }); }
      };
      sockets.push(sock);
      return sock;
    },
    schedule(fn, delay) {
      const timer = { fn, delay };
      timers.add(timer);
      return timer;
    },
    cancel: timer => timers.delete(timer)
  });
  t.after(() => manager.stop());
  function fire(delay) {
    const timer = [...timers].find(timer => timer.delay === delay);
    assert.ok(timer, `Expected ${delay}ms timer`);
    timers.delete(timer);
    timer.fn();
  }
  async function until(check) {
    for (let i = 0; i < 40; i++) {
      if (check()) return;
      await new Promise(resolve => setTimeout(resolve, 15));
    }
    assert.fail('Expected recovery state did not occur');
  }
  function menu(sock, id, type = 'notify', timestamp = 1700000000) {
    sock.ev.emit('messages.upsert', { type, messages: [
      { key: { remoteJid: jid, id }, messageTimestamp: timestamp, message: { conversation: '.menu' } }
    ] });
  }
  await manager.start();
  assert.equal(manager.requestPairing().reason, 'auth_storage_busy');
  assert.equal(sockets.length, 0);
  for (const [delay, next] of [[1000, 2000], [2000, 4000], [4000, 8000]]) {
    fire(delay);
    await until(() => [...timers].some(timer => timer.delay === next));
    assert.equal(sockets.length, 0);
  }
  // Simulate forced process termination with no graceful release.
  await command(['PEXPIRE', 'shelby:auth:{test}:lease', 1]);
  await new Promise(resolve => setTimeout(resolve, 10));
  fire(8000);
  await until(() => sockets.length === 1);
  await old.release();
  assert.ok(await command(['PTTL', 'shelby:auth:{test}:lease']) > 0);
  const first = sockets[0];
  first.ws.emit('open');
  assert.equal(manager.connected, false);
  first.ev.buffer();
  menu(first, 'early');
  first.ev.flush();
  assert.equal(replies.length, 0);
  first.ev.buffer();
  menu(first, 'historical', 'append', 1699999900);
  menu(first, 'buffered', 'append');
  first.ev.emit('connection.update', { connection: 'open' });
  first.ev.emit('connection.update', { connection: 'open' });
  assert.equal(manager.connected, true);
  await until(() => replies.length === 1);
  fire(30_000);
  await until(() => replies.length === 2);
  assert.ok(replies.every(({ message }) => /MAIN MENU/.test(message.text)));
  assert.ok(entries.some(fields => fields.reason === 'auth_lease_acquired'));
  assert.ok(entries.some(fields => fields.reason === 'whatsapp_open'));
  assert.ok(entries.some(fields => fields.reason === 'startup_event_buffer_flushed'));
  assert.doesNotMatch(JSON.stringify(entries), /18005550000|synthetic-account/);

  first.ev.emit('connection.update', {
    connection: 'close', lastDisconnect: { error: { output: { statusCode: 428 } } }
  });
  await until(() => [...timers].some(timer => timer.delay === 1000));
  fire(1000);
  await until(() => sockets.length === 2);
  sockets[1].ev.emit('connection.update', { connection: 'open' });
  menu(first, 'stale');
  menu(sockets[1], 'new-socket');
  await until(() => replies.length === 3);
  await manager.stop();
});

test('a lost Redis lease-acquisition response releases only the attempted owner', { skip: !hasRedis }, async t => {
  const { command } = await redis(t);
  await assert.rejects(openRemoteAuth({
    ...options, async command(args) {
      const result = await command(args);
      if (args[0] === 'SET') throw new Error('synthetic lost response');
      return result;
    }
  }));
  assert.equal(await command(['PTTL', 'shelby:auth:{test}:lease']), -2);
  const current = await openRemoteAuth({ command, ...options });
  await assert.rejects(openRemoteAuth({
    ...options, async command(args) {
      const result = await command(args);
      if (args[0] === 'SET') throw new Error('synthetic lost response');
      return result;
    }
  }));
  assert.ok(await command(['PTTL', 'shelby:auth:{test}:lease']) > 0);
  await current.release();
});

test('v7 native LID mapping locates a persisted privacy token after an encrypted Redis restart', { skip: !hasRedis }, async t => {
  const { command } = await redis(t);
  const entry = new URL(import.meta.resolve('@whiskeysockets/baileys'));
  const { LIDMappingStore } = await import(new URL('./Signal/lid-mapping.js', entry));
  const { buildTcTokenFromJid } = await import(new URL('./Utils/tc-token-utils.js', entry));
  const { default: pino } = await import('pino');
  const log = pino({ level: 'silent' });
  const lid = '987654321@lid';
  const token = Buffer.from('synthetic-token-for-test-only');
  const timestamp = String(Math.floor(Date.now() / 1000));
  const legacyFile = process.env.BAILEYS_V6_AUTH_MODULE;
  const writer = legacyFile ? (await import(pathToFileURL(legacyFile))).openRemoteAuth : openRemoteAuth;
  const legacy = await writer({ ...options, command });
  link(legacy.state.creds);
  const identity = Buffer.from(legacy.state.creds.signedIdentityKey.public);
  await legacy.saveCreds();
  await legacy.state.keys.set({ session: { [jid]: Buffer.from('synthetic-v6-session') } });
  await legacy.release();

  let restored = await openRemoteAuth({ ...options, command });
  assert.equal(restored.state.creds.me.id, jid);
  assert.deepEqual(restored.state.creds.signedIdentityKey.public, identity);
  assert.deepEqual((await restored.state.keys.get('session', [jid]))[jid], Buffer.from('synthetic-v6-session'));
  const mapping = state => new LIDMappingStore(addTransactionCapability(state.keys, log, {
    maxCommitRetries: 1, delayBetweenTriesMs: 0
  }), log);
  await mapping(restored.state).storeLIDPNMappings([{ lid, pn: jid }]);
  await restored.state.keys.set({
    'device-list': { [jid.split('@')[0]]: ['0', '1'] },
    tctoken: { [lid]: { token, timestamp } }
  });
  await restored.release();

  restored = await openRemoteAuth({ ...options, command });
  const native = mapping(restored.state);
  assert.equal(jidNormalizedUser(await native.getPNForLID(lid)), jid);
  assert.deepEqual((await restored.state.keys.get('device-list', [jid.split('@')[0]]))[jid.split('@')[0]], ['0', '1']);
  const content = await buildTcTokenFromJid({ authState: restored.state, jid,
    getLIDForPN: pn => native.getLIDForPN(pn) });
  assert.deepEqual(content, [{ tag: 'tctoken', attrs: { t: timestamp }, content: token }]);
  assert.doesNotMatch(JSON.stringify(await command(['HGETALL', 'shelby:auth:{test}:state'])), /synthetic-token|987654321/);
  await restored.release();
});
