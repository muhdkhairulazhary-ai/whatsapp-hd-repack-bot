import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { createDeliveryGuard } from '../src/baileys-delivery-guard.js';

const flush = () => new Promise(resolve => setImmediate(resolve));

test('holds active restrictions and 463 without replay, retaining the state across socket replacement', async () => {
  let now = 1000;
  let probes = 0;
  let sends = 0;
  let active = false;
  const timers = new Map();
  const log = { info() {}, warn() {} };
  const guard = createDeliveryGuard({ log, now: () => now, schedule(fn, delay) {
    const key = Symbol();
    timers.set(key, { fn, at: now + delay });
    return key;
  }, cancel: key => timers.delete(key) });
  const advance = async delta => {
    now += delta;
    for (const [key, { fn, at }] of [...timers]) {
      if (at <= now) { timers.delete(key); fn(); }
    }
    await flush();
  };
  const make = () => guard.attach({
    ev: new EventEmitter(), ws: new EventEmitter(),
    async sendMessage() { sends++; },
    async fetchAccountReachoutTimelock() { probes++; return { isActive: active }; }
  });
  const first = make();
  first.ev.emit('connection.update', { connection: 'open' });
  await flush();
  assert.equal(guard.state, 'available');
  await first.sendMessage();
  for (let i = 0; i < 8; i++) first.ws.emit('CB:ack,class:message', { attrs: { error: '463' } });
  assert.equal(timers.size, 1);
  assert.equal(probes, 1);
  await assert.rejects(first.sendMessage(), { code: 'reachout_restricted' });
  active = true;
  await advance(60_000);
  assert.equal(guard.state, 'restricted');
  first.ev.emit('connection.update', { connection: 'close' });
  const next = make();
  next.ev.emit('connection.update', { connection: 'open' });
  await assert.rejects(next.sendMessage(), { code: 'reachout_restricted' });
  active = false;
  await advance(60_000);
  assert.equal(guard.state, 'available');
  assert.equal(sends, 1);
  await next.sendMessage();
  assert.equal(sends, 2);
  await assert.rejects(first.sendMessage(), /no longer current/);
  next.ev.emit('connection.update', { connection: 'close' });
  assert.equal(timers.size, 0);
});
