// Instrument the exact pinned package without forwarding its protocol payloads.
import { readFileSync, writeFileSync } from 'node:fs';
const root = new URL('../', import.meta.resolve('@whiskeysockets/baileys'));
const pkg = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));
if (pkg.version !== '7.0.0-rc14') throw new Error('Revalidate Baileys diagnostics for this version');

function patch(path, replacements) {
  const target = new URL(path, root);
  let source = readFileSync(target, 'utf8');
  for (const [before, after] of replacements) {
    if (source.includes(after)) continue;
    if (source.split(before).length !== 2) throw new Error('Baileys diagnostic anchor mismatch: ' + path);
    source = source.replace(before, () => after);
  }
  writeFileSync(target, source);
}

patch('lib/Socket/messages-send.js', [
  ['            let tcTokenBuffer = existingTokenEntry?.token;', `            let tcTokenBuffer = existingTokenEntry?.token;
            const diagnosticTokenState = tcTokenBuffer?.length
                ? (isTcTokenExpired(existingTokenEntry.timestamp) ? 'expired' : 'fresh')
                : 'missing';`],
  [`            if (additionalNodes && additionalNodes.length > 0) {`, `            if (is1on1Send && logger.shelbyTokenDiagnostics) {
                logger.debug({
                    address: tcTokenJid.endsWith('@lid') ? 'lid' : tcTokenJid.endsWith('@s.whatsapp.net') ? 'pn' : 'other',
                    tokenState: diagnosticTokenState,
                    attached: Boolean(tcTokenBuffer?.length && sock.serverProps.privacyTokenOn1to1)
                }, 'shelby native token relay');
                if (logger.shelbyTokenDiagnostics && diagnosticTokenState !== 'fresh' && tcTokenJid.endsWith('@lid')) {
                    // Observe the alternate slot only. Never attach its token or change routing.
                    void signalRepository.lidMapping.getPNForLID(tcTokenJid).then(async pn => {
                        if (!pn) {
                            logger.debug({ outcome: 'no_mapping' }, 'shelby native alternate token');
                            return;
                        }
                        const normalized = jidNormalizedUser(pn);
                        const entry = (await authState.keys.get('tctoken', [normalized]))[normalized];
                        logger.debug({
                            outcome: entry?.token?.length
                                ? (isTcTokenExpired(entry.timestamp) ? 'expired' : 'fresh')
                                : 'missing'
                        }, 'shelby native alternate token');
                    }).catch(() => logger.debug({ outcome: 'unavailable' }, 'shelby native alternate token'));
                }
            }
            if (additionalNodes && additionalNodes.length > 0) {`],
  [`                    await storeTcTokensFromIqResult({
                        result,
                        fallbackJid: tcTokenJid,
                        keys: authState.keys,
                        getLIDForPN
                    });`, `                    let usable = false;
                    await storeTcTokensFromIqResult({
                        result,
                        fallbackJid: tcTokenJid,
                        keys: authState.keys,
                        getLIDForPN,
                        onTokenStored: event => {
                            usable ||= event.usable;
                            logger.debug(event, 'shelby native token stored');
                        }
                    });
                    logger.debug({ source: 'outbound', usable }, 'shelby native token acquisition');`]
]);

patch('lib/Utils/tc-token-utils.js', [
  ["        onNewJidStored?.(storageJid);",
    `        onNewJidStored?.(storageJid);
        onTokenStored?.({
            address: storageJid.endsWith('@lid') ? 'lid' : storageJid.endsWith('@s.whatsapp.net') ? 'pn' : 'other',
            usable: Boolean(tokenNode.content.length && !isTcTokenExpired(tokenNode.attrs.t))
        });`],
  ['keys, getLIDForPN, onNewJidStored }) {','keys, getLIDForPN, onNewJidStored, onTokenStored }) {']
]);

patch('lib/Socket/messages-recv.js', [
  [`        await storeTcTokensFromIqResult({
            result: node,
            fallbackJid,
            keys: authState.keys,
            getLIDForPN,
            onNewJidStored: trackTcTokenJid
        });`, `        let usable = false;
        await storeTcTokensFromIqResult({
            result: node,
            fallbackJid,
            keys: authState.keys,
            getLIDForPN,
            onNewJidStored: trackTcTokenJid,
            onTokenStored: event => {
                usable ||= event.usable;
                logger.debug(event, 'shelby native token stored');
            }
        });
        logger.debug({ source: 'notification', usable }, 'shelby native token acquisition');`],
  ["                            const result = await issuePrivacyTokens([issueJid], unixTimestampSeconds());",
    `                            const result = await issuePrivacyTokens([issueJid], unixTimestampSeconds());
                            let usable = false;`],
  [`                                onNewJidStored: trackTcTokenJid
                            });
                            logger.debug({ from: ackFrom }, 'completed 463 token recovery issuance');`, `                                onNewJidStored: trackTcTokenJid,
                                onTokenStored: event => {
                                    usable ||= event.usable;
                                    logger.debug(event, 'shelby native token stored');
                                }
                            });
                            logger.debug({ source: 'recovery', usable }, 'shelby native token acquisition');`]
]);
