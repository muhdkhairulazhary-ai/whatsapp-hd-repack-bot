import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import test from 'node:test';
import { createBaileysHandler } from '../src/baileys-http.js';

test('public GET /health returns only HTTP liveness without accessing WhatsApp state', async t => {
  const connection = new Proxy({}, {
    get() { assert.fail('HTTP liveness must not access the connection'); }
  });
  const server = http.createServer(createBaileysHandler(connection, 'private-test-token'));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));

  const base = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(base + '/health');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/json');
  assert.equal(await response.text(), '{"status":"ok"}');

  const pairing = await fetch(base + '/pairing', { method: 'POST' });
  assert.equal(pairing.status, 403);
  await pairing.text();
});
