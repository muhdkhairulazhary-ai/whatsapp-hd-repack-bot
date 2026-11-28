import { createHmac, timingSafeEqual } from 'node:crypto';
import { redisRestUrl } from './redis-rest-url.js';

export const DELIVERY_PATH = '/internal/studio/deliver';
export const LINK_PATH = '/internal/studio/link';
export const linkCodePattern = /^[A-Za-z0-9_-]{22}$/;
export const jidPattern = /^[1-9][0-9]{4,19}@(lid|s\.whatsapp\.net)$/;
const lifetime = 90_000;

export class BridgeConfigError extends Error {
  constructor(issues) {
    super('Invalid Studio delivery configuration');
    this.issues = issues;
  }
}

export function readBridgeConfig(env = process.env) {
  const { SHELBY_STUDIO_BRIDGE_KEY: rawKey, SHELBY_STUDIO_API_ORIGIN: rawOrigin } = env;
  if (!rawKey && !rawOrigin) return;

  const key = rawKey?.trim();
  const origin = rawOrigin?.trim().replace(/\/+$/, '');
  const url = URL.canParse(origin) ? new URL(origin) : null;
  const redisUrl = redisRestUrl(env.BAILEYS_AUTH_REDIS_URL);
  const token = env.BAILEYS_AUTH_REDIS_TOKEN?.trim();
  const issues = [];
  const missing = variable => issues.push({ variable, reason: 'missing' });
  const invalid = (variable, reason) => issues.push({ variable, reason });
  if (!key) missing('SHELBY_STUDIO_BRIDGE_KEY');
  else if (!/^[a-f0-9]{64}$/.test(key)) invalid('SHELBY_STUDIO_BRIDGE_KEY', 'expected_64_lowercase_hex_characters');
  if (!origin) missing('SHELBY_STUDIO_API_ORIGIN');
  else if (url?.protocol !== 'https:' || url.origin !== origin) invalid('SHELBY_STUDIO_API_ORIGIN', 'expected_https_origin');
  if (!env.BAILEYS_AUTH_REDIS_URL?.trim()) missing('BAILEYS_AUTH_REDIS_URL');
  else if (!redisUrl) invalid('BAILEYS_AUTH_REDIS_URL', 'expected_https_rest_root');
  if (!token) missing('BAILEYS_AUTH_REDIS_TOKEN');
  else if (!/^[\x21-\x7e]+$/.test(token)) invalid('BAILEYS_AUTH_REDIS_TOKEN', 'expected_token_without_whitespace_or_non_ascii_characters');
  if (issues.length) throw new BridgeConfigError(issues);
  return { key: Buffer.from(key, 'hex'), origin, redisUrl: redisUrl.href, redisToken: token };
}

const mac = (key, path, encoded) => createHmac('sha256', key)
  .update('shelby-bridge-v1\nPOST\n' + path + '\n' + encoded).digest();

export function signedHeaders(key, path, data, now = Date.now()) {
  const encoded = Buffer.from(JSON.stringify({ ...data, expires: now + lifetime })).toString('base64url');
  return { 'x-shelby-envelope': encoded, 'x-shelby-signature': mac(key, path, encoded).toString('hex') };
}

export function verifyEnvelope(key, path, headers, now = Date.now()) {
  const encoded = headers['x-shelby-envelope'];
  const signature = headers['x-shelby-signature'];
  if (typeof encoded !== 'string' || !/^[A-Za-z0-9_-]{1,1536}$/.test(encoded) ||
      typeof signature !== 'string' || !/^[a-f0-9]{64}$/.test(signature) ||
      !timingSafeEqual(mac(key, path, encoded), Buffer.from(signature, 'hex'))) return;
  try {
    const data = JSON.parse(Buffer.from(encoded, 'base64url').toString());
    if (Number.isSafeInteger(data?.expires) && data.expires > now && data.expires <= now + lifetime + 10_000) return data;
  } catch {}
}
