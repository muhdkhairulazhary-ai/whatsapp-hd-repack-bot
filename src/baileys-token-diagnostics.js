import { AsyncLocalStorage } from 'node:async_hooks';

const addresses = new Set(['pn', 'lid', 'other']);
const tokenStates = new Set(['fresh', 'expired', 'missing']);
const sources = new Set(['notification', 'recovery', 'outbound']);

export function createTokenDiagnostics(log) {
  const context = new AsyncLocalStorage();
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

  return { native, run: (trace, fn) => context.run(trace, fn) };
}
