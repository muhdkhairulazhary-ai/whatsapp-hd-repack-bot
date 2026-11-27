const PROBE_INTERVAL = 60_000;

export function createDeliveryGuard({ log, now = Date.now, schedule = setTimeout, cancel = clearTimeout }) {
  let state = 'unknown';
  let socket;
  let pending;
  let nextProbe = 0;
  let rejectedUntil = 0;
  let timer;

  function report(next) {
    if (state === next) return;
    state = next;
    log.info?.({ state }, 'WhatsApp outbound delivery state');
  }

  function arm() {
    if (!socket || timer || !['checking', 'rejected', 'restricted', 'cooldown'].includes(state)) return;
    timer = schedule(() => {
      timer = undefined;
      void check();
    }, Math.max(0, nextProbe - now()));
    timer.unref?.();
  }

  async function check() {
    if (!socket || typeof socket.fetchAccountReachoutTimelock !== 'function') return;
    if (pending || now() < nextProbe) { if (!pending) arm(); return; }
    const current = socket;
    nextProbe = now() + PROBE_INTERVAL;
    pending = current;
    try {
      const result = await current.fetchAccountReachoutTimelock();
      if (socket === current) {
        if (typeof result?.isActive !== 'boolean') throw new Error('Invalid reachout status');
        observe(result);
      }
    } catch {
      if (socket === current && state === 'checking') report('unknown');
      log.warn?.({ reason: 'reachout_status_unavailable' }, 'WhatsApp outbound status check failed');
    } finally {
      if (pending === current) pending = undefined;
      arm();
    }
  }

  function observe(result) {
    if (result?.isActive === true) report('restricted');
    if (result?.isActive === false) {
      // A 463 can also be a token failure. Hold new sends until the cooldown,
      // and never replay the rejected message.
      report(now() < rejectedUntil ? 'cooldown' : 'available');
    }
    arm();
  }

  const guard = {
    get state() { return state; },
    get blocked() { return !['available', 'unknown'].includes(state); },
    attach(sock) {
      const send = sock.sendMessage.bind(sock);
      sock.sendMessage = (...args) => {
        if (guard.blocked) {
          const error = new Error('Outbound WhatsApp delivery is suspended.');
          error.code = 'reachout_restricted';
          return Promise.reject(error);
        }
        if (socket !== sock) return Promise.reject(new Error('WhatsApp socket is no longer current.'));
        return send(...args);
      };
      const ack = ({ attrs } = {}) => {
        if (socket !== sock || String(attrs?.error) !== '463') return;
        if (state !== 'restricted' && now() >= rejectedUntil) {
          rejectedUntil = now() + PROBE_INTERVAL;
          report('rejected');
        }
        void check();
      };
      const update = ({ connection, reachoutTimeLock }) => {
        if (connection === 'open') {
          socket = sock;
          if (typeof sock.fetchAccountReachoutTimelock === 'function' && !guard.blocked) report('checking');
          void check();
        }
        if (socket === sock && reachoutTimeLock) observe(reachoutTimeLock);
        if (connection === 'close') {
          sock.ws.off('CB:ack,class:message', ack);
          sock.ev.off('connection.update', update);
          if (socket === sock) {
            socket = undefined;
            cancel(timer);
            timer = undefined;
            if (state === 'checking') nextProbe = 0;
          }
        }
      };
      sock.ws.on('CB:ack,class:message', ack);
      sock.ev.on('connection.update', update);
      return sock;
    }
  };
  return guard;
}
