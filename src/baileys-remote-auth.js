import { BufferJSON, initAuthCreds, proto } from '@whiskeysockets/baileys';
import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const LEASE_MS = 45_000;
const RENEW_MS = 15_000;
const REQUEST_MS = 5_000;
const RENEW = "if redis.call('GET',KEYS[1]) ~= ARGV[1] then return 0 end return redis.call('PEXPIRE',KEYS[1],ARGV[2])";
const RELEASE = "if redis.call('GET',KEYS[1]) ~= ARGV[1] then return 0 end return redis.call('DEL',KEYS[1])";
const WRITE = [
  "if redis.call('GET',KEYS[1]) ~= ARGV[1] then return 0 end",
  'for i=2,#ARGV,2 do',
  "if ARGV[i+1] == '-' then redis.call('HDEL',KEYS[2],ARGV[i])",
  "else redis.call('HSET',KEYS[2],ARGV[i],ARGV[i+1]) end end",
  'return 1'
].join(' ');

function failure(reason) {
  return Object.assign(new Error(reason), { authReason: reason });
}

function settings(env) {
  const url = env.BAILEYS_AUTH_REDIS_URL;
  const token = env.BAILEYS_AUTH_REDIS_TOKEN?.trim();
  const rawKey = env.BAILEYS_AUTH_ENCRYPTION_KEY?.trim() || '';
  const key = Buffer.from(rawKey, 'base64');
  const session = env.BAILEYS_AUTH_SESSION_ID || 'shelby';
  if (!url && !token && !rawKey && env.BAILEYS_AUTH_MIGRATE_LOCAL !== '1') return null;
  let endpoint;
  try { endpoint = new URL(url); } catch { throw failure('auth_configuration_invalid'); }
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash ||
      endpoint.pathname !== '/' || !token || key.length !== 32 || key.toString('base64') !== rawKey ||
      !/^[A-Za-z0-9_-]{1,64}$/.test(session)) {
    throw failure('auth_configuration_invalid');
  }
  return { url: endpoint.href, token, key, session, migrate: env.BAILEYS_AUTH_MIGRATE_LOCAL === '1' };
}

export function createRemoteAuthLoader({ env = process.env, authDir, fetchImpl = fetch } = {}) {
  const options = settings(env);
  if (!options) return null;
  return () => openRemoteAuth({
    ...options, authDir,
    async command(args) {
      try {
        const response = await fetchImpl(options.url, {
          method: 'POST', redirect: 'error',
          headers: { authorization: `Bearer ${options.token}`, 'content-type': 'application/json' },
          body: JSON.stringify(args), signal: AbortSignal.timeout(REQUEST_MS)
        });
        if (!response.ok) throw new Error();
        const payload = await response.json();
        if (payload.error || !Object.hasOwn(payload, 'result')) throw new Error();
        return payload.result;
      } catch {
        throw failure('auth_storage_unavailable');
      }
    }
  });
}

function keyFile(type, id) {
  // Match Baileys 6.7.24's file naming when importing an existing directory.
  return `${type}-${id}.json`.replace(/\//g, '__').replace(/:/g, '-');
}

function usableCreds(creds) {
  return Boolean(creds?.account && typeof creds.me?.id === 'string' &&
    Buffer.isBuffer(creds.noiseKey?.private) && Buffer.isBuffer(creds.signedIdentityKey?.private));
}

export async function openRemoteAuth({
  command, key, session, migrate = false, authDir, renewMs = RENEW_MS
}) {
  const prefix = `shelby:auth:{${session}}`;
  const lease = prefix + ':lease';
  const hash = prefix + ':state';
  const owner = randomBytes(24).toString('hex');
  const fieldKey = hkdfSync('sha256', key, '', 'shelby-auth-fields-v1', 32);
  const field = name => createHmac('sha256', fieldKey).update(name).digest('hex');
  // The fixed marker lets wrong keys fail closed even though Signal field names are keyed hashes.
  const credentialField = 'credentials-v1';
  const values = new Map();
  const pending = new Map();
  let revoked = false;
  let sealed = false;
  let tail = Promise.resolve();
  let timer;
  let notify;
  let releaseTask;

  function encrypt(id, value) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(`${hash}:${id}`));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value, BufferJSON.replacer), 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64');
  }

  function decrypt(id, value) {
    try {
      const data = Buffer.from(value, 'base64');
      const cipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12));
      cipher.setAAD(Buffer.from(`${hash}:${id}`));
      cipher.setAuthTag(data.subarray(12, 28));
      return JSON.parse(Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]), BufferJSON.reviver);
    } catch {
      throw failure('auth_data_invalid');
    }
  }

  function loseOwnership(error) {
    if (revoked) return;
    revoked = true;
    clearInterval(timer);
    notify?.(error.authReason || 'auth_storage_unavailable');
  }

  async function write(changes) {
    if (revoked) throw failure('auth_storage_unavailable');
    const fields = [...changes].flatMap(([id, value]) => [id, value ?? '-']);
    const confirmed = await command(['EVAL', WRITE, 2, lease, hash, owner, ...fields]);
    if (confirmed !== 1) throw failure('auth_lease_lost');
    for (const [id, value] of changes) {
      if (value === null) values.delete(id);
      else values.set(id, value);
    }
  }

  async function importLocal() {
    const files = await readdir(authDir, { withFileTypes: true });
    const records = new Map();
    for (const file of files) {
      if (!file.isFile() || !file.name.endsWith('.json')) continue;
      const record = JSON.parse(await readFile(path.join(authDir, file.name), 'utf8'), BufferJSON.reviver);
      if (file.name === 'creds.json') {
        if (!usableCreds(record)) throw failure('auth_migration_failed');
        delete record.pairingCode;
        records.set(credentialField, encrypt(credentialField, record));
      } else {
        const id = field(file.name);
        records.set(id, encrypt(id, record));
      }
    }
    if (!records.has(credentialField)) throw failure('auth_migration_failed');
    // Import all credentials and keys in a single fenced write.
    await write(records);
  }

  const result = await command(['SET', lease, owner, 'NX', 'PX', LEASE_MS]);
  if (result !== 'OK') throw failure('auth_storage_busy');
  try {
    const stored = await command(['HGETALL', hash]);
    if (!stored || typeof stored !== 'object' || (Array.isArray(stored) && stored.length % 2)) {
      throw failure('auth_data_invalid');
    }
    const entries = Array.isArray(stored)
      ? Array.from({ length: stored.length / 2 }, (_, i) => [stored[2 * i], stored[2 * i + 1]])
      : Object.entries(stored);
    for (const [id, value] of entries) {
      if (typeof id !== 'string' || typeof value !== 'string' ||
          (id !== credentialField && !/^[a-f0-9]{64}$/.test(id))) throw failure('auth_data_invalid');
      values.set(id, value);
    }
    if (!values.size && migrate) {
      try { await importLocal(); } catch { throw failure('auth_migration_failed'); }
    }
    if (values.size && !values.has(credentialField)) throw failure('auth_data_invalid');
    // Verify all rows before opening WhatsApp, including rows not yet used by Baileys.
    let creds;
    for (const [id, value] of values) {
      const decoded = decrypt(id, value);
      if (id === credentialField) creds = decoded;
    }
    if (values.size && !usableCreds(creds)) throw failure('auth_data_invalid');
    creds ??= initAuthCreds();
    // Startup/import may take time. Confirm ownership again before opening the socket.
    if (await command(['EVAL', RENEW, 1, lease, owner, LEASE_MS]) !== 1) throw failure('auth_lease_lost');

    function enqueue(operation) {
      if (sealed || revoked) return Promise.reject(failure('auth_storage_unavailable'));
      const next = tail.then(operation);
      tail = next.catch(loseOwnership);
      return next;
    }

    function persist(changes) {
      // Pairing generates provisional keys. Keep them in memory until pair-success.
      if (!usableCreds(creds)) {
        for (const [id, value] of changes) pending.set(id, value);
        return;
      }
      const snapshot = { ...creds };
      delete snapshot.pairingCode;
      const update = new Map([...pending, ...changes, [credentialField, encrypt(credentialField, snapshot)]]);
      return write(update).then(() => pending.clear());
    }

    // Keep lease renewal independent of writes, so a busy Signal queue cannot starve it.
    let renewing = false;
    timer = setInterval(async () => {
      if (renewing || sealed) return;
      renewing = true;
      try {
        if (await command(['EVAL', RENEW, 1, lease, owner, LEASE_MS]) !== 1) throw failure('auth_lease_lost');
      } catch (error) {
        if (!sealed) loseOwnership(error);
      } finally {
        renewing = false;
      }
    }, renewMs);
    timer.unref?.();

    return {
      state: {
        creds,
        keys: {
          async get(type, ids) {
            await tail;
            if (revoked || sealed) throw failure('auth_storage_unavailable');
            const data = Object.create(null);
            for (const name of ids) {
              const id = field(keyFile(type, name));
              const value = pending.has(id) ? pending.get(id) : values.get(id);
              if (!value) continue;
              const decoded = decrypt(id, value);
              data[name] = type === 'app-state-sync-key' ? proto.Message.AppStateSyncKeyData.fromObject(decoded) : decoded;
            }
            return data;
          },
          set(data) {
            return enqueue(() => {
              const changes = new Map();
              for (const [type, records] of Object.entries(data)) {
                for (const [name, value] of Object.entries(records)) {
                  const id = field(keyFile(type, name));
                  changes.set(id, value == null ? null : encrypt(id, value));
                }
              }
              return persist(changes);
            });
          }
        }
      },
      saveCreds: () => enqueue(() => persist(new Map())),
      onFailure(listener) {
        notify = listener;
        if (revoked) notify('auth_storage_unavailable');
      },
      release() {
        if (releaseTask) return releaseTask;
        sealed = true;
        clearInterval(timer);
        releaseTask = tail.then(() => command(['EVAL', RELEASE, 1, lease, owner])).catch(() => {});
        return releaseTask;
      }
    };
  } catch (error) {
    await command(['EVAL', RELEASE, 1, lease, owner]).catch(() => {});
    throw error;
  }
}
