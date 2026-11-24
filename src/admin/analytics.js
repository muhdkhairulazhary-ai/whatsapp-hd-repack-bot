import { createHmac, randomUUID } from 'node:crypto';

const DAY = 86_400_000;
const RETENTION = 30 * DAY;
const MAX_HISTORY = 500;
const MAX_USERS = 1000;
const TTL = 31 * 86_400;

const WRITE = `
local id, stamp, cutoff, ttl = ARGV[2], tonumber(ARGV[3]), ARGV[4], ARGV[5]
local user, result, kind, method, duration = ARGV[6], ARGV[7], ARGV[8], ARGV[9], ARGV[10]
local daily, seen, history, users, meta = KEYS[1], KEYS[2], KEYS[3], KEYS[4], KEYS[5]
if redis.call('HEXISTS', seen, id) == 1 then return 0 end
if redis.call('HLEN', seen) >= 4096 then return -1 end
redis.call('HSET', seen, id, 1)
redis.call('HINCRBY', daily, 'total', 1)
redis.call('HINCRBY', daily, result, 1)
redis.call('HINCRBY', daily, 'duration', duration)
if result == 'success' and kind == 'video' then
  redis.call('HINCRBY', daily, 'videos', 1)
  if method ~= 'unknown' then redis.call('HINCRBY', daily, method, 1) end
  local last = tonumber(redis.call('HGET', meta, 'delivery') or '0')
  if stamp > last then redis.call('HSET', meta, 'delivery', stamp) end
end
redis.call('HSETNX', meta, 'started', stamp)
redis.call('EXPIRE', daily, ttl)
redis.call('EXPIRE', seen, ttl)
redis.call('ZADD', history, stamp, ARGV[11])
redis.call('ZREMRANGEBYSCORE', history, '-inf', '(' .. cutoff)
local count = redis.call('ZCARD', history)
if count > tonumber(ARGV[12]) then redis.call('ZREMRANGEBYRANK', history, 0, count - tonumber(ARGV[12]) - 1) end
redis.call('EXPIRE', history, ttl)
redis.call('ZADD', users, 'GT', stamp, user)
redis.call('ZREMRANGEBYSCORE', users, '-inf', '(' .. cutoff)
count = redis.call('ZCARD', users)
if count > tonumber(ARGV[13]) then redis.call('ZREMRANGEBYRANK', users, 0, count - tonumber(ARGV[13]) - 1) end
redis.call('EXPIRE', users, ttl)
return 1
`;

const READ = `
local days = {}
for i=4,#KEYS do days[#days+1] = redis.call('HGETALL', KEYS[i]) end
return {redis.call('HGETALL', KEYS[1]),
  redis.call('ZREVRANGEBYSCORE', KEYS[2], '+inf', ARGV[1], 'LIMIT', 0, ARGV[2]),
  redis.call('ZREVRANGEBYSCORE', KEYS[3], '+inf', ARGV[1], 'WITHSCORES', 'LIMIT', 0, ARGV[3]), days}
`;

const dayKey = ms => new Date(ms).toISOString().slice(0, 10);
const counterNames = ['total', 'success', 'failed', 'videos', 'duration', 'copy', 'encode'];
function fields(values, allowed) {
  const pairs = Array.isArray(values) ? Array.from({ length: values.length / 2 }, (_, i) =>
    [values[i * 2], values[i * 2 + 1]]) : Object.entries(values);
  return Object.fromEntries(pairs.filter(([name, value]) => allowed.includes(name) && numeric(Number(value)) !== null)
    .map(([name, value]) => [name, Number(value)]));
}
const numeric = value => Number.isFinite(value) && value >= 0 ? value : null;
const results = new Set(['success', 'failed']);
const methods = new Set(['copy', 'encode', 'unknown']);
const errorCategories = new Set([
  'input_limit', 'duration_limit', 'unsupported_video', 'unsupported_image', 'image_conversion_failed',
  'image_pixel_limit', 'video_memory_budget', 'memory_exhausted', 'disk_full', 'timeout', 'shutdown',
  'cancelled', 'output_limit', 'output_invalid', 'size_quality_limit', 'decoder_unavailable', 'encode_failed',
  'tool_terminated', 'tool_crash', 'tool_start_failed', 'upload_size_rejected',
  'download', 'validation', 'upload', 'processing', 'other'
]);
const stages = new Set(['queued', 'downloading', 'processing', 'copy', 'validating', 'sending', 'image']);

function sanitize(record) {
  return {
    id: /^[a-f0-9-]{36}$/.test(record.id) ? record.id : null,
    user: /^[a-f0-9]{32}$/.test(record.user) ? record.user : null,
    kind: record.kind === 'video' || record.kind === 'image' ? record.kind : 'unknown',
    method: methods.has(record.method) ? record.method : 'unknown',
    result: results.has(record.result) ? record.result : null,
    stage: stages.has(record.stage) ? record.stage : null,
    inputBytes: numeric(record.inputBytes), outputBytes: numeric(record.outputBytes),
    width: numeric(record.width), height: numeric(record.height), fps: numeric(record.fps),
    durationMs: numeric(record.durationMs), finishedAt: numeric(record.finishedAt),
    percent: numeric(record.percent), etaSeconds: numeric(record.etaSeconds), attempt: numeric(record.attempt),
    error: record.error ? (errorCategories.has(record.error) ? record.error : 'other') : null
  };
}

export function createAnalytics({ command, namespace, key, now = Date.now }) {
  const prefix = `shelby:dashboard:{${namespace}}`;
  const meta = prefix + ':meta';
  const history = prefix + ':history';
  const users = prefix + ':users';
  const daily = day => prefix + ':day:' + day;
  let pending = 0;
  let dropped = 0;
  let redis = 'unknown';
  let cached;
  let cacheExpiresAt = 0;
  let readInFlight;
  let readAfter = 0;
  const active = new Map();

  function start(jid, kind, inputBytes) {
    const record = {
      id: randomUUID(), user: createHmac('sha256', key).update(jid).digest('hex').slice(0, 32),
      kind, inputBytes, stage: 'queued', acceptedAt: now()
    };
    active.set(record.id, record);
    return {
      update(patch) {
        if (!active.has(record.id)) return;
        if (patch.stage === 'downloading' && record.beganAt === undefined) record.beganAt = now();
        Object.assign(record, patch);
      },
      finish(result, error) {
        if (!active.delete(record.id) || !results.has(result)) return;
        const stamp = now();
        const day = dayKey(stamp);
        const final = sanitize({ ...record, result, stage: null, error, finishedAt: stamp,
          durationMs: Math.max(0, stamp - (record.beganAt ?? record.acceptedAt)), percent: null, etaSeconds: null });
        if (pending >= 8) { dropped++; return; }
        pending++;
        void Promise.resolve().then(() => command(['EVAL', WRITE, 5, daily(day), prefix + ':seen:' + day,
          history, users, meta, day, final.id, stamp, stamp - RETENTION, TTL,
          final.user, result, final.kind, final.method, final.durationMs, JSON.stringify(final), MAX_HISTORY, MAX_USERS
        ])).then(value => {
          redis = 'available';
          if (value === -1) dropped++;
        }, () => { redis = 'unavailable'; dropped++; }).finally(() => { pending--; });
      },
      discard() { active.delete(record.id); }
    };
  }

  function retainedSnapshot() {
    if (now() >= cacheExpiresAt) cached = undefined;
    return cached;
  }

  async function read() {
    if (readInFlight) return readInFlight;
    if (now() < readAfter) return retainedSnapshot();
    readInFlight = (async () => {
      const stamp = now();
      const dates = Array.from({ length: 30 }, (_, i) => dayKey(stamp - (29 - i) * DAY));
      try {
        const [rawMeta, rawJobs, rawUsers, rawDays] = await command([
          'EVAL', READ, 33, meta, history, users, ...dates.map(daily), stamp - RETENTION, MAX_HISTORY, MAX_USERS
        ]);
        const jobs = rawJobs.flatMap(value => {
          try {
            const record = sanitize(JSON.parse(value));
            return record.id && record.user && record.result &&
              record.finishedAt !== null && record.finishedAt >= stamp - RETENTION && record.finishedAt <= stamp ? [record] : [];
          } catch { return []; }
        });
        const counts = new Map();
        for (const job of jobs) counts.set(job.user, (counts.get(job.user) ?? 0) + 1);
        const people = [];
        for (let i = 0; i + 1 < rawUsers.length; i += 2) {
          const id = rawUsers[i];
          const lastActive = Number(rawUsers[i + 1]);
          if (/^[a-f0-9]{32}$/.test(id) && lastActive >= stamp - RETENTION && lastActive <= stamp) {
            people.push({ id, lastActive, jobs: counts.get(id) ?? 0 });
          }
        }
        const days = rawDays.map((values, i) => ({ date: dates[i], ...fields(values, counterNames) }));
        const totals = Object.fromEntries(counterNames
          .map(field => [field, days.reduce((sum, day) => sum + (day[field] || 0), 0)]));
        const datesMeta = fields(rawMeta, ['started', 'delivery']);
        cached = {
          jobs, people,
          overview: {
            ...totals,
            averageMs: totals.total ? Math.round(totals.duration / totals.total) : null,
            uniqueUsers: people.length,
            activeToday: people.filter(x => dayKey(x.lastActive) === dates.at(-1)).length,
            activeWeek: people.filter(x => x.lastActive >= stamp - 7 * DAY).length,
            startedAt: numeric(datesMeta.started), lastDeliveryAt: numeric(datesMeta.delivery),
            days: days.slice(-7), readAt: stamp
          }
        };
        cacheExpiresAt = Math.min((Math.floor(stamp / DAY) + 1) * DAY,
          ...jobs.map(job => job.finishedAt + RETENTION),
          ...people.map(person => person.lastActive + RETENTION));
        redis = 'available';
      } catch { redis = 'unavailable'; }
      finally { readAfter = now() + 12_000; }
      return retainedSnapshot();
    })().finally(() => { readInFlight = undefined; });
    return readInFlight;
  }

  return { start, read, health: () => ({ redis, dropped }), active: () => [...active.values()].map(record =>
    sanitize({ ...record, durationMs: Math.max(0, now() - (record.beganAt ?? record.acceptedAt)) })) };
}

export function redisCommand(url, token, fetchImpl = fetch) {
  return async args => {
    const response = await fetchImpl(url, {
      method: 'POST', redirect: 'error', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(args), signal: AbortSignal.timeout(3000)
    });
    if (!response.ok) throw new Error('Analytics Redis unavailable');
    const data = await response.json();
    if (data.error || !Object.hasOwn(data, 'result')) throw new Error('Analytics Redis unavailable');
    return data.result;
  };
}
