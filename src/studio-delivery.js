import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createCommandReceipts } from './baileys-command-receipts.js';
import { sendProcessedMedia } from './baileys-send-media.js';
import { DELIVERY_PATH, LINK_PATH, jidPattern, linkCodePattern, signedHeaders, verifyEnvelope } from './studio-bridge.js';

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const MAX_BYTES = 150_000_000;
const bad = reason => Object.assign(new Error(reason), { reason });

export function createStudioDelivery({ key, origin, reserve, socket, guard, privateLogger, fetchPeer = fetch,
  root = tmpdir(), send = sendProcessedMedia, maxBytes = MAX_BYTES }) {
  let active;
  let stopped = false;
  let linking = 0;
  const receipts = createCommandReceipts();

  async function link(jid, [code, extra]) {
    if (!jidPattern.test(jid) || !linkCodePattern.test(code) || extra) return 'Gunakan kod pautan daripada Web Studio.';
    if (stopped || linking >= 2) return 'Web Studio sedang sibuk. Cuba lagi.';
    linking++;
    try {
      const response = await fetchPeer(origin + LINK_PATH, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20_000),
        headers: signedHeaders(key, LINK_PATH, { code, jid })
      });
      if (!response.ok) return 'Kod pautan tidak sah atau sudah digunakan. Jana kod baharu di Web Studio.';
      const { confirmation } = await response.json();
      if (!/^[a-f0-9]{8}$/.test(confirmation)) throw new Error();
      return 'Masukkan kod pengesahan ini di Web Studio untuk memautkan chat WhatsApp anda: ' + confirmation;
    } catch {
      return 'Pautan Web Studio tidak tersedia buat sementara waktu. Jana kod baharu jika perlu.';
    } finally { linking--; }
  }

  async function route(req, res) {
    const reply = (status, state, reason) => {
      if (res.destroyed) return;
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', Connection: 'close' });
      res.end(JSON.stringify({ state, reason }));
    };
    if (req.method !== 'POST') return reply(405, 'failed', 'method');
    const data = verifyEnvelope(key, DELIVERY_PATH, req.headers);
    if (!data) return reply(401, 'failed', 'authentication');
    const { id, jid, bytes, sha256, width, height } = data;
    const dimension = v => Number.isSafeInteger(v) && v > 0 && v <= 16384;
    if (!UUID.test(id) || !jidPattern.test(jid) || !/^[a-f0-9]{64}$/.test(sha256) || !dimension(width) || !dimension(height) ||
        !Number.isSafeInteger(bytes) || bytes < 1 || bytes > maxBytes || req.headers['content-length'] !== String(bytes) ||
        req.headers['content-type'] !== 'video/mp4') return reply(400, 'failed', 'invalid_media');
    try {
      // Reserve before checking availability so a rejected signed request
      // cannot be replayed later when the bot returns to service.
      if (!await reserve(id)) return reply(409, 'unconfirmed', 'duplicate');
    } catch {
      return reply(503, 'failed', 'unavailable');
    }
    if (stopped || active) return reply(429, 'failed', 'busy');
    if (guard.blocked || !socket()) return reply(503, 'failed', guard.blocked ? 'restricted' : 'offline');
    const controller = new AbortController();
    const disconnected = () => { if (!res.writableEnded) controller.abort(); };
    res.on('close', disconnected);
    if (res.destroyed) controller.abort();
    const deadline = setTimeout(() => controller.abort(), 145_000);
    deadline.unref();
    active = { controller };
    const task = (async () => {
      let dir;
      let attempted = false;
      let track;
      let cancelReceipt;
      try {
        controller.signal.throwIfAborted();
        dir = await mkdtemp(join(root, 'shelby-studio-delivery-'));
        const file = join(dir, 'video.mp4');
        const hash = createHash('sha256');
        let received = 0;
        await pipeline(req.iterator({ destroyOnReturn: false }), async function* (stream) {
          for await (const chunk of stream) {
            received += chunk.length;
            if (received > bytes) throw bad('integrity');
            hash.update(chunk);
            yield chunk;
          }
        }, createWriteStream(file, { mode: 0o600 }), { signal: controller.signal });
        if (received !== bytes || hash.digest('hex') !== sha256) throw bad('integrity');
        const current = socket();
        if (guard.blocked || !current) return [503, 'failed', guard.blocked ? 'restricted' : 'offline'];
        const receipt = new Promise(resolve => {
          cancelReceipt = () => resolve({ state: 'unconfirmed', reason: 'receipt_missing' });
          track = receipts.track(current, (event, statusCode) => {
            if (['server_acknowledged', 'delivery_receipt'].includes(event)) resolve({ state: 'sent' });
            else if (event === 'server_rejected') resolve({ state: 'failed', reason: statusCode === 463 ? 'restricted' : 'rejected' });
            else cancelReceipt();
          }, 145_000);
        });
        if (!track) return [503, 'failed', 'receipt_unavailable'];
        controller.signal.throwIfAborted();
        controller.signal.addEventListener('abort', cancelReceipt, { once: true });
        attempted = true;
        // Register before sending so an early server ACK can be observed. Always
        // wait for the media sender to release the file before removing it.
        try {
          await send(current, jid, { path: file, width, height }, {
            signal: controller.signal, privateLogger, messageId: track.messageId
          });
        } catch (error) {
          if (error?.code === 'reachout_restricted') return [503, 'failed', 'restricted'];
          cancelReceipt();
        }
        const outcome = await receipt;
        return [outcome.state === 'sent' ? 200 : 502, outcome.state, outcome.reason];
      } catch (error) {
        return [error.reason === 'integrity' ? 422 : 503, attempted ? 'unconfirmed' : 'failed',
          error.reason === 'integrity' ? 'integrity' : 'unavailable'];
      } finally {
        track?.cancel();
        if (cancelReceipt) controller.signal.removeEventListener('abort', cancelReceipt);
        if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    })();
    active.task = task;
    let result;
    try { result = await task; } finally {
      clearTimeout(deadline);
      res.off('close', disconnected);
      active = undefined;
    }
    reply(...result);
  }

  return { route, link, async stop() {
    stopped = true;
    active?.controller.abort();
    receipts.stop();
    await active?.task;
  } };
}
