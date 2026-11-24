import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { createAnalytics, redisCommand } from './analytics.js';
import { memorySnapshot } from '../runtime-diagnostics.js';

const COOKIE = '__Host-shelby-admin';
const SESSION_MS = 8 * 3600_000;
const POLICY = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; manifest-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
const digest = secret => createHash('sha256').update(secret).digest();
const equal = (expected, supplied) => timingSafeEqual(expected, digest(supplied));
const secret = value => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value) &&
  Buffer.from(value, 'base64url').toString('base64url') === value;
const assetTypes = {
  'app.js': 'text/javascript; charset=utf-8', 'style.css': 'text/css; charset=utf-8',
  'manifest.webmanifest': 'application/manifest+json', 'icon.svg': 'image/svg+xml', 'apple-touch-icon.png': 'image/png'
};
const readAsset = file => readFileSync(new URL('../../public/dashboard/' + file, import.meta.url));

export function adminConfig(env = process.env) {
  if (env.SHELBY_ADMIN_ENABLED !== '1') return null;
  try {
    const origin = new URL(env.SHELBY_ADMIN_ORIGIN);
    const redis = new URL(env.BAILEYS_AUTH_REDIS_URL);
    const token = env.SHELBY_ADMIN_TOKEN;
    const redisToken = env.BAILEYS_AUTH_REDIS_TOKEN?.trim();
    const key = env.SHELBY_ANALYTICS_KEY;
    if (origin.protocol !== 'https:' || origin.origin !== env.SHELBY_ADMIN_ORIGIN ||
        redis.protocol !== 'https:' || redis.username || redis.password || redis.search || redis.hash || redis.pathname !== '/' ||
        !redisToken || !secret(token) || !secret(key) || token === key ||
        [env.PAIRING_ACCESS_TOKEN, redisToken].some(value => [token, key].includes(value)) ||
        [token, key].some(value => Buffer.from(value, 'base64url').toString('base64') === env.BAILEYS_AUTH_ENCRYPTION_KEY?.trim())) return null;
    return { origin: origin.origin, redis: redis.href, redisToken, token, key };
  } catch { return null; }
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    if (req.headers['content-type'] !== 'application/json') { req.resume(); reject(new Error()); return; }
    let value = '';
    const timer = setTimeout(() => { reject(new Error()); req.destroy(); }, 5000);
    timer.unref();
    req.once('end', () => clearTimeout(timer));
    req.once('close', () => clearTimeout(timer));
    req.setEncoding('utf8');
    req.on('data', chunk => {
      if (value.length + chunk.length > 1024) { reject(new Error()); return; }
      value += chunk;
    });
    req.on('end', () => { try { resolve(JSON.parse(value)); } catch { reject(new Error()); } });
    req.on('error', reject);
    req.on('aborted', reject);
  });
}

function page(items, query) {
  const pageSize = 20;
  const index = Math.max(1, Math.min(50, Number.parseInt(query.get('page'), 10) || 1));
  return { page: index, pageSize, total: items.length, items: items.slice((index - 1) * pageSize, index * pageSize) };
}

export function createAdmin({ config = adminConfig(), connection, media, now = Date.now, command, version, assets } = {}) {
  if (!config) return null;
  const analytics = createAnalytics({
    command: command ?? redisCommand(config.redis, config.redisToken),
    namespace: digest(config.origin).toString('hex').slice(0, 24), key: Buffer.from(config.key, 'base64url'), now
  });
  const credential = digest(config.token);
  const sessions = new Map();
  let attempts = 0;
  let resetAt = 0;
  let cpuPoint;
  let cpuPercent = null;
  const files = assets ?? Object.fromEntries(['login.html', 'index.html', ...Object.keys(assetTypes)]
    .map(file => [file, readAsset(file)]));
  const build = typeof version === 'string' && /^[a-f0-9]{7,40}$/.test(version) ? version : null;

  function session(req) {
    const value = /(?:^|;\s*)__Host-shelby-admin=([A-Za-z0-9_-]{43})(?:;|$)/.exec(req.headers.cookie || '')?.[1];
    if (!value) return null;
    const id = digest(value).toString('hex');
    const stored = sessions.get(id);
    if (!validSession(id, stored)) return null;
    return { ...stored, id };
  }

  function validSession(id, stored = sessions.get(id)) {
    if (!stored) return false;
    if (now() < stored.expires) return true;
    sessions.delete(id);
    return false;
  }

  function system(snapshot) {
    const at = performance.now();
    const usage = process.cpuUsage();
    if (!cpuPoint || at - cpuPoint.at >= 1000) {
      if (cpuPoint) cpuPercent = Math.round(((usage.user + usage.system - cpuPoint.usage) / 1000) / (at - cpuPoint.at) * 1000) / 10;
      cpuPoint = { at, usage: usage.user + usage.system };
    }
    const memory = memorySnapshot();
    return {
      http: 'healthy', whatsapp: connection?.connected ? 'connected' : 'disconnected',
      redis: analytics.health().redis, uptimeSeconds: Math.floor(process.uptime()), cpuPercent,
      rssBytes: memory.rssBytes, containerBytes: memory.cgroupBytes ?? null,
      containerLimitBytes: Number.isSafeInteger(memory.cgroupLimitBytes) ? memory.cgroupLimitBytes : null,
      version: build, lastWhatsAppAt: connection?.lastConnectedAt ?? null,
      lastDeliveryAt: snapshot?.overview.lastDeliveryAt ?? null
    };
  }

  async function route(req, res) {
    const [pathname, search] = req.url.split('?', 2);
    if (pathname !== '/dashboard' && !pathname.startsWith('/dashboard/') &&
        pathname !== '/api/admin' && !pathname.startsWith('/api/admin/')) return false;

    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', POLICY);
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    const reply = (code, content, type = 'application/json; charset=utf-8') => {
      res.writeHead(code, { 'Content-Type': type });
      res.end(type.startsWith('application/json') ? JSON.stringify(content) : content);
      return true;
    };
    const current = session(req);
    if (pathname === '/dashboard' && req.method === 'GET') {
      return reply(current ? 200 : 401, files[current ? 'index.html' : 'login.html'], 'text/html; charset=utf-8');
    }
    const asset = pathname.slice('/dashboard/'.length);
    if (pathname.startsWith('/dashboard/') && req.method === 'GET' && Object.hasOwn(assetTypes, asset)) {
      return reply(200, files[asset], assetTypes[asset]);
    }

    if (pathname === '/api/admin/login' && req.method === 'POST') {
      if (req.headers.origin !== config.origin) return reply(403, { error: 'Request origin rejected.' });
      const stamp = now();
      if (stamp >= resetAt) { resetAt = stamp + 60_000; attempts = 0; }
      if (attempts >= 5) {
        res.setHeader('Retry-After', Math.ceil((resetAt - stamp) / 1000));
        req.resume();
        return reply(429, { error: 'Too many attempts. Try again in a minute.' });
      }
      attempts++;
      let body;
      try { body = await readJson(req); } catch { return reply(400, { error: 'Invalid request.' }); }
      if (!equal(credential, typeof body?.token === 'string' ? body.token : '')) {
        return reply(401, { error: 'Invalid access token.' });
      }
      for (const [id, value] of sessions) if (value.expires <= stamp) sessions.delete(id);
      if (current) sessions.delete(current.id);
      if (sessions.size >= 16) sessions.delete(sessions.keys().next().value);
      const value = randomBytes(32).toString('base64url');
      sessions.set(digest(value).toString('hex'), { csrf: randomBytes(32).toString('base64url'), expires: stamp + SESSION_MS });
      res.setHeader('Set-Cookie', `${COOKIE}=${value}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=28800`);
      return reply(200, { status: 'ok' });
    }
    if (!current) return reply(401, { error: 'Sign in required.' });
    if (pathname === '/api/admin/logout' && req.method === 'POST') {
      if (req.headers.origin !== config.origin || !equal(digest(current.csrf), req.headers['x-csrf-token'] || '')) {
        return reply(403, { error: 'Request rejected.' });
      }
      sessions.delete(current.id);
      res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`);
      return reply(200, { status: 'ok' });
    }

    if (pathname === '/api/admin/state' && req.method === 'GET') {
      const query = new URLSearchParams(search);
      const snapshot = await analytics.read();
      if (!validSession(current.id)) return reply(401, { error: 'Sign in required.' });
      const view = query.get('view');
      const filter = query.get('filter');
      const output = {
        csrf: current.csrf, updatedAt: now(), collectedAt: snapshot?.overview.readAt ?? null,
        ...analytics.health(), queue: media?.snapshot() ?? { activeJobs: 0, queuedJobs: 0 },
        active: analytics.active(), system: system(snapshot), overview: snapshot?.overview ?? null
      };
      if (view === 'jobs') output.history = page((snapshot?.jobs ?? []).filter(job =>
        !['success', 'failed', 'copy', 'encode'].includes(filter) || [job.result, job.method].includes(filter)), query);
      if (view === 'users') output.users = page(snapshot?.people ?? [], query);
      return reply(200, output);
    }
    return reply(404, { error: 'Not found.' });
  }

  return { route, telemetry: analytics };
}
