import assert from 'node:assert/strict';
import test from 'node:test';
import pino from 'pino';
import {
  aesDecryptCTR, assertNodeErrorFree, derivePairingCodeKey, getBinaryNodeChild,
  getPlatformId, initAuthCreds
} from '@whiskeysockets/baileys';
import { createBaileysDiagnosticLogger, pairingBrowser, requestConfirmedPairingCode } from '../src/baileys-pairing.js';

const phone = '12345678901';
const reference = Buffer.from('test-reference');

test('registration query wraps the ephemeral key and returns only after an IQ result', async () => {
  const creds = initAuthCreds();
  let reply;
  let signalQuery;
  const queryReached = new Promise(resolve => { signalQuery = resolve; });
  const sock = {
    authState: { creds },
    query(node, timeoutMs) {
      assert.ok(timeoutMs > 0);
      signalQuery(node);
      return new Promise(resolve => { reply = resolve; });
    }
  };

  let settled = false;
  const result = requestConfirmedPairingCode(sock, phone).then(code => {
    settled = true;
    return code;
  });
  const captured = await Promise.race([queryReached, result]);
  assert.equal(settled, false);
  assert.equal(captured.tag, 'iq');
  assert.equal(captured.attrs.xmlns, 'md');
  const hello = getBinaryNodeChild(captured, 'link_code_companion_reg');
  assert.equal(hello.attrs.stage, 'companion_hello');
  assert.equal(hello.attrs.jid, `${phone}@s.whatsapp.net`);
  assert.equal(getBinaryNodeChild(hello, 'companion_platform_id').content, getPlatformId(pairingBrowser[1]));
  assert.equal(getBinaryNodeChild(hello, 'companion_platform_display').content, 'Chrome (Mac OS)');
  assert.deepEqual(getBinaryNodeChild(hello, 'link_code_pairing_nonce').content, Buffer.from([0]));
  reply({
    tag: 'iq', attrs: { type: 'result' },
    content: [{
      tag: 'link_code_companion_reg', attrs: {},
      content: [{ tag: 'link_code_pairing_ref', attrs: {}, content: reference }]
    }]
  });
  const pairing = await result;
  assert.deepEqual(pairing.reference, reference);
  const { code } = pairing;
  assert.match(code, /^[0-9A-Z]{8}$/);
  assert.equal(creds.pairingCode, code);
  assert.equal(creds.registered, false);

  const wrapped = getBinaryNodeChild(hello, 'link_code_pairing_wrapped_companion_ephemeral_pub').content;
  assert.equal(wrapped.length, 80);
  const key = await derivePairingCodeKey(code, wrapped.subarray(0, 32));
  const decoded = aesDecryptCTR(wrapped.subarray(48), key, wrapped.subarray(32, 48));
  assert.ok(decoded.equals(Buffer.from(creds.pairingEphemeralKeyPair.public)));
});

test('registration rejection, timeout and malformed reply never return a code', async () => {
  const sock = {
    authState: { creds: initAuthCreds() },
    async query() {
      return assertNodeErrorFree({
        tag: 'iq', attrs: { type: 'error' },
        content: [{ tag: 'error', attrs: { code: '406', text: 'private server detail' } }]
      });
    }
  };
  await assert.rejects(requestConfirmedPairingCode(sock, phone), {
    message: 'pairing_hello_rejected', statusCode: 406
  });
  sock.query = async () => ({ tag: 'iq', attrs: { type: 'error' } });
  await assert.rejects(requestConfirmedPairingCode(sock, phone), { message: 'pairing_hello_rejected' });
  sock.query = async () => { throw { output: { statusCode: 408 }, data: { stack: 'private' } }; };
  await assert.rejects(requestConfirmedPairingCode(sock, phone), {
    message: 'pairing_hello_unconfirmed', statusCode: 408
  });
  sock.query = async () => ({ tag: 'iq', attrs: { type: 'set' } });
  await assert.rejects(requestConfirmedPairingCode(sock, phone), { message: 'pairing_hello_unexpected_reply' });
  sock.query = async () => ({ tag: 'iq', attrs: { type: 'result' } });
  await assert.rejects(requestConfirmedPairingCode(sock, phone), { message: 'pairing_hello_reference_missing' });
});

test('diagnostic logger forwards only allowlisted numeric notification error data', () => {
  const received = [];
  const logger = createBaileysDiagnosticLogger(pino({ level: 'silent' }), data => received.push(data));
  logger.error({ err: { data: 406, stack: 'private-stack' } }, "unexpected error in 'handling notification'");
  logger.child({ phone }).error({ err: { data: phone } }, "unexpected error in 'handling notification'");
  logger.error({ err: { data: 429 } }, 'other private message');
  logger.trace({ qr: 'private-qr' }, 'private trace');
  assert.deepEqual(received, [406, undefined]);
});
