import assert from 'node:assert/strict';
import { execFile, spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { adminConfig, createAdmin } from '../src/admin/admin.js';
import { createAnalytics } from '../src/admin/analytics.js';
import { createBaileysHandler } from '../src/baileys-http.js';

const execute = promisify(execFile);
const token = randomBytes(32).toString('base64url');
const analyticsKey = randomBytes(32).toString('base64url');
const origin = 'https://control.example.test';
const authEnv = {
  SHELBY_ADMIN_ENABLED: '1', SHELBY_ADMIN_ORIGIN: origin, SHELBY_ADMIN_TOKEN: token,
  SHELBY_ANALYTICS_KEY: analyticsKey, BAILEYS_AUTH_REDIS_URL: 'https://redis.example.test',
  BAILEYS_AUTH_REDIS_TOKEN: 'test-only'
};
const empty = [[], [], [], Array.from({ length: 30 }, () => [])];
const hasRedis = ['redis-server', 'redis-cli'].every(tool => spawnSync(tool, ['--version']).status === 0);

async function serve(t, admin) {
  const fallback = createBaileysHandler({}, '');
  const server = http.createServer(async (req, res) => {
    if (!(await admin?.route(req, res))) fallback(req, res);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.close(); server.closeAllConnections(); });
  return (path, init) => fetch(`http://127.0.0.1:${server.address().port}${path}`, init);
}
const loginOptions = (value = token, site = origin) => ({
  method: 'POST', headers: { origin: site, 'content-type': 'application/json' }, body: JSON.stringify({ token: value })
});
const tick = () => new Promise(resolve => setImmediate(resolve));

test('Control Center is opt-in, fails closed, and leaves health public', async t => {
  assert.equal(adminConfig({}), null);
  assert.equal(adminConfig({ ...authEnv, SHELBY_ANALYTICS_KEY: token }), null);
  assert.equal(adminConfig({ ...authEnv, SHELBY_ADMIN_ORIGIN: 'http://control.example.test' }), null);
  const get = await serve(t, createAdmin({ config: null }));
  assert.equal((await get('/dashboard')).status, 404);
  assert.equal((await get('/api/admin/state')).status, 404);
  const health = await get('/health');
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: 'ok' });
});

test('login security, separate health, Redis failure, CSRF, expiration and logout', async t => {
  let stamp = 1700000000000;
  let fail = false;
  const media = { snapshot: () => ({ activeJobs: 1, queuedJobs: 1 }) };
  const admin = createAdmin({
    config: adminConfig(authEnv), now: () => stamp, media,
    connection: { connected: false, lastConnectedAt: stamp - 500 },
    command: async () => { if (fail) throw new Error('sensitive REST error'); return empty; },
    version: '<script>bad</script>'
  });
  const get = await serve(t, admin);
  const privatePage = await get('/dashboard');
  assert.equal(privatePage.status, 401);
  assert.doesNotMatch(await privatePage.text(), /Live processing|Read-only monitoring/);
  assert.equal(privatePage.headers.get('cache-control'), 'no-store');
  assert.match(privatePage.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal((await get('/api/admin/state')).status, 401);
  assert.equal((await get('/api/admin/login', loginOptions(token, 'https://other.example'))).status, 403);
  for (let i = 0; i < 5; i++) {
    const options = loginOptions('wrong');
    options.headers['x-forwarded-for'] = '192.0.2.' + i;
    assert.equal((await get('/api/admin/login', options)).status, 401);
  }
  assert.equal((await get('/api/admin/login', loginOptions())).status, 429);
  stamp += 60_000;
  const response = await get('/api/admin/login', loginOptions());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
  const header = response.headers.get('set-cookie');
  assert.match(header, /^__Host-shelby-admin=[\w-]{43}; Path=\/; Secure; HttpOnly; SameSite=Strict; Max-Age=28800$/);
  const cookie = header.split(';')[0];
  assert.equal((await get('/dashboard', { headers: { cookie } })).status, 200);
  const job = admin.telemetry.start('private-account', 'video', 123);
  job.update({ stage: 'processing', method: 'encode' });
  const queued = admin.telemetry.start('another-account', 'video', 456);
  const read = () => get('/api/admin/state', { headers: { cookie } });
  const state = await read();
  assert.equal(state.headers.get('cache-control'), 'no-store');
  const data = await state.json();
  assert.deepEqual(data.queue, media.snapshot());
  assert.deepEqual(data.active.map(record => record.stage), ['processing', 'queued']);
  assert.equal(data.system.http, 'healthy');
  assert.equal(data.system.whatsapp, 'disconnected');
  assert.equal(data.system.version, null);
  assert.ok(data.system.containerBytes === null || data.system.containerBytes > 0);
  assert.doesNotMatch(JSON.stringify(data), /private-account|another-account|<script>/);
  stamp += 31_000;
  fail = true;
  assert.equal((await (await read()).json()).redis, 'unavailable');
  const stale = await (await read()).json();
  assert.equal(stale.collectedAt, data.collectedAt);
  assert.ok(stale.updatedAt - stale.collectedAt > 30_000);
  const logout = (originValue, csrf) => get('/api/admin/logout', { method: 'POST', headers: { cookie, origin: originValue, 'x-csrf-token': csrf } });
  assert.equal((await logout(origin, '')).status, 403);
  assert.equal((await logout('https://other.example', data.csrf)).status, 403);
  assert.match((await logout(origin, data.csrf)).headers.get('set-cookie'), /Max-Age=0/);
  assert.equal((await read()).status, 401);
  const fresh = (await get('/api/admin/login', loginOptions())).headers.get('set-cookie').split(';')[0];
  stamp += 8 * 3600_000;
  assert.equal((await get('/api/admin/state', { headers: { cookie: fresh } })).status, 401);
  queued.discard();
  job.discard();
});

test('real Redis retains bounded job data across app restart and deduplicates writes', { skip: !hasRedis }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'dashboard-redis-'));
  const socket = join(root, 'redis.sock');
  const child = spawn('redis-server', ['--port', '0', '--unixsocket', socket, '--save', '', '--appendonly', 'no'],
    { stdio: 'ignore' });
  const closed = once(child, 'close');
  t.after(async () => { child.kill(); await closed; await rm(root, { recursive: true, force: true }); });
  async function command(args) {
    const { stdout } = await execute('redis-cli', ['-2', '--json', '-s', socket, ...args.map(String)]);
    return JSON.parse(stdout);
  }
  for (let i = 0; i < 40; i++) {
    try { if (await command(['PING']) === 'PONG') break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  let stamp = Date.UTC(2026, 10, 24, 0, 10);
  const opts = { command, now: () => stamp, config: adminConfig(authEnv) };
  const writes = [];
  const admin = createAdmin({ ...opts, command: args => {
    const result = command(args);
    if (args[2] === 5) writes.push([args, result]);
    return result;
  } });
  const jid = '123456789@s.whatsapp.net';
  const job = admin.telemetry.start(jid, 'video', 20000);
  const fail = admin.telemetry.start(jid, 'video', 30000);
  stamp += 1000;
  job.update({ stage: 'downloading', method: 'copy' });
  fail.update({ stage: 'downloading' });
  stamp += 2000;
  job.finish('success');
  job.finish('success');
  fail.finish('failed', '/private/<script>');
  await tick();
  assert.equal(writes.length, 2);
  await Promise.all(writes.map(([, done]) => done));
  assert.equal(await command(writes[0][0]), 0);
  const recordJson = writes[0][0][18];
  assert.doesNotMatch(recordJson, /123456789|whatsapp\.net/);
  assert.ok(writes.every(([args]) => args.slice(3, 8).every(key => /^shelby:dashboard:\{[a-f0-9]{24}\}:/.test(key))));
  const historyKey = writes[0][0][5];
  const expired = { ...JSON.parse(recordJson), id: randomBytes(16).toString('hex') + 'abcd', finishedAt: stamp - 31 * 86400000 };
  await command(['ZADD', historyKey, stamp - 31 * 86400000, JSON.stringify(expired)]);
  assert.ok(await command(['TTL', historyKey]) > 0);

  const restarted = createAdmin(opts);
  const get = await serve(t, restarted);
  const cookie = (await get('/api/admin/login', loginOptions())).headers.get('set-cookie').split(';')[0];
  const read = async query => (await get('/api/admin/state?' + query, { headers: { cookie } })).json();
  const data = await read('view=jobs');
  assert.equal(data.overview.videos, 1);
  assert.equal(data.overview.total, 2);
  assert.equal(data.overview.copy, 1);
  assert.equal(data.overview.failed, 1);
  assert.equal(data.overview.averageMs, 2000);
  assert.equal(data.overview.days.at(-1).total, 2);
  assert.equal(data.overview.days.at(-1).date, '2026-11-24');
  assert.equal(data.history.total, 2);
  assert.equal(data.history.items.find(item => item.result === 'failed').error, 'other');
  assert.equal((await read('view=jobs&filter=copy')).history.total, 1);
  assert.equal((await read('view=jobs&page=2')).history.items.length, 0);
  const people = (await read('view=users')).users;
  assert.equal(people.total, 1);
  assert.equal(people.items[0].jobs, 2);
  assert.match(people.items[0].id, /^[a-f0-9]{32}$/);
  assert.doesNotMatch(JSON.stringify(data), /private|<script>|123456789/);
});

test('terminal writes are bounded and failures do not reject the media observer', async () => {
  let reject;
  const unavailable = new Promise((_, fail) => { reject = fail; });
  const analytics = createAnalytics({ command: () => unavailable, namespace: 'test', key: randomBytes(32) });
  for (let i = 0; i < 20; i++) analytics.start('anonymous', 'video', 1).finish('success');
  assert.equal(analytics.health().dropped, 12);
  await tick();
  reject(new Error('service down'));
  await tick();
  assert.deepEqual(analytics.health(), { redis: 'unavailable', dropped: 20 });
  assert.deepEqual(analytics.active(), []);
});

test('the admin session remains required throughout an in-flight analytics read', async t => {
  let unblock;
  let reading;
  const readStarted = new Promise(resolve => { reading = resolve; });
  const blocked = new Promise(resolve => { unblock = resolve; });
  let stamp = Date.UTC(2026, 10, 24, 1);
  let shouldBlock = false;
  const get = await serve(t, createAdmin({ config: adminConfig(authEnv), now: () => stamp,
    command: async () => { if (shouldBlock) { reading(); await blocked; } return empty; } }));
  const response = await get('/api/admin/login', loginOptions());
  const cookie = response.headers.get('set-cookie').split(';')[0];
  const read = () => get('/api/admin/state', { headers: { cookie } });
  assert.equal((await get('/api/admin/state?token=' + token, { headers: {
    authorization: 'Bearer ' + token, cookie: '__Host-shelby-admin=' + token, 'x-forwarded-user': 'admin'
  } })).status, 401);
  assert.equal((await get('/dashboard/index.html')).status, 401);
  const { csrf } = await (await read()).json();
  stamp += 13_000;
  shouldBlock = true;
  const pending = read();
  await readStarted;
  try {
    assert.equal((await get('/api/admin/logout', { method: 'POST',
      headers: { cookie, origin, 'x-csrf-token': csrf } })).status, 200);
  } finally { unblock(); }
  assert.equal((await pending).status, 401);
});

test('a Redis outage does not extend the history retention cutoff', async () => {
  let stamp = Date.UTC(2026, 10, 24, 1);
  const finishedAt = stamp - 30 * 86_400_000 + 15_000;
  let fail = false;
  const analytics = createAnalytics({ namespace: 'test', key: randomBytes(32), now: () => stamp,
    command: async () => {
      if (fail) throw new Error('outage');
      const user = 'a'.repeat(32);
      return [[], [JSON.stringify({ id: '6'.repeat(36), user, result: 'success', finishedAt })],
        [user, finishedAt], empty[3]];
    }
  });
  assert.equal((await analytics.read()).jobs.length, 1);
  fail = true;
  stamp += 13_000;
  assert.equal((await analytics.read()).jobs.length, 1);
  assert.equal(analytics.health().redis, 'unavailable');
  stamp += 3_000;
  assert.equal(await analytics.read(), undefined);
});
