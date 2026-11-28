import { createHmac, timingSafeEqual } from 'node:crypto';

export const DELIVERY_PATH = '/internal/studio/deliver';
export const LINK_PATH = '/internal/studio/link';
export const linkCodePattern = /^[A-Za-z0-9_-]{22}$/;
export const jidPattern = /^[1-9][0-9]{4,19}@(lid|s\.whatsapp\.net)$/;
const lifetime = 90_000;

export function readBridgeConfig(secret, endpoint) {
  if (!secret && !endpoint) return;
  const url = URL.canParse(endpoint) ? new URL(endpoint) : null;
  if (!/^[a-f0-9]{64}$/.test(secret ?? '') || !url || url.protocol !== 'https:' || url.origin !== endpoint) {
    throw new Error('Configure the Shelby bridge with a 64-character lowercase hex secret and an exact HTTPS peer origin.');
  }
  return { key: Buffer.from(secret, 'hex'), origin: url.origin };
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
