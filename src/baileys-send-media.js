import { Agent as HttpsAgent } from 'node:https';
import { getWAUploadToServer } from '@whiskeysockets/baileys';

export async function sendProcessedMedia(sock, jid, { path, width, height, mimetype = 'video/mp4', image = false },
  { signal, privateLogger, messageId } = {}) {
  signal.throwIfAborted();
  const options = { mediaUploadTimeoutMs: 60_000, ...(messageId && { messageId }) };
  let agent;
  const abort = () => agent?.destroy();
  try {
    if (sock.refreshMediaConn) {
      agent = new HttpsAgent({ maxSockets: 1 });
      signal.addEventListener('abort', abort, { once: true });
      const addRequest = agent.addRequest.bind(agent);
      agent.addRequest = (request, options) => {
        if (signal.aborted) request.destroy(new Error('Media upload cancelled'));
        else addRequest(request, options);
      };
      const upload = getWAUploadToServer({ customUploadHosts: [], logger: privateLogger, fetchAgent: agent }, sock.refreshMediaConn);
      options.upload = async (...args) => {
        signal.throwIfAborted();
        const result = await upload(...args);
        signal.throwIfAborted();
        return result;
      };
    }
    return await sock.sendMessage(jid, {
      [image ? 'image' : 'video']: { url: path }, mimetype,
      // The engine already bounded processing. Skip Baileys' media decode.
      jpegThumbnail: Buffer.alloc(0), width, height
    }, options);
  } finally {
    signal.removeEventListener('abort', abort);
    agent?.destroy();
  }
}
