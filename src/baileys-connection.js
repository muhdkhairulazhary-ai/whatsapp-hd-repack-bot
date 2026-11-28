import { getPairingReference } from './baileys-pairing.js';

// v7 reads WhatsApp's privacy-token feature flags in its init props query.
// Keep history import independent of live-message readiness.
export const liveSocketOptions = Object.freeze({
  fireInitQueries: true,
  shouldSyncHistoryMessage: () => false
});

const CODE_TTL_MS = 60_000;
const CONNECT_DEADLINE_MS = 60_000;
const PHONE_NOTIFICATION_EVENT = 'CB:notification,type:link_code_companion_reg';
const SIGNED_PAIR_EVENT = 'CB:iq,,pair-success';
const MAX_RETRIES = 3;
const MAX_LINKED_NETWORK_RETRIES = 6;
const MAX_STORAGE_RETRIES = 6;
const STARTUP_BUFFER_MS = 30_000;
const MAX_STARTUP_MESSAGES = 32;
const STORAGE_RETRY_REASONS = new Set(['auth_storage_busy', 'auth_storage_unavailable', 'auth_lease_lost',
  'credential_storage_failed']);
const AUTH_FAILURE_REASONS = new Set([...STORAGE_RETRY_REASONS, 'auth_data_invalid', 'auth_migration_failed',
  'auth_configuration_invalid']);

export function createConnectionManager({ loadAuth, makeSocket, requestPairingCode, reasons, phone, log, onMessages,
  now = Date.now, schedule = setTimeout, cancel = clearTimeout }) {
  const terminal = new Set([
    reasons.loggedOut, reasons.forbidden, reasons.connectionReplaced,
    reasons.badSession, reasons.multideviceMismatch
  ].filter(Number.isInteger));
  let active;
  let retryTimer;
  let starting;
  let stopped = false;
  let socketRetries = 0;
  let storageRetries = 0;
  let connected = false;
  let lastConnectedAt = null;
  let recoveryStartedAt = now();
  let confirmedTerminal = false;
  let status = { status: 'connecting' };

  function report(next, reason, statusCode) {
    status = { status: next, ...(reason && { reason }), ...(Number.isInteger(statusCode) && { statusCode }) };
    log.info(status, 'WhatsApp connection state');
  }

  function scheduleRetry(pairing, reason, statusCode, storage = false, linked = false) {
    const retries = storage ? storageRetries : socketRetries;
    if (stopped) return;
    if (retries >= (storage ? MAX_STORAGE_RETRIES : linked ? MAX_LINKED_NETWORK_RETRIES : MAX_RETRIES)) {
      log.warn?.({ reason, attempts: retries }, 'WhatsApp retry budget exhausted');
      return;
    }
    if (storage) storageRetries++;
    else socketRetries++;
    const delay = statusCode !== undefined && statusCode === reasons.restartRequired ? 0 : 1_000 * (2 ** retries);
    report('connecting', reason, statusCode);
    log.info({ reason, delayMs: delay }, 'WhatsApp retry scheduled');
    retryTimer = schedule(() => {
      retryTimer = undefined;
      void start(pairing);
    }, delay);
  }

  function start(pairing = false) {
    if (active || starting || retryTimer || stopped) return;
    starting = connect(pairing).finally(() => { starting = undefined; });
    return starting;
  }

  async function connect(pairing) {
    report('connecting');
    let auth;
    try {
      auth = await loadAuth();
      const { state, saveCreds } = auth;
      if (stopped) {
        await auth.release?.();
        return;
      }
      // requestPairingCode writes a provisional me ID. Only pair-success provides
      // the signed account identity needed to resume an authenticated session.
      if (!state.creds.account) {
        delete state.creds.me;
        delete state.creds.pairingCode;
        state.creds.registered = false;
        if (!pairing || !phone) {
          report(phone ? 'waiting_for_whatsapp' : 'connection_failed', phone ? 'pairing_required' : 'pairing_not_configured');
          await auth.release?.();
          return;
        }
      }

      const restoring = Boolean(state.creds.account);
      if (restoring) log.info({ reason: 'stored_auth_available' }, 'WhatsApp auth restored');
      const sock = makeSocket(state, code => onNotificationError(code));
      let deadline;
      let startupTimer;
      let sawNotify = false;
      const beforeOpen = [];
      let openedAt;
      let transportOpened = sock.ws.isOpen;
      let pairingRequested = false;
      let pairingReference;
      let phoneConfirmationReceived = false;
      let finishAccepted = false;
      let signedPairReceived = false;
      let saves = Promise.resolve();
      let saveFailed = false;
      let closing = false;
      const session = { close, sock };
      let closingTask;
      active = session;
      const isCurrent = () => active === session && !closing;

      function setDeadline(callback, ms) {
        cancel(deadline);
        deadline = schedule(callback, ms);
      }

      function onCreds() {
        if (!isCurrent()) return;
        if (pairingRequested && state.creds.registered && !finishAccepted) {
          finishAccepted = true;
          log.info({ reason: 'pairing_finish_acknowledged' }, 'WhatsApp pairing progress');
          if (!state.creds.account) report('waiting_for_whatsapp', 'pairing_finish_acknowledged');
        }
        if (!state.creds.account) return;
        delete state.creds.pairingCode;
        saves = saves.then(saveCreds).catch(() => {
          saveFailed = true;
          log.error('Could not save WhatsApp credentials');
          void close('credential_storage_failed');
        });
      }

      function dispatchMessages(event) {
        if (!sawNotify && event.type === 'notify' && event.messages?.length) {
          sawNotify = true;
          log.info({ reason: 'first_notify_dispatched', count: event.messages.length }, 'WhatsApp message events active');
        }
        try {
          Promise.resolve(onMessages(sock, event)).catch(() => log.error('WhatsApp message handling failed'));
        } catch {
          log.error('WhatsApp message handling failed');
        }
      }

      function handleMessages(event) {
        if (!isCurrent()) return;
        if (restoring && event.type === 'append' &&
            (openedAt === undefined || now() - openedAt <= STARTUP_BUFFER_MS)) {
          // Baileys labels offline deliveries as append. Accept only messages
          // sent during this recovery window, never a historical sync batch.
          const since = Math.ceil(recoveryStartedAt / 1000);
          const messages = event.messages.filter(message => {
            const timestamp = Number(message.messageTimestamp);
            return message.key?.id && !message.key.fromMe && Number.isSafeInteger(timestamp) && timestamp >= since;
          });
          if (!messages.length) return;
          event = { type: 'notify', messages };
        }
        if (connected) {
          dispatchMessages(event);
        } else if ((restoring || state.creds.account) && event.type === 'notify') {
          const room = MAX_STARTUP_MESSAGES - beforeOpen.length;
          if (room > 0 && event.messages?.length) beforeOpen.push(...event.messages.slice(0, room));
        }
      }

      function checkStartupBuffer() {
        if (!isCurrent() || !connected || !sock.ev.isBuffering?.()) return;
        // Baileys starts buffering restored sessions before WA sends the offline
        // marker. It also normally allows 20 seconds for initial history sync.
        // Without the marker or successful history completion, notify batches
        // can stay buffered even though the authenticated socket is open.
        sock.ev.flush();
        log.info({ reason: 'startup_event_buffer_flushed' }, 'Flushed pending WhatsApp startup events');
      }

      function onTransportOpen() {
        if (!isCurrent()) return;
        transportOpened = true;
        report('waiting_for_whatsapp', 'transport_open');
      }

      function onPhoneConfirmation(node) {
        if (!isCurrent() || !pairingRequested || phoneConfirmationReceived) return;
        const reference = getPairingReference(node);
        if (!pairingReference || !reference || !pairingReference.equals(reference)) {
          void close('pairing_phone_reference_mismatch');
          return;
        }
        phoneConfirmationReceived = true;
        report('waiting_for_whatsapp', 'pairing_phone_notification_received');
        setDeadline(() => void close(finishAccepted ? 'pairing_signed_response_missing' : 'pairing_finish_unconfirmed'),
          CONNECT_DEADLINE_MS);
      }

      function onSignedPair() {
        if (!isCurrent() || !pairingRequested) return;
        signedPairReceived = true;
        log.info({ reason: 'pairing_signed_response_received' }, 'WhatsApp pairing progress');
      }

      function onNotificationError(statusCode) {
        if (!isCurrent() || !phoneConfirmationReceived || finishAccepted) return;
        // Baileys uses this hook for every notification. It does not identify
        // which notification failed, so record it as evidence without aborting.
        log.warn({ reason: 'notification_processing_error_during_pairing', statusCode }, 'WhatsApp pairing diagnostic');
      }

      function close(reason, statusCode, alreadyClosed = false) {
        if (closingTask) return closingTask;
        if (!isCurrent()) return;
        closing = true;
        closingTask = finishClose(reason, statusCode, alreadyClosed);
        return closingTask;
      }

      async function finishClose(reason, statusCode, alreadyClosed) {
        connected = false;
        if (openedAt !== undefined) recoveryStartedAt = now();
        const hadCode = status.status === 'pairing_code_ready';
        if (terminal.has(statusCode)) confirmedTerminal = true;
        const expired = !confirmedTerminal &&
          (reason === 'pairing_phone_notification_missing' || (hadCode && alreadyClosed));
        const waitForManualRetry = expired || reason === 'pairing_hello_rejected' ||
          reason === 'pairing_phone_reference_mismatch' || phoneConfirmationReceived || signedPairReceived;
        cancel(deadline);
        cancel(startupTimer);
        beforeOpen.length = 0;
        sock.ws.off('open', onTransportOpen);
        sock.ws.off(PHONE_NOTIFICATION_EVENT, onPhoneConfirmation);
        sock.ws.off(SIGNED_PAIR_EVENT, onSignedPair);
        sock.ev.off('connection.update', onUpdate);
        sock.ev.off('creds.update', onCreds);
        sock.ev.off('messages.upsert', handleMessages);
        if (!alreadyClosed) sock.end(undefined);
        report(expired ? 'pairing_code_expired' : 'connection_failed', reason, statusCode);

        await saves;
        await auth.release?.();
        active = undefined;
        if (stopped || confirmedTerminal) return;
        if (saveFailed) {
          report('connection_failed', 'credential_storage_failed');
          if (auth.release) scheduleRetry(pairing, 'credential_storage_failed', statusCode, true);
          return;
        }
        if (openedAt !== undefined && now() - openedAt >= 60_000) {
          socketRetries = 0;
          storageRetries = 0;
        }
        if (STORAGE_RETRY_REASONS.has(reason)) {
          scheduleRetry(false, reason, statusCode, true);
          return;
        }
        if (!state.creds.account && waitForManualRetry) return;
        scheduleRetry(pairing, reason, statusCode, false, Boolean(state.creds.account));
      }

      async function onUpdate({ connection, qr, isNewLogin, lastDisconnect, receivedPendingNotifications }) {
        if (!isCurrent()) return;
        if (connection === 'close') {
          const error = lastDisconnect?.error;
          let reason = transportOpened ? 'socket_closed' : 'transport_failed';
          const statusCode = error?.output?.statusCode;
          if (statusCode === reasons.loggedOut) reason = 'logged_out';
          else if (statusCode === reasons.connectionReplaced) reason = 'connection_replaced';
          else if (error?.message === 'QR refs attempts ended') reason = 'qr_refs_exhausted';
          if (!terminal.has(statusCode) && signedPairReceived && !state.creds.account) reason = 'pairing_signed_response_failed';
          else if (phoneConfirmationReceived && !state.creds.account && reason === 'socket_closed') {
            reason = finishAccepted ? 'pairing_closed_after_finish' : 'pairing_closed_during_finish';
          }
          return close(reason, statusCode, true);
        }
        if (receivedPendingNotifications) {
          log.info({ reason: 'offline_notifications_received' }, 'WhatsApp startup sync progress');
        }
        if (connection === 'open') {
          if (connected) return;
          cancel(deadline);
          openedAt = now();
          connected = true;
          lastConnectedAt = Date.now();
          report('already_linked', 'whatsapp_open');
          if (beforeOpen.length) dispatchMessages({ type: 'notify', messages: beforeOpen.splice(0) });
          if (typeof sock.ev.isBuffering === 'function') {
            startupTimer = schedule(checkStartupBuffer, STARTUP_BUFFER_MS);
          }
          return;
        }
        if (isNewLogin) {
          report('connecting', 'link_accepted');
          setDeadline(() => void close('login_deadline'), CONNECT_DEADLINE_MS);
        }
        // In Baileys 6.x this event comes from WhatsApp's pair-device stanza
        // after the Noise handshake. A raw WebSocket open is too early.
        if (!qr || state.creds.account || pairingRequested || !phone) return;
        pairingRequested = true;
        transportOpened = true;
        report('waiting_for_whatsapp', 'registration_challenge_received');
        if (!sock.ws.isOpen) return close('transport_closed_at_challenge');
        try {
          const { code, reference } = await requestPairingCode(sock, phone);
          if (!isCurrent() || connected || state.creds.account || phoneConfirmationReceived) return;
          pairingReference = Buffer.from(reference);
          const expiresAt = now() + CODE_TTL_MS;
          report('pairing_code_ready', 'pairing_hello_acknowledged');
          status = { ...status, code, expiresAt: new Date(expiresAt).toISOString() };
          setDeadline(() => void close('pairing_phone_notification_missing'), CODE_TTL_MS);
        } catch (error) {
          if (!phoneConfirmationReceived) {
            await close(error?.reason || 'pairing_request_failed', error?.statusCode ?? error?.output?.statusCode);
          }
        }
      }

      sock.ws.on('open', onTransportOpen);
      sock.ws.on(PHONE_NOTIFICATION_EVENT, onPhoneConfirmation);
      sock.ws.prependListener(SIGNED_PAIR_EVENT, onSignedPair);
      sock.ev.on('creds.update', onCreds);
      sock.ev.on('connection.update', onUpdate);
      sock.ev.on('messages.upsert', handleMessages);
      setDeadline(() => void close('handshake_deadline'), CONNECT_DEADLINE_MS);
      auth.onFailure?.(reason => { void close(reason); });
    } catch (error) {
      await auth?.release?.();
      const reason = AUTH_FAILURE_REASONS.has(error?.authReason) ? error.authReason : 'socket_start_failed';
      report('connection_failed', reason);
      if (STORAGE_RETRY_REASONS.has(reason)) scheduleRetry(false, reason, undefined, true);
    }
  }

  return {
    start,
    get connected() { return connected; },
    get deliverySocket() { return connected ? active?.sock : undefined; },
    get reason() { return status.reason ?? null; },
    get lastConnectedAt() { return lastConnectedAt; },
    requestPairing(refresh = false) {
      if (status.status === 'pairing_code_ready' && now() >= Date.parse(status.expiresAt)) {
        void active.close('pairing_phone_notification_missing');
      }
      if (!active && !starting && !retryTimer && !stopped && !confirmedTerminal && phone &&
          (status.reason === 'pairing_required' ||
           (refresh && ['connection_failed', 'pairing_code_expired'].includes(status.status)))) {
        socketRetries = 0;
        storageRetries = 0;
        recoveryStartedAt = now();
        void start(true);
      }
      return status;
    },
    async stop() {
      stopped = true;
      cancel(retryTimer);
      await starting;
      await active?.close('shutdown');
    }
  };
}
