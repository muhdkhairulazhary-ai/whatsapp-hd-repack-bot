// Experimental WhatsApp Web transport. Not the official Meta API.
// Run with: node src/baileys-server.js
import 'dotenv/config';
import makeWASocket, { useMultiFileAuthState, DisconnectReason, downloadMediaMessage, Browsers } from '@whiskeysockets/baileys';
import pino from 'pino';
import { mkdir } from 'node:fs/promises';
import http from 'node:http';
import { createMessageHandler } from './baileys-media.js';
import { createConnectionManager } from './baileys-connection.js';
import { createBaileysHandler } from './baileys-http.js';

const log = pino({ level: process.env.LOG_LEVEL || 'info' });
const authDir = process.env.BAILEYS_AUTH_DIR || './baileys-auth';
const phone = (process.env.BAILEYS_PHONE_NUMBER || '').replace(/\D/g, '');
const maxBytes = Number(process.env.MAX_INPUT_BYTES || 16 * 1024 * 1024);
const port = Number(process.env.PORT || 3000);
const pairingToken = process.env.PAIRING_ACCESS_TOKEN || '';
// The library logs protocol payloads and identifiers at several log levels.
const privateLogger = pino({ level: 'silent' });
process.umask(0o077);

const connection = createConnectionManager({
  phone: pairingToken && /^[1-9][0-9]{5,14}$/.test(phone) ? phone : '',
  reasons: DisconnectReason,
  log,
  async loadAuth() {
    await mkdir(authDir, { recursive: true, mode: 0o700 });
    return useMultiFileAuthState(authDir);
  },
  makeSocket: auth => makeWASocket({
    auth,
    browser: Browsers.macOS('Desktop'),
    logger: privateLogger,
    connectTimeoutMs: 30000,
    keepAliveIntervalMs: 30000,
  }),
  onMessages: createMessageHandler({ downloadMediaMessage, maxBytes, log, privateLogger })
});

const server = http.createServer(createBaileysHandler(connection, pairingToken));
server.listen(port, '0.0.0.0', () => log.info({ port }, 'Health server listening'));
void connection.start();

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, () => {
    server.close();
    void connection.stop();
  });
}
