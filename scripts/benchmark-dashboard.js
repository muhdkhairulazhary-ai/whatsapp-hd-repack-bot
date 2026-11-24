// Run with --cpus=1 --memory=512m --memory-swap=512m. All traffic and fixtures are local.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { once } from 'node:events';
import { createReadStream } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { promisify } from 'node:util';
import { gzipSync } from 'node:zlib';
import { createAdmin } from '../src/admin/admin.js';
import { createBaileysHandler } from '../src/baileys-http.js';
import { createMessageHandler } from '../src/baileys-media.js';
import { memorySnapshot } from '../src/runtime-diagnostics.js';

const run = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), 'shelby-dashboard-bench-'));
const modes = [
  ['disabled-idle'], ['enabled-idle'], ['idle-poll'], ['redis-unavailable'], ['repeated-requests'],
  ...['1080p30', '1080p60', 'copy'].flatMap(fixture => [['baseline', fixture], ['poll-during-media', fixture]])
];
const fixtures = new Map();
const baselineHashes = new Map();

async function fixture(name, codec, fps) {
  const path = join(root, `${name}.mp4`);
  await run('ffmpeg', ['-v', 'error', '-filter_threads', '1', '-f', 'lavfi', '-i', `testsrc2=size=1920x1080:rate=${fps}`,
    '-f', 'lavfi', '-i', 'sine=frequency=500:sample_rate=48000', '-t', '3', '-c:v', codec, '-threads:v', '1',
    '-preset', 'ultrafast', ...(codec === 'libx265' ? ['-x265-params', 'pools=none:frame-threads=1:log-level=error', '-tag:v', 'hvc1'] : []),
    '-pix_fmt', 'yuv420p', '-c:a', 'aac', path]);
  fixtures.set(name, { path, bytes: (await stat(path)).size });
}

async function measure(mode, name) {
  const stages = {};
  let encodingPoll;
  const polling = ['poll-during-media', 'idle-poll', 'redis-unavailable', 'repeated-requests'].includes(mode);
  const enabled = !['disabled-idle', 'baseline'].includes(mode);
  const origin = 'https://benchmark.example.test';
  let redisCommands = 0;
  const token = randomBytes(32).toString('base64url');
  const admin = enabled ? createAdmin({
    config: { origin, token, key: randomBytes(32).toString('base64url') },
    connection: { connected: false }, media: { snapshot: () => media.snapshot() },
    async command() {
      redisCommands++;
      if (mode === 'redis-unavailable') throw new Error('fixture outage');
      return [[], [], [], Array.from({ length: 30 }, () => [])];
    }
  }) : null;
  const selected = fixtures.get(name);
  const media = createMessageHandler({
    log: { info(fields) { if (fields.elapsedMs !== undefined && fields.stage) stages[fields.stage] = fields.elapsedMs;
      if (polling && !encodingPoll && fields.stage === 'ffprobe') {
        encodingPoll = poll();
        void encodingPoll.catch(() => {});
      } },
      error() { throw new Error('Benchmark media processing failed'); } },
    downloadMediaMessage: async () => createReadStream(selected.path),
    telemetry: admin?.telemetry
  });
  const fallback = createBaileysHandler({}, '');
  const server = http.createServer(async (req, res) => {
    if (!(await admin?.route(req, res))) fallback(req, res);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie;
  if (polling) {
    const login = await fetch(base + '/api/admin/login', {
      method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ token })
    });
    assert.equal(login.status, 200);
    cookie = login.headers.get('set-cookie').split(';')[0];
    await login.arrayBuffer();
  }
  const { rssBytes: idleRss, cgroupBytes: idleCgroup, cgroupLimitBytes } = memorySnapshot();
  let peakRss = idleRss;
  let peakCgroup = idleCgroup;
  const sample = setInterval(() => {
    const memory = memorySnapshot();
    peakRss = Math.max(peakRss, memory.rssBytes);
    if (memory.cgroupBytes != null) peakCgroup = Math.max(peakCgroup ?? 0, memory.cgroupBytes);
  }, 25);
  const latencies = [];
  async function poll() {
    const started = performance.now();
    const response = await fetch(base + '/api/admin/state?view=jobs', { headers: { cookie } });
    assert.equal(response.status, 200);
    const data = await response.json();
    if (mode === 'redis-unavailable') assert.equal(data.redis, 'unavailable');
    latencies.push(performance.now() - started);
  }
  const start = performance.now();
  const cpu = process.cpuUsage();
  let outputBytes;
  let outputHash;
  try {
    if (mode === 'repeated-requests') {
      for (let i = 0; i < 100; i++) await poll();
    } else if (selected) {
      // One poll overlaps FFmpeg startup. The browser normally polls every 12 seconds.
      const job = media({ async sendMessage(jid, payload) {
        if (!payload.video) return { key: { id: 'synthetic', fromMe: true } };
        const data = await readFile(payload.video.url);
        outputBytes = data.length;
        outputHash = createHash('sha256').update(data).digest('hex');
      } }, { type: 'notify', messages: [{ key: { remoteJid: 'benchmark@s.whatsapp.net', id: 'fixture' },
        message: { videoMessage: { fileLength: selected.bytes } } }] });
      assert.equal(media.snapshot().activeJobs, 1);
      await job;
      await encodingPoll;
      assert.ok(outputBytes);
      if (mode === 'baseline') baselineHashes.set(name, outputHash);
      else assert.equal(outputHash, baselineHashes.get(name));
    } else {
      if (polling) await poll();
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    const wallMs = performance.now() - start;
    const usage = process.cpuUsage(cpu);
    console.log(JSON.stringify({ mode, fixture: name, idleRss, idleCgroup, peakRss, peakCgroup, cgroupLimitBytes,
      nodeCpuMs: (usage.user + usage.system) / 1000, wallMs, stages, redisCommands,
      apiMeanMs: latencies.length ? latencies.reduce((sum, value) => sum + value, 0) / latencies.length : null,
      requests: latencies.length, outputBytes, validated: outputBytes ? true : undefined }));
  } finally {
    clearInterval(sample);
    await media.stop();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

try {
  await fixture('1080p30', 'libx265', 30);
  await fixture('1080p60', 'libx265', 60);
  await fixture('copy', 'libx264', 30);
  const assets = new URL('../public/dashboard/', import.meta.url);
  const sizes = await Promise.all((await readdir(assets)).map(async name => gzipSync(await readFile(new URL(name, assets))).length));
  console.log(JSON.stringify({ gzipAssetBytes: sizes.reduce((sum, size) => sum + size, 0) }));
  for (let i = 0; i < 3; i++) {
    for (const [mode, name] of modes) await measure(mode, name);
  }
} finally { await rm(root, { recursive: true, force: true }); }
