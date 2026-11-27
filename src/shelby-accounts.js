import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export function createAccountStore(directory, hdrPreferences) {
  const operations = new Map();
  const keyFor = jid => createHash('sha256').update(jid).digest('hex');

  async function read(key) {
    try {
      return JSON.parse(await readFile(path.join(directory, key + '.json'), 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return { videos: 0, images: 0 };
    }
  }

  function update(jid, change) {
    const key = keyFor(jid);
    const operation = (operations.get(key) || Promise.resolve()).catch(() => {}).then(async () => {
      const account = await read(key);
      const result = change(account);
      if (!result.changed) return result;
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const temporary = path.join(directory, randomUUID() + '.tmp');
      try {
        await writeFile(temporary, JSON.stringify(account), { mode: 0o600, flag: 'wx' });
        await rename(temporary, path.join(directory, key + '.json'));
      } finally {
        await rm(temporary, { force: true });
      }
      return result;
    });
    operations.set(key, operation);
    return operation.finally(() => {
      if (operations.get(key) === operation) operations.delete(key);
    });
  }

  return {
    async get(jid) {
      const key = keyFor(jid);
      await operations.get(key);
      return read(key);
    },
    async getHdr(jid) {
      if (hdrPreferences) return hdrPreferences.get(jid);
      const key = keyFor(jid);
      await operations.get(key);
      return (await read(key)).hdr === true;
    },
    async setHdr(jid, enabled) {
      if (hdrPreferences) return hdrPreferences.set(jid, enabled);
      return update(jid, account => {
        account.hdr = enabled;
        return { changed: true };
      });
    },
    register(jid, name) {
      return update(jid, account => {
        const changed = !account.registeredAt;
        if (changed) {
          account.name = name;
          account.registeredAt = new Date().toISOString();
        }
        return { account, changed };
      });
    },
    record(jid, kind) {
      return update(jid, account => {
        account[kind === 'image' ? 'images' : 'videos']++;
        return { changed: true };
      });
    }
  };
}
