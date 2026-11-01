import { stat } from 'node:fs/promises';
import { config } from './config.js';
import { isAllowedMediaUrl } from './security.js';

const graphRoot = () => `https://graph.facebook.com/${config.graphApiVersion}`;
const headers = () => ({ Authorization: `Bearer ${config.whatsappToken}` });

async function graphRequest(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { ...headers(), ...options.headers } });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`WhatsApp API returned HTTP ${response.status}: ${body.slice(0, 500)}`);
  }
  return response;
}

export async function sendText(to, body) {
  const response = await graphRequest(`${graphRoot()}/${config.phoneNumberId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'text', text: { preview_url: false, body } })
  });
  return response.json();
}

export async function getMediaDownloadUrl(mediaId) {
  const response = await graphRequest(`${graphRoot()}/${encodeURIComponent(mediaId)}`);
  const data = await response.json();
  if (!data.url || !isAllowedMediaUrl(data.url)) throw new Error('Meta returned an unexpected media download URL.');
  return data.url;
}

export async function downloadMedia(mediaId, destination, maxBytes) {
  const url = await getMediaDownloadUrl(mediaId);
  const response = await fetch(url, { headers: headers(), redirect: 'error' });
  if (!response.ok || !response.body) throw new Error(`Media download failed (HTTP ${response.status}).`);
  const declaredLength = Number(response.headers.get('content-length') || 0);
  if (declaredLength > maxBytes) throw new Error('That video is larger than the bot input limit.');
  const { createWriteStream } = await import('node:fs');
  const { pipeline } = await import('node:stream/promises');
  let received = 0;
  const limiter = new (await import('node:stream')).Transform({
    transform(chunk, encoding, callback) {
      received += chunk.length;
      if (received > maxBytes) callback(new Error('That video is larger than the bot input limit.'));
      else callback(null, chunk);
    }
  });
  await pipeline(response.body, limiter, createWriteStream(destination, { flags: 'wx', mode: 0o600 }));
  return received;
}

export async function uploadMedia(filePath) {
  const size = (await stat(filePath)).size;
  if (size > config.maxOutputBytes) throw new Error('Processed video is too large to upload.');
  const form = new FormData();
  form.set('messaging_product', 'whatsapp');
  form.set('type', 'video/mp4');
  form.set('file', new Blob([await (await import('node:fs/promises')).readFile(filePath)], { type: 'video/mp4' }), 'repacked.mp4');
  const response = await graphRequest(`${graphRoot()}/${config.phoneNumberId}/media`, { method: 'POST', body: form });
  const data = await response.json();
  if (!data.id) throw new Error('WhatsApp did not return an uploaded media ID.');
  return data.id;
}

export async function sendVideo(to, mediaId) {
  const response = await graphRequest(`${graphRoot()}/${config.phoneNumberId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'video', video: { id: mediaId, caption: '✅ Your video is ready (MP4 / H.264 / AAC).' } })
  });
  return response.json();
}
