import { randomBytes } from 'node:crypto';
import {
  aesEncryptCTR, Browsers, bytesToCrockford, derivePairingCodeKey, getBinaryNodeChild, getBinaryNodeChildBuffer,
  getPlatformId, jidEncode, S_WHATSAPP_NET
} from '@whiskeysockets/baileys';

const HELLO_TIMEOUT_MS = 15_000;
export const pairingBrowser = Browsers.macOS('Chrome');

function protocolErrorCode(value) {
  const code = typeof value === 'string' && /^[1-5][0-9]{2}$/.test(value) ? Number(value) : value;
  return Number.isInteger(code) && code >= 100 && code <= 599 ? code : undefined;
}

class PairingHelloError extends Error {
  constructor(reason, statusCode) {
    super(reason);
    this.reason = reason;
    this.statusCode = statusCode;
  }
}

// Baileys 6.7.24's requestPairingCode uses sendNode, which only confirms a
// local write. Keep its companion_hello format and use query to correlate the IQ reply.
export async function requestConfirmedPairingCode(sock, phone) {
  const { creds } = sock.authState;
  const code = bytesToCrockford(randomBytes(5));
  const salt = randomBytes(32);
  const iv = randomBytes(16);
  const key = await derivePairingCodeKey(code, salt);
  const wrappedKey = Buffer.concat([salt, iv, aesEncryptCTR(creds.pairingEphemeralKeyPair.public, key, iv)]);
  creds.pairingCode = code;
  creds.me = { id: jidEncode(phone, 's.whatsapp.net'), name: '~' };

  let reply;
  try {
    reply = await sock.query({
      tag: 'iq',
      attrs: { to: S_WHATSAPP_NET, type: 'set', xmlns: 'md' },
      content: [{
        tag: 'link_code_companion_reg',
        attrs: { jid: creds.me.id, stage: 'companion_hello', should_show_push_notification: 'true' },
        content: [
          { tag: 'link_code_pairing_wrapped_companion_ephemeral_pub', attrs: {}, content: wrappedKey },
          { tag: 'companion_server_auth_key_pub', attrs: {}, content: creds.noiseKey.public },
          { tag: 'companion_platform_id', attrs: {}, content: getPlatformId(pairingBrowser[1]) },
          { tag: 'companion_platform_display', attrs: {}, content: `${pairingBrowser[1]} (${pairingBrowser[0]})` },
          { tag: 'link_code_pairing_nonce', attrs: {}, content: Buffer.from([0]) }
        ]
      }]
    }, HELLO_TIMEOUT_MS);
  } catch (error) {
    // Baileys stores the IQ error code in Boom.data, not output.statusCode.
    const iqCode = protocolErrorCode(error?.data);
    if (iqCode || typeof error?.data === 'number') throw new PairingHelloError('pairing_hello_rejected', iqCode);
    const status = protocolErrorCode(error?.output?.statusCode);
    throw new PairingHelloError(status === 408 ? 'pairing_hello_unconfirmed' : 'pairing_request_failed', status);
  }
  if (reply?.tag === 'iq' && reply.attrs?.type === 'error') {
    throw new PairingHelloError('pairing_hello_rejected', protocolErrorCode(getBinaryNodeChild(reply, 'error')?.attrs?.code));
  }
  if (reply?.tag !== 'iq' || reply.attrs?.type !== 'result') {
    throw new PairingHelloError('pairing_hello_unexpected_reply');
  }
  const reference = getPairingReference(reply);
  if (!reference?.length) throw new PairingHelloError('pairing_hello_reference_missing');
  return { code, reference };
}

export function getPairingReference(node) {
  return getBinaryNodeChildBuffer(getBinaryNodeChild(node, 'link_code_companion_reg'), 'link_code_pairing_ref');
}

export function createBaileysDiagnosticLogger(silentLogger, onNotificationError) {
  // The full Baileys payload, text, stack, and identifiers stay outside app logs.
  const logger = Object.create(silentLogger);
  logger.child = () => logger;
  logger.error = (fields, message) => {
    if (message === "unexpected error in 'handling notification'") {
      onNotificationError(protocolErrorCode(fields?.err?.data) ?? protocolErrorCode(fields?.err?.output?.statusCode));
    }
  };
  return logger;
}
