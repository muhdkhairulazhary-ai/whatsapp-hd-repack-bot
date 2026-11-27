import assert from 'node:assert/strict';
import test from 'node:test';
import pino from 'pino';
import { createBaileysDiagnosticLogger } from '../src/baileys-pairing.js';
import { createTokenDiagnostics } from '../src/baileys-token-diagnostics.js';

test('token diagnostics correlate relay facts and discard protocol payloads', () => {
  const entries = [];
  const diagnostics = createTokenDiagnostics({ info: fields => entries.push(fields) });
  const logger = createBaileysDiagnosticLogger(pino({ level: 'silent' }), () => {}, undefined, diagnostics);
  assert.equal(logger.level, 'silent');
  diagnostics.run('test-trace', () => {
    const privateFields = { from: '12345@lid', token: Buffer.from('private-token'), msgId: 'private-msg' };
    logger.debug(privateFields, 'unrecognized log');
    logger.debug({ ...privateFields, address: 'lid', tokenState: 'missing', attached: false }, 'shelby native token relay');
    logger.debug({ ...privateFields, outcome: 'fresh' }, 'shelby native alternate token');
    logger.debug({ ...privateFields, address: 'pn', usable: true }, 'shelby native token stored');
    logger.debug({ ...privateFields, source: 'recovery', usable: false }, 'shelby native token acquisition');
    logger.info({ ...privateFields, process: false }, 'got history notification');
    logger.trace({ xml: 'private-xml' });
  });
  assert.deepEqual(entries, [
    { stage: 'native_lookup', trace: 'test-trace', address: 'lid', tokenState: 'missing', attached: false },
    { stage: 'alternate_pn_lookup', trace: 'test-trace', outcome: 'fresh' },
    { stage: 'token_stored', trace: 'test-trace', address: 'pn', usable: true },
    { stage: 'token_acquisition', trace: 'test-trace', source: 'recovery', usable: false },
    { stage: 'history_notification', trace: 'test-trace', processingEnabled: false }
  ]);
});

test('463 queries native reachout status once without replay or fallback', async () => {
  const entries = [];
  const diagnostics = createTokenDiagnostics({ info: fields => entries.push(fields) });
  let probes = 0;
  const sock = {
    ws: { isOpen: true },
    async fetchAccountReachoutTimelock() {
      probes++;
      return { isActive: true, enforcementType: 'private-value' };
    },
    sendMessage() { assert.fail('Diagnostics must not send messages'); }
  };
  await diagnostics.rejected(sock, 'trace-one', 408);
  await diagnostics.rejected(sock, 'trace-one', 463);
  await diagnostics.rejected(sock, 'trace-two', 463);
  assert.equal(probes, 1);
  assert.deepEqual(entries, [{ stage: 'reachout_status', trace: 'trace-one', outcome: 'active' }]);
});

test('instrumented native helper only reports tokens accepted for storage', async () => {
  const entry = new URL(import.meta.resolve('@whiskeysockets/baileys'));
  const { storeTcTokensFromIqResult } = await import(new URL('./Utils/tc-token-utils.js', entry));
  const writes = [];
  const events = [];
  const timestamp = String(Math.floor(Date.now() / 1000));
  const options = {
    fallbackJid: '12345@s.whatsapp.net', getLIDForPN: async () => '98765@lid',
    keys: { async get() { return {}; }, async set(value) { writes.push(value); } },
    onTokenStored: event => events.push(event)
  };
  const result = t => ({
    tag: 'iq', attrs: {}, content: [{ tag: 'tokens', attrs: {}, content: [
      { tag: 'token', attrs: { type: 'trusted_contact', t }, content: Buffer.from('test-only') }
    ] }]
  });
  await storeTcTokensFromIqResult({ ...options, result: result(undefined) });
  assert.equal(writes.length, 0);
  assert.deepEqual(events, []);
  await storeTcTokensFromIqResult({ ...options, result: result(timestamp) });
  assert.equal(writes.length, 1);
  assert.deepEqual(events, [{ address: 'lid', usable: true }]);
});
