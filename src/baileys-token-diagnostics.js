import { AsyncLocalStorage } from 'node:async_hooks';

const addresses = new Set(['pn', 'lid', 'other']);
const tokenStates = new Set(['fresh', 'expired', 'missing']);
const sources = new Set(['notification', 'recovery', 'outbound']);

export function createTokenDiagnostics(log) {
  const context = new AsyncLocalStorage();
  const visited = new WeakSet();
  let nextProbeAt = 0;
  const report = (stage, fields) => log.info({ stage, trace: context.getStore(), ...fields }, 'WhatsApp privacy diagnostic');

  function native(fields, message) {
    if (message === 'shelby native token relay' && addresses.has(fields?.address) &&
        tokenStates.has(fields.tokenState) && typeof fields.attached === 'boolean') {
      report('native_lookup', { address: fields.address, tokenState: fields.tokenState, attached: fields.attached });
    } else if (message === 'shelby native alternate token' &&
        (tokenStates.has(fields?.outcome) || ['no_mapping', 'unavailable'].includes(fields?.outcome))) {
      report('alternate_pn_lookup', { outcome: fields.outcome });
    } else if (message === 'shelby native token stored' && addresses.has(fields?.address) &&
        typeof fields.usable === 'boolean') {
      report('token_stored', { address: fields.address, usable: fields.usable });
    } else if (message === 'shelby native token acquisition' && sources.has(fields?.source) &&
        typeof fields.usable === 'boolean') {
      report('token_acquisition', { source: fields.source, usable: fields.usable });
    } else if (message === 'failed 463 token recovery issuance') {
      report('token_acquisition_failed', { source: 'recovery' });
    } else if (message === 'fire-and-forget tctoken issuance failed') {
      report('token_acquisition_failed', { source: 'outbound' });
    } else if (message === 'got history notification' && typeof fields?.process === 'boolean') {
      report('history_notification', { processingEnabled: fields.process });
    }
  }

  async function rejected(sock, trace, statusCode) {
    // rc14 consumes 463 before its generic timelock branch. Use its existing
    // read-only status query at most once per socket and once per minute.
    if (statusCode !== 463 || visited.has(sock) || typeof sock.fetchAccountReachoutTimelock !== 'function' ||
        !sock.ws?.isOpen || Date.now() < nextProbeAt) return;
    visited.add(sock);
    nextProbeAt = Date.now() + 60_000;
    await context.run(trace, async () => {
      try {
        const { isActive } = await sock.fetchAccountReachoutTimelock();
        report('reachout_status', { outcome: typeof isActive === 'boolean' ? (isActive ? 'active' : 'inactive') : 'unavailable' });
      } catch {
        report('reachout_status', { outcome: 'unavailable' });
      }
    });
  }

  return { native, rejected, run: (trace, fn) => context.run(trace, fn) };
}
