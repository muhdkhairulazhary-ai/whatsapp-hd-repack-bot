import assert from 'node:assert/strict';
import { execFile, spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { useMultiFileAuthState, proto } from '@whiskeysockets/baileys';
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
    BAILEYS_AUTH_REDIS_URL: 'https://redis.example.test',
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
