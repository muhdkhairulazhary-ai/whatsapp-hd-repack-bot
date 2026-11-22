import { EventEmitter } from 'node:events';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createConnectionManager } from '../src/baileys-connection.js';
import { createBaileysHandler } from '../src/baileys-http.js';

const flush = () => new Promise(resolve => setImmediate(resolve));
const phone = '12345678901';
const code = 'EXAMPLE1';
const token = 'test-only-token';

function setup({ creds = {}, requestCode = async () => code, save = async () => {} } = {}) {
  let time = 0;
  const sockets = [];
  const timers = new Map();
  const logs = [];
  const messages = [];
  let stored = { ...creds };
  const manager = createConnectionManager({
    phone,
    reasons: { loggedOut: 401, forbidden: 403, multideviceMismatch: 411, connectionReplaced: 440, badSession: 500, restartRequired: 515 },
    log: { info: (...args) => logs.push(JSON.stringify(args)), error: (...args) => logs.push(JSON.stringify(args)) },
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
    makeSocket(state) {
      const sock = {
        ev: new EventEmitter(),
        state,
        ws: Object.assign(new EventEmitter(), { isOpen: false }),
        ended: 0,
        requests: 0,
        end() { this.ended++; this.ws.isOpen = false; },
        async requestPairingCode(number) {
          assert.equal(number, phone);
          this.requests++;
          this.state.creds.me = { id: phone };
          this.state.creds.pairingCode = code;
          this.ev.emit('creds.update');
          return requestCode();
        }
      };
      sockets.push(sock);
      return sock;
    },
    onMessages: (sock, event) => messages.push(event)
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
  assert.equal(http('/health').result.whatsappConnected, false);
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
  for (const [index, delay] of [1000, 3000, 10000].entries()) {
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
  assert.equal(http('/health').result.whatsappConnected, true);
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
  await advance(3000);
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
