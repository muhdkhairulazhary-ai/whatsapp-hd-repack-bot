import { generateMessageIDV2, proto } from '@whiskeysockets/baileys';

const MAX_PENDING = 64;
const RECEIPT_WINDOW_MS = 30_000;
const { DELIVERY_ACK, READ, PLAYED } = proto.WebMessageInfo.Status;

export function createCommandReceipts() {
  const sockets = new Map();

  function track(sock, report) {
    if (!sock.ws?.on || !sock.ws?.off || !sock.ev?.on || !sock.ev?.off) return null;
    let socket = sockets.get(sock);
    if (!socket) {
      const pending = new Map();
      const ack = ({ attrs } = {}) => {
        const entry = pending.get(attrs?.id);
        if (!entry) return;
        if (attrs.error) {
          const statusCode = Number(attrs.error);
          entry.finish('server_rejected', Number.isInteger(statusCode) && statusCode >= 100 && statusCode <= 599 ? statusCode : undefined);
        } else if (!entry.acknowledged) {
          entry.acknowledged = true;
          entry.report('server_acknowledged');
        }
      };
      const receipts = updates => {
        for (const { key, update } of updates) {
          if (key?.fromMe && [DELIVERY_ACK, READ, PLAYED].includes(update?.status)) {
            pending.get(key.id)?.finish('delivery_receipt');
          }
        }
      };
      const close = update => {
        if (update && update.connection !== 'close') return;
        sock.ws.off('CB:ack,class:message', ack);
        sock.ev.off('messages.update', receipts);
        sock.ev.off('connection.update', close);
        for (const entry of pending.values()) entry.finish('tracking_closed');
        sockets.delete(sock);
      };
      socket = { pending, close };
      sockets.set(sock, socket);
      sock.ws.on('CB:ack,class:message', ack);
      sock.ev.on('messages.update', receipts);
      sock.ev.on('connection.update', close);
    }
    const { pending } = socket;
    if (pending.size >= MAX_PENDING) return null;
    const messageId = generateMessageIDV2(sock.user?.id);
    function finish(stage, statusCode) {
      if (!pending.delete(messageId)) return;
      clearTimeout(timer);
      if (stage) report(stage, statusCode);
    }
    const timer = setTimeout(() => finish('receipt_window_ended'), RECEIPT_WINDOW_MS);
    timer.unref();
    pending.set(messageId, { finish, report, acknowledged: false });
    return { messageId, cancel: () => finish() };
  }

  return { track, stop: () => { for (const socket of sockets.values()) socket.close(); } };
}
