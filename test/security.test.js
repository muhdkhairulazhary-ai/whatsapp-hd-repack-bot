import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { verifyMetaSignature, isAllowedMediaUrl } from '../src/security.js';

test('accepts a valid Meta HMAC signature', () => {
  const body = Buffer.from('{"object":"whatsapp_business_account"}');
  const secret = 'test-secret';
  const signature = 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
  assert.equal(verifyMetaSignature(body, signature, secret), true);
});

test('rejects invalid signatures and malformed headers', () => {
  assert.equal(verifyMetaSignature(Buffer.from('x'), 'sha256=bad', 'secret'), false);
  assert.equal(verifyMetaSignature(Buffer.from('x'), null, 'secret'), false);
  assert.equal(verifyMetaSignature(Buffer.from('x'), 'sha256=' + '0'.repeat(64), 'secret'), false);
});

test('allows HTTPS Meta media hosts only', () => {
  assert.equal(isAllowedMediaUrl('https://lookaside.fbsbx.com/media'), true);
  assert.equal(isAllowedMediaUrl('https://scontent.xx.fbcdn.net/media'), true);
  assert.equal(isAllowedMediaUrl('http://lookaside.fbsbx.com/media'), false);
  assert.equal(isAllowedMediaUrl('https://example.com/media'), false);
});
