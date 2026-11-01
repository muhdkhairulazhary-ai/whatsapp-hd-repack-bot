import crypto from 'node:crypto';

export function verifyMetaSignature(rawBody, signatureHeader, appSecret) {
  if (!Buffer.isBuffer(rawBody) || !signatureHeader || !appSecret) return false;
  const match = /^sha256=([a-f0-9]{64})$/i.exec(signatureHeader);
  if (!match) return false;

  const expected = crypto.createHmac('sha256', appSecret).update(rawBody).digest();
  const received = Buffer.from(match[1], 'hex');
  return received.length === expected.length && crypto.timingSafeEqual(received, expected);
}

export function isAllowedMediaUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') return false;
    const host = url.hostname.toLowerCase();
    return host === 'lookaside.fbsbx.com'
      || host.endsWith('.fbcdn.net')
      || host.endsWith('.facebook.com')
      || host.endsWith('.whatsapp.net');
  } catch {
    return false;
  }
}
