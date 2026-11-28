// Experimental WhatsApp Web transport. Not the official Meta API.
// Run with: node src/baileys-server.js
import 'dotenv/config';
import makeWASocket, { useMultiFileAuthState, DisconnectReason, downloadMediaMessage } from '@whiskeysockets/baileys';
import pino from 'pino';
import { mkdir } from 'node:fs/promises';
import http from 'node:http';
import { createDeliveryGuard } from './baileys-delivery-guard.js';
import { createHdrPreferences } from './shelby-hdr-preferences.js';
import { createAccountStore } from './shelby-accounts.js';
import { branding } from './shelby-commands.js';
import { createTokenDiagnostics } from './baileys-token-diagnostics.js';
import { createMessageHandler } from './baileys-media.js';
import { createConnectionManager, liveSocketOptions } from './baileys-connection.js';
import { createBaileysDiagnosticLogger, pairingBrowser, requestConfirmedPairingCode } from './baileys-pairing.js';
import { createRemoteAuthLoader } from './baileys-remote-auth.js';
import { createShutdown } from './runtime-diagnostics.js';
import { createBaileysHandler } from './baileys-http.js';
import { BridgeConfigError, readBridgeConfig, DELIVERY_PATH } from './studio-bridge.js';
import { createStudioDelivery } from './studio-delivery.js';
import { redisCommand } from './admin/analytics.js';
import { startAdmin } from './admin/admin.js';

const log = pino({ level: process.env.LOG_LEVEL || 'info' });
const authDir = process.env.BAILEYS_AUTH_DIR || './baileys-auth';
const phone = (process.env.BAILEYS_PHONE_NUMBER || '').replace(/\D/g, '');
const port = Number(process.env.PORT || 3000);
const pairingToken = process.env.PAIRING_ACCESS_TOKEN || '';
// The library logs protocol payloads and identifiers at several log levels.
const tokenDiagnostics = process.env.SHELBY_WA_TOKEN_DIAGNOSTICS === '1' ? createTokenDiagnostics(log) : undefined;
const privateLogger = pino({ level: 'silent' });
process.umask(0o077);
const deliveryGuard = createDeliveryGuard({ log });

const admin = startAdmin({
  log,
  connection: {
    get connected() { return connection.connected; },
    get reason() { return connection.reason; },
    get outbound() { return deliveryGuard.state; },
    get lastConnectedAt() { return connection.lastConnectedAt; }
  },
  media: { snapshot: () => onMessages.snapshot() },
  version: process.env.RENDER_GIT_COMMIT
});

const accounts = createAccountStore(process.env.BOT_ACCOUNTS_DIR || './shelby-accounts', createHdrPreferences());
let studio;
try {
  const bridge = readBridgeConfig();
  if (bridge) {
    const { key, origin, redisUrl, redisToken } = bridge;
    const redis = redisCommand(redisUrl, redisToken);
    studio = createStudioDelivery({ key, origin, guard: deliveryGuard, socket: () => connection.deliverySocket, privateLogger,
      reserve: async id => await redis(['SET', 'shelby:studio:delivery:' + id, '1', 'NX', 'EX', 86400]) === 'OK' });
  }
} catch (error) {
  if (error instanceof BridgeConfigError) {
    for (const issue of error.issues) log.warn(issue, 'Studio delivery disabled due to invalid configuration');
  } else {
    log.warn({ reason: 'initialization_failed' }, 'Studio delivery disabled');
  }
}
const onMessages = createMessageHandler({ downloadMediaMessage, log, privateLogger, accounts, deliveryGuard, tokenDiagnostics, studioLink: studio?.link, telemetry: admin?.telemetry });

const loadRemoteAuth = createRemoteAuthLoader({ authDir, log });

const connection = createConnectionManager({
  phone: pairingToken && /^[1-9][0-9]{5,14}$/.test(phone) ? phone : '',
  reasons: DisconnectReason,
  log,
  loadAuth: loadRemoteAuth || (async () => {
    await mkdir(authDir, { recursive: true, mode: 0o700 });
    return useMultiFileAuthState(authDir);
  }),
  requestPairingCode: requestConfirmedPairingCode,
  makeSocket: (auth, onNotificationError) => deliveryGuard.attach(makeWASocket({
    ...liveSocketOptions,
    auth,
    browser: pairingBrowser,
    logger: createBaileysDiagnosticLogger(privateLogger, onNotificationError, (reason, statusCode) => {
      log.warn({ reason, statusCode }, 'WhatsApp startup or message processing failed');
    }, tokenDiagnostics),
    connectTimeoutMs: 30000,
    keepAliveIntervalMs: 30000,
  })),
  onMessages
});

const baseHandler = createBaileysHandler(connection, pairingToken);
const server = http.createServer((req, res) => {
  if (studio && req.url === DELIVERY_PATH) {
    void studio.route(req, res).catch(() => res.destroy());
    return;
  }
  if (!admin || !/^\/(?:dashboard|api\/admin)(?:[/?]|$)/.test(req.url)) return baseHandler(req, res);
  void Promise.resolve().then(() => admin.route(req, res)).then(handled => {
    if (!handled) baseHandler(req, res);
  }).catch(() => {
    if (res.headersSent) return res.destroy();
    res.writeHead(503, { 'Cache-Control': 'no-store' });
    res.end();
  });
});
server.listen(port, '0.0.0.0', () => log.info({ port, bot: branding.fullName }, 'Health server listening'));
void connection.start();

const shutdown = createShutdown({ server, media: { snapshot: onMessages.snapshot, stop: () => Promise.all([onMessages.stop(), studio?.stop()]) }, connection, log });
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => { void shutdown(signal); });
}
