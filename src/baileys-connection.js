const CODE_TTL_MS = 60_000;
const CONNECT_DEADLINE_MS = 60_000;
const RETRY_DELAYS_MS = [1_000, 3_000, 10_000];

export function createConnectionManager({ loadAuth, makeSocket, reasons, phone, log, onMessages,
  now = Date.now, schedule = setTimeout, cancel = clearTimeout }) {
  const terminal = new Set([
    reasons.loggedOut, reasons.forbidden, reasons.connectionReplaced,
    reasons.badSession, reasons.multideviceMismatch
  ]);
  let active;
  let retryTimer;
  let starting = false;
  let stopped = false;
  let retries = 0;
  let connected = false;
  let status = { status: 'connecting' };

  function report(next, reason, statusCode) {
    status = { status: next, ...(reason && { reason }), ...(Number.isInteger(statusCode) && { statusCode }) };
    log.info(status, 'WhatsApp connection state');
  }

  async function start(pairing = false) {
    if (active || starting || retryTimer || stopped) return;
    starting = true;
    report('connecting');
    try {
      const { state, saveCreds } = await loadAuth();
      if (stopped) return;
      // requestPairingCode writes a provisional me ID. Only pair-success provides
      // the signed account identity needed to resume an authenticated session.
      if (!state.creds.account) {
        delete state.creds.me;
        delete state.creds.pairingCode;
        state.creds.registered = false;
        if (!pairing || !phone) {
          report(phone ? 'waiting_for_whatsapp' : 'connection_failed', phone ? 'pairing_required' : 'pairing_not_configured');
          return;
        }
      }

      const sock = makeSocket(state);
      let deadline;
      let openedAt;
      let transportOpened = sock.ws.isOpen;
      let pairingRequested = false;
      let saves = Promise.resolve();
      let saveFailed = false;
      let closing = false;
      const session = { close };
      active = session;
      const isCurrent = () => active === session && !closing;

      function setDeadline(callback, ms) {
        cancel(deadline);
        deadline = schedule(callback, ms);
      }

      function onCreds() {
        if (!isCurrent() || !state.creds.account) return;
        delete state.creds.pairingCode;
        saves = saves.then(saveCreds).catch(() => {
          saveFailed = true;
          log.error('Could not save WhatsApp credentials');
          void close('credential_storage_failed');
        });
      }

      function handleMessages(event) {
        if (!isCurrent() || !connected) return;
        Promise.resolve(onMessages(sock, event)).catch(() => log.error('WhatsApp message handling failed'));
      }

      function onTransportOpen() {
        if (!isCurrent()) return;
        transportOpened = true;
        report('waiting_for_whatsapp', 'transport_open');
      }

      async function close(reason, statusCode, alreadyClosed = false) {
        if (!isCurrent()) return;
        closing = true;
        connected = false;
        const hadCode = status.status === 'pairing_code_ready';
        const expired = reason === 'code_expired' || hadCode;
        cancel(deadline);
        sock.ws.off('open', onTransportOpen);
        sock.ev.off('connection.update', onUpdate);
        sock.ev.off('creds.update', onCreds);
        sock.ev.off('messages.upsert', handleMessages);
        if (!alreadyClosed) sock.end(undefined);
        report(expired ? 'pairing_code_expired' : 'connection_failed', reason, statusCode);

        await saves;
        active = undefined;
        if (stopped) return;
        if (saveFailed) {
          report('connection_failed', 'credential_storage_failed');
          return;
        }
        if (terminal.has(statusCode)) {
          report('connection_failed', reason, statusCode);
          return;
        }
        if (!state.creds.account && expired) return;
        if (openedAt !== undefined && now() - openedAt >= 60_000) retries = 0;
        if (retries >= RETRY_DELAYS_MS.length) return;
        const delay = RETRY_DELAYS_MS[retries++];
        report('connecting', reason, statusCode);
        retryTimer = schedule(() => {
          retryTimer = undefined;
          void start(pairing);
        }, statusCode === reasons.restartRequired ? 0 : delay);
      }

      async function onUpdate({ connection, qr, isNewLogin, lastDisconnect }) {
        if (!isCurrent()) return;
        if (connection === 'close') {
          const error = lastDisconnect?.error;
          let reason = transportOpened ? 'socket_closed' : 'transport_failed';
          if (error?.message === 'QR refs attempts ended') reason = 'qr_refs_exhausted';
          return close(reason, error?.output?.statusCode, true);
        }
        if (connection === 'open') {
          cancel(deadline);
          openedAt = now();
          connected = true;
          report('already_linked');
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
          const code = await sock.requestPairingCode(phone);
          if (!isCurrent() || connected || state.creds.account) return;
          const expiresAt = now() + CODE_TTL_MS;
          report('pairing_code_ready');
          status = { ...status, code, expiresAt: new Date(expiresAt).toISOString() };
          setDeadline(() => void close('code_expired'), CODE_TTL_MS);
        } catch (error) {
          await close('pairing_request_failed', error?.output?.statusCode);
        }
      }

      sock.ws.on('open', onTransportOpen);
      sock.ev.on('creds.update', onCreds);
      sock.ev.on('connection.update', onUpdate);
      sock.ev.on('messages.upsert', handleMessages);
      setDeadline(() => void close('handshake_deadline'), CONNECT_DEADLINE_MS);
    } catch {
      report('connection_failed', 'socket_start_failed');
    } finally {
      starting = false;
    }
  }

  return {
    start,
    get connected() { return connected; },
    requestPairing(refresh = false) {
      if (status.status === 'pairing_code_ready' && now() >= Date.parse(status.expiresAt)) {
        void active.close('code_expired');
      }
      if (!active && !starting && !retryTimer && !stopped && phone &&
          (status.reason === 'pairing_required' ||
           (refresh && ['connection_failed', 'pairing_code_expired'].includes(status.status)))) {
        retries = 0;
        void start(true);
      }
      return status;
    },
    async stop() {
      stopped = true;
      cancel(retryTimer);
      await active?.close('shutdown');
    }
  };
}
