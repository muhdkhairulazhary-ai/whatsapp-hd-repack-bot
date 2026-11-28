import { redisRestUrl } from './redis-rest-url.js';
import { createHmac } from 'node:crypto';
import { redisCommand } from './admin/analytics.js';

// Keep preferences independent of a linked-device session ID and of the auth
// hashes. Keyed pseudonyms keep raw phone and LID addresses out of Redis keys.
export function createHdrPreferences(env = process.env, command) {
  const endpoint = redisRestUrl(env.BAILEYS_AUTH_REDIS_URL);
  if (!endpoint || !env.BAILEYS_AUTH_REDIS_TOKEN || !env.BAILEYS_AUTH_ENCRYPTION_KEY) return;
  const key = Buffer.from(env.BAILEYS_AUTH_ENCRYPTION_KEY.trim(), 'base64');
  const field = jid => 'shelby:preferences:hdr:' + createHmac('sha256', key).update('hdr-v1\0' + jid).digest('hex');
  const run = command ?? redisCommand(endpoint.href, env.BAILEYS_AUTH_REDIS_TOKEN.trim());
  return {
    async get(jid) { return await run(['GET', field(jid)]) === '1'; },
    async set(jid, enabled) { await run(enabled ? ['SET', field(jid), '1'] : ['DEL', field(jid)]); }
  };
}
