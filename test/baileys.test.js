import { EventEmitter } from 'node:events';
import assert from 'node:assert/strict';
import test from 'node:test';
import { makeEventBuffer } from '@whiskeysockets/baileys';
import pino from 'pino';
import { createMessageHandler } from '../src/baileys-media.js';
import { createConnectionManager, liveSocketOptions } from '../src/baileys-connection.js';
import { createBaileysHandler } from '../src/baileys-http.js';

const flush = () => new Promise(resolve => setImmediate(resolve));
const phone = '12345678901';
const code = 'EXAMPLE1';
const token = 'test-only-token';
const reference = Buffer.from('test-reference');
const phoneEvent = 'CB:notification,type:link_code_companion_reg';

function phoneNotification(ref = reference) {
  return {
    tag: 'notification', attrs: { type: 'link_code_companion_reg' },
    content: [{
      tag: 'link_code_companion_reg', attrs: {},
      content: [{ tag: 'link_code_pairing_ref', attrs: {}, content: ref }]
    }]
  };
}

function setup({ creds = {}, requestCode = async () => code, save = async () => {}, eventEmitter = () => new EventEmitter(), onMessage } = {}) {
  let time = 0;
  const sockets = [];
  const timers = new Map();
  const logs = [];
  const messages = [];
  let stored = { ...creds };
  const manager = createConnectionManager({
    phone,
    reasons: { loggedOut: 401, forbidden: 403, multideviceMismatch: 411, connectionReplaced: 440, badSession: 500, restartRequired: 515 },
    log: { info: (...args) => logs.push(JSON.stringify(args)), error: (...args) => logs.push(JSON.stringify(args)), warn: (...args) => logs.push(JSON.stringify(args)) },
    now: () => time,
    schedule(fn, ms) {
      const id = Symbol();
      timers.set(id, { fn, at: time + ms });
      return id;
    },
    cancel: id => timers.delete(id),
    async loadAuth() {
      const state = { creds: { ...stored } };
      return { state, saveCreds: async () => { await save(); stored = { ...state.creds }; } };
    },
    makeSocket(state, notificationError) {
      const sock = {
        ev: eventEmitter(),
        state,
        notificationError,
        ws: Object.assign(new EventEmitter(), { isOpen: false }),
        ended: 0,
        requests: 0,
        end() { this.ended++; this.ws.isOpen = false; }
      };
      sockets.push(sock);
      return sock;
    },
    async requestPairingCode(sock, number) {
      assert.equal(number, phone);
      sock.requests++;
      sock.state.creds.me = { id: phone };
      sock.state.creds.pairingCode = code;
      return { code: await requestCode(), reference };
    },
    onMessages: onMessage ?? ((sock, event) => messages.push(event))
  });
  function http(url = '/pairing', authorization = `Bearer ${token}`, method = 'POST') {
    const headers = {};
    let status, result;
    createBaileysHandler(manager, token)({ url, method, headers: { authorization } }, {
      setHeader: (key, value) => { headers[key] = value; },
      writeHead: value => { status = value; },
      end: body => { result = JSON.parse(body); }
    });
    return { status, result, headers };
  }
  async function advance(ms) {
    time += ms;
    for (const [id, { fn, at }] of timers) {
      if (at > time) continue;
      timers.delete(id);
      fn();
    }
    await flush();
  }
  return { manager, sockets, http, advance, timers, logs, messages, stored: () => stored };
}

function disconnect(sock, statusCode, message = 'closed') {
  sock.ws.isOpen = false;
  sock.ev.emit('connection.update', {
    connection: 'close', lastDisconnect: { error: { message, output: { statusCode } } }
  });
}

test('authenticated POST starts one socket and requests one code after the challenge', async () => {
  const { manager, http, sockets, logs, stored } = setup({ creds: { me: { id: phone }, pairingCode: code } });
  await manager.start();
  assert.equal(http('/pairing', 'Bearer wrong').status, 403);
  assert.equal(http('/pairing', token).status, 403);
  assert.equal(http('/pairing', undefined, 'GET').status, 404);
  assert.equal(sockets.length, 0);
  assert.equal(http().status, 202);
  assert.equal(http().status, 202);
  await flush();
  const [sock] = sockets;
  assert.equal(sock.state.creds.me, undefined);
  sock.ws.isOpen = true;
  sock.ws.emit('open');
  assert.equal(http().result.reason, 'transport_open');
  sock.ev.emit('connection.update', { connection: 'connecting' });
  assert.equal(sock.requests, 0);
  sock.ev.emit('connection.update', { qr: 'private-challenge-one' });
  sock.ev.emit('connection.update', { qr: 'private-challenge-two' });
  assert.equal(http().result.status, 'waiting_for_whatsapp');
  await flush();
  assert.equal(sockets.length, 1);
  assert.equal(sock.requests, 1);
  assert.equal(http().result.code, code);
  assert.equal(http().headers['cache-control'], 'no-store');
  assert.equal(manager.connected, false);
  assert.equal(http('/pairing', 'Bearer wrong').result.code, undefined);
  assert.deepEqual(stored(), { me: { id: phone }, pairingCode: code });
  for (const secret of [phone, code, token, 'private-challenge']) assert.doesNotMatch(logs.join(), new RegExp(secret));
  await manager.stop();
});

test('expires a code, closes its socket, and refreshes only on an explicit authenticated POST', async () => {
  const { manager, http, sockets, advance } = setup();
  await manager.start();
  http();
  await flush();
  sockets[0].ws.isOpen = true;
  sockets[0].ev.emit('connection.update', { qr: 'ref' });
  await flush();
  await advance(60_000);
  assert.equal(sockets[0].ended, 1);
  assert.equal(http().result.status, 'pairing_code_expired');
  assert.equal(http().result.reason, 'pairing_phone_notification_missing');
  assert.equal(http().result.code, undefined);
  assert.equal(http('/pairing?refresh=1', 'Bearer wrong').status, 403);
  assert.equal(sockets.length, 1);
  assert.equal(http('/pairing?refresh=1').status, 202);
  await flush();
  assert.equal(sockets.length, 2);
  await manager.stop();
});

test('late code resolution is discarded and transient failures have a bounded retry budget', async () => {
  let resolveCode;
  const { manager, http, sockets, advance, timers } = setup({
    requestCode: () => new Promise(resolve => { resolveCode = resolve; })
  });
  await manager.start();
  http();
  await flush();
  sockets[0].ws.isOpen = true;
  sockets[0].ev.emit('connection.update', { qr: 'ref' });
  disconnect(sockets[0], 428);
  disconnect(sockets[0], 428);
  resolveCode(code);
  await flush();
  assert.equal(http().result.code, undefined);
  for (const [index, delay] of [1000, 2000, 4000].entries()) {
    assert.equal(timers.size, 1);
    await advance(delay);
    assert.equal(sockets.length, index + 2);
    disconnect(sockets.at(-1), 503);
    await flush();
  }
  assert.equal(timers.size, 0);
  assert.equal(http().result.status, 'connection_failed');
  await manager.stop();
});

test('persists signed credentials before the required restart and gates messages on open', async () => {
  let release;
  const { manager, http, sockets, advance, timers, stored, messages } = setup({
    save: () => new Promise(resolve => { release = resolve; })
  });
  await manager.start();
  http();
  await flush();
  const [sock] = sockets;
  sock.ws.isOpen = true;
  sock.ev.emit('connection.update', { qr: 'ref' });
  await flush();
  sock.ws.emit(phoneEvent, phoneNotification());
  sock.state.creds.registered = true;
  sock.ev.emit('creds.update');
  sock.ws.emit('CB:iq,,pair-success');
  sock.state.creds.account = { signed: true };
  sock.state.creds.me = { id: 'linked-device' };
  sock.ev.emit('creds.update');
  sock.ev.emit('connection.update', { isNewLogin: true });
  assert.equal(http().result.code, undefined);
  disconnect(sock, 515);
  await flush();
  assert.equal(timers.size, 0);
  release();
  await flush();
  await advance(0);
  assert.equal(sockets.length, 2);
  assert.equal(stored().me.id, 'linked-device');
  assert.equal(stored().pairingCode, undefined);
  sockets[1].ev.emit('messages.upsert', { messages: [] });
  assert.equal(messages.length, 0);
  sockets[1].ev.emit('connection.update', { connection: 'open' });
  assert.equal(http().result.status, 'already_linked');
  assert.equal(manager.connected, true);
  sockets[1].ev.emit('messages.upsert', { messages: [] });
  assert.equal(messages.length, 1);
  disconnect(sockets[1], 440);
  await flush();
  assert.equal(http().result.status, 'connection_failed');
  assert.equal(timers.size, 0);
  await manager.stop();
});

test('QR challenge exhaustion, handshake deadline and pairing send failure are diagnosed separately', async () => {
  const { manager, http, sockets, advance } = setup({
    requestCode: async () => { throw Object.assign(new Error('private failure'), { output: { statusCode: 428 } }); }
  });
  await manager.start();
  http();
  await flush();
  await advance(60_000);
  assert.equal(http().result.reason, 'handshake_deadline');
  await advance(1000);
  sockets[1].ws.isOpen = true;
  sockets[1].ev.emit('connection.update', { qr: 'ref' });
  await flush();
  assert.equal(http().result.reason, 'pairing_request_failed');
  assert.equal(sockets[1].ended, 1);
  await advance(2000);
  disconnect(sockets[2], 408, 'QR refs attempts ended');
  await flush();
  assert.equal(http().result.status, 'connecting');
  assert.equal(http().result.reason, 'qr_refs_exhausted');
  await manager.stop();
});

test('credential storage failure stops the connection without reconnecting', async () => {
  const { manager, http, sockets, timers } = setup({
    creds: { me: { id: 'linked-device' }, account: {} },
    save: async () => { throw new Error('private storage path'); }
  });
  await manager.start();
  sockets[0].ev.emit('creds.update');
  await flush();
  assert.equal(sockets[0].ended, 1);
  assert.equal(http().result.reason, 'credential_storage_failed');
  assert.equal(timers.size, 0);
  await manager.stop();
});

test('registration rejection exposes only its numeric code and waits for manual retry', async () => {
  const { manager, http, sockets, timers, logs } = setup({
    requestCode: async () => {
      throw Object.assign(new Error('private server text'), { reason: 'pairing_hello_rejected', statusCode: 429 });
    }
  });
  await manager.start();
  http();
  await flush();
  sockets[0].ws.isOpen = true;
  sockets[0].ev.emit('connection.update', { qr: 'ref' });
  await flush();
  assert.deepEqual(http().result, { status: 'connection_failed', reason: 'pairing_hello_rejected', statusCode: 429 });
  assert.equal(timers.size, 0);
  assert.doesNotMatch(logs.join(), /private server text/);
  await manager.stop();
});

test('distinguishes a phone notification, finish acknowledgement and missing signed response', async () => {
  const { manager, http, sockets, logs, stored, timers, advance } = setup();
  await manager.start();
  http();
  await flush();
  const [sock] = sockets;
  sock.ws.isOpen = true;
  sock.ev.emit('connection.update', { qr: 'ref' });
  await flush();
  assert.equal(http().result.code, code);

  sock.ws.emit(phoneEvent, phoneNotification());
  assert.equal(http().result.reason, 'pairing_phone_notification_received');
  assert.equal(http().result.code, undefined);
  assert.equal(sock.state.creds.pairingCode, code);
  sock.notificationError(406);
  assert.match(logs.join(), /notification_processing_error_during_pairing/);
  assert.doesNotMatch(logs.join(), /test-reference/);

  sock.state.creds.registered = true;
  sock.ev.emit('creds.update');
  assert.equal(http().result.reason, 'pairing_finish_acknowledged');
  assert.deepEqual(stored(), {});
  await advance(60_000);
  assert.equal(http().result.reason, 'pairing_signed_response_missing');
  assert.equal(timers.size, 0);
  await manager.stop();
});

test('an invalid signed pair response receives a distinct safe status', async () => {
  const { manager, http, sockets, logs, stored } = setup();
  await manager.start();
  http();
  await flush();
  const [sock] = sockets;
  sock.ws.isOpen = true;
  sock.ev.emit('connection.update', { qr: 'ref' });
  await flush();
  sock.ws.emit(phoneEvent, phoneNotification());
  sock.ws.emit('CB:iq,,pair-success', { private: 'signed response bytes' });
  disconnect(sock, 400, 'private verification detail');
  await flush();
  assert.equal(http().result.reason, 'pairing_signed_response_failed');
  assert.deepEqual(stored(), {});
  assert.doesNotMatch(logs.join(), /signed response bytes|private verification detail/);
  await manager.stop();
});

test('an unrelated phone notification cannot advance a confirmed pairing', async () => {
  const { manager, http, sockets, logs, timers, stored } = setup();
  await manager.start();
  http();
  await flush();
  const [sock] = sockets;
  sock.ws.isOpen = true;
  sock.ev.emit('connection.update', { qr: 'ref' });
  await flush();
  assert.equal(http().result.code, code);
  sock.ws.emit(phoneEvent, phoneNotification(Buffer.from('unrelated-private-reference')));
  await flush();
  assert.deepEqual(http().result, { status: 'connection_failed', reason: 'pairing_phone_reference_mismatch' });
  assert.equal(sock.ended, 1);
  assert.equal(timers.size, 0);
  assert.deepEqual(stored(), {});
  assert.doesNotMatch(logs.join(), /unrelated-private-reference/);
  await manager.stop();
});

test('live socket policy enables server props, skips history import and delivers buffered commands after authenticated open', async () => {
  assert.equal(liveSocketOptions.fireInitQueries, true);
  assert.equal(liveSocketOptions.shouldSyncHistoryMessage({ syncType: 3 }), false);
  const output = [];
  const handler = createMessageHandler({ log: { error() {} } });
  const { manager, sockets, http, advance } = setup({
    eventEmitter: () => makeEventBuffer(pino({ level: 'silent' })),
    onMessage: handler
  });
  await manager.start();
  http();
  await flush();
  const sock = sockets[0];
  sock.sendMessage = async (jid, message) => output.push(message.text);
  sock.ws.isOpen = true;
  sock.ws.emit('open');
  sock.state.creds.account = {};
  const send = id => sock.ev.emit('messages.upsert', { type: 'notify', messages: [
    { key: { remoteJid: 'fixture@s.whatsapp.net', id }, message: { conversation: '.ping' } }
  ] });
  send('before-open');
  await flush();
  assert.deepEqual(output, []);
  sock.ev.buffer();
  send('buffered');
  sock.ev.emit('connection.update', { connection: 'open' });
  await flush();
  assert.deepEqual(output, ['🏓 Pong!']);
  await advance(30_000);
  assert.deepEqual(output, ['🏓 Pong!', '🏓 Pong!']);
  await manager.stop();
  await handler.stop();
});

test('linked network failures have one bounded retry at a time and a terminal logout stays terminal', async () => {
  const { manager, http, sockets, advance, timers } = setup({ creds: { account: {} } });
  await manager.start();
  for (const delay of [1000, 2000, 4000, 8000, 16000, 32000]) {
    const socket = sockets.at(-1);
    disconnect(socket, 428);
    disconnect(socket, 428);
    await flush();
    assert.equal(timers.size, 1);
    await advance(delay);
  }
  assert.equal(sockets.length, 7);
  disconnect(sockets.at(-1), 401);
  await flush();
  assert.equal(http('/pairing?refresh=1').result.reason, 'logged_out');
  await advance(64000);
  assert.equal(sockets.length, 7);
  assert.equal(timers.size, 0);
  await manager.stop();
});
