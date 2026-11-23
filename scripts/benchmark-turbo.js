// Synthetic, repeatable experiment. The shim changes only benchmark runs.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { createMessageHandler } from '../src/baileys-media.js';
import { memorySnapshot } from '../src/runtime-diagnostics.js';

const run = promisify(execFile);
const dir = await mkdtemp(path.join(os.tmpdir(), 'wa-turbo-'));
const { stdout: ffmpegPath } = await run('sh', ['-c', 'command -v ffmpeg']);
const ffmpeg = ffmpegPath.trim();
const { stdout: tickRate } = await run('getconf', ['CLK_TCK']);
const originalPath = process.env.PATH;
const candidates = ['current', 'decoder-2', 'encoder-2', 'filter-2', 'fast-bilinear'];
const fixtures = [
  { name: 'smart-copy', fps: 30, seconds: 3, codec: 'libx264', pix: 'yuv420p' },
  { name: 'hevc-8bit-30', fps: 30, seconds: 4, codec: 'libx265', pix: 'yuv420p' },
  { name: 'hevc-8bit-60-motion', fps: 60, seconds: 4, codec: 'libx265', pix: 'yuv420p', motion: true },
  { name: 'hevc-hlg-10bit-60', fps: 60, seconds: 4, codec: 'libx265', pix: 'yuv420p10le', hdr: true },
  { name: 'hevc-longer-30', fps: 30, seconds: 12, codec: 'libx265', pix: 'yuv420p10le' },
  { name: 'guard-4k', width: 3840, height: 2160, fps: 10, seconds: 0.1, codec: 'libx265', pix: 'yuv420p' }
];
const pidFile = path.join(dir, 'ffmpeg.pid');
const argsFile = path.join(dir, 'ffmpeg.args');
const input = path.join(dir, 'input.mov');

const shim = `#!/bin/bash
args=("$@")
printf '%s\\n' "$$" > "$TURBO_PID_FILE"
printf '%s\\n' "$@" > "$TURBO_ARGS_FILE"
case "$TURBO_CANDIDATE" in
  decoder-2|encoder-2|filter-2)
    case "$TURBO_CANDIDATE" in
      decoder-2) flag=-threads ;;
      encoder-2) flag=-threads:v ;;
      filter-2) flag=-filter_threads ;;
    esac
    for ((i=0;i<\${#args[@]}-1;i++)); do
      if [[ "\${args[i]}" == "$flag" ]]; then args[i+1]=2; break; fi
    done ;;
  fast-bilinear) args=(-sws_flags fast_bilinear "\${args[@]}") ;;
esac
exec "$TURBO_FFMPEG" "\${args[@]}"
`;

async function probe(file) {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries',
    'stream=codec_name,width,height,avg_frame_rate,pix_fmt,color_transfer,start_time', '-of', 'json', file]);
  return JSON.parse(stdout).streams;
}

function processCounters() {
  try {
    const pid = readFileSync(pidFile, 'utf8').trim();
    if (!/^\d+$/.test(pid)) return {};
    const status = readFileSync(`/proc/${pid}/status`, 'utf8');
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return {
      rssKiB: Number(/^VmHWM:\s+(\d+)/m.exec(status)?.[1]) || 0,
      cpuMs: (Number(fields[11]) + Number(fields[12])) * 1000 / Number(tickRate)
    };
  } catch {
    return {};
  }
}

async function measure(fixture, candidate, sample, source, size) {
  process.env.TURBO_CANDIDATE = candidate;
  await rm(pidFile, { force: true });
  await rm(argsFile, { force: true });
  const timings = {};
  const errors = [];
  let output;
  let deliveredPath;
  let peakRssKiB = 0;
  let cpuMs = 0;
  let peakCgroupBytes = 0;
  let attempts = 0;
  const timer = setInterval(() => {
    const counters = processCounters();
    peakRssKiB = Math.max(peakRssKiB, counters.rssKiB ?? 0);
    cpuMs = Math.max(cpuMs, counters.cpuMs ?? 0);
    peakCgroupBytes = Math.max(peakCgroupBytes, memorySnapshot().cgroupBytes ?? 0);
  }, 20);
  const handler = createMessageHandler({
    tempRoot: dir, maxOutputBytes: 14_000_000,
    downloadMediaMessage: async () => createReadStream(input),
    log: {
      info(fields, message) {
        if (message === 'Media stage timing' || message === 'Media job timing') {
          timings[fields.stage] = (timings[fields.stage] ?? 0) + fields.elapsedMs;
          if (fields.stage === 'ffmpeg') attempts++;
        }
      },
      error(fields) { errors.push(fields.reason); }
    }
  });
  const socket = { async sendMessage(_jid, content) {
    if (content.video) {
      deliveredPath = path.join(dir, 'delivered.mp4');
      const { copyFile } = await import('node:fs/promises');
      await copyFile(content.video.url, deliveredPath);
    }
    return { key: { id: 'synthetic-progress', fromMe: true } };
  } };
  try {
    await handler(socket, { type: 'notify', messages: [{
      key: { remoteJid: '10000000001@s.whatsapp.net', id: 'synthetic' },
      message: { videoMessage: { fileLength: size } }
    }] });
  } finally {
    clearInterval(timer);
    await handler.stop();
  }
  if (fixture.name === 'guard-4k') {
    assert.deepEqual(errors, ['video_memory_budget']);
    assert.equal(attempts, 0);
    return { fixture: fixture.name, candidate, attempts, errors, timings, peakCgroupBytes };
  }
  assert.deepEqual(errors, []);
  assert.ok(deliveredPath);
  const [video, audio] = await probe(deliveredPath);
  const bytes = (await stat(deliveredPath)).size;
  const audioOffset = streams => Number(streams[1].start_time) - Number(streams[0].start_time);
  const syncDeltaMs = Math.round(Math.abs(audioOffset(source) - audioOffset([video, audio])) * 1000);
  assert.equal(video.width, 1080);
  assert.equal(video.height, 1920);
  assert.equal(video.avg_frame_rate, `${fixture.fps}/1`);
  assert.equal(video.pix_fmt, 'yuv420p');
  assert.equal(audio.codec_name, 'aac');
  assert.ok(syncDeltaMs <= 100 && bytes <= 14_000_000);
  let ssim;
  if (sample === 0) {
    const { stdout } = await run(ffmpeg, ['-v', 'error', '-threads', '1', '-i', input, '-threads', '1',
      '-i', deliveredPath, '-filter_complex_threads', '1', '-filter_complex',
      '[0:v]format=yuv420p[ref];[ref][1:v]ssim=stats_file=-', '-an', '-f', 'null', '-']);
    const scores = [...stdout.matchAll(/All:([\d.]+)/g)].map(match => Number(match[1]));
    ssim = Number((scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(6));
  }
  if (fixture.name === 'smart-copy') {
    const args = readFileSync(argsFile, 'utf8');
    assert.match(args, /-c:v\ncopy\n/);
    assert.match(args, /-c:a\ncopy\n/);
  }
  await rm(deliveredPath);
  return {
    fixture: fixture.name, candidate, sample, timings, peakRssKiB, peakCgroupBytes,
    sampledCpuPct: Math.round(cpuMs / timings.ffmpeg * 100),
    speed: +(fixture.seconds * 1000 / timings.ffmpeg).toFixed(2),
    encodeFps: Math.round(fixture.fps * fixture.seconds * 1000 / timings.ffmpeg),
    bytes, ssim, syncDeltaMs, pixelFormat: video.pix_fmt, colorTransfer: video.color_transfer,
    width: video.width, height: video.height, fps: fixture.fps, attempts, validated: true
  };
}

try {
  const { stdout: filters } = await run(ffmpeg, ['-hide_banner', '-filters']);
  console.log(JSON.stringify({ memoryLimit: memorySnapshot().cgroupLimitBytes, vmafAvailable: /libvmaf/.test(filters) }));
  await writeFile(path.join(dir, 'ffmpeg'), shim, { mode: 0o700 });
  Object.assign(process.env, { PATH: `${dir}:${originalPath}`, TURBO_PID_FILE: pidFile,
    TURBO_ARGS_FILE: argsFile, TURBO_FFMPEG: ffmpeg });
  for (const fixture of fixtures) {
    const size = fixture.width ? `${fixture.width}x${fixture.height}` : '1080x1920';
    const video = `testsrc2=size=${size}:rate=${fixture.fps}${fixture.motion ? ',noise=alls=18:allf=t+u:all_seed=123' : ''}`;
    await run(ffmpeg, ['-v', 'error', '-y', '-filter_threads', '1', '-f', 'lavfi', '-i', video,
      '-itsoffset', '0.16', '-f', 'lavfi', '-i', 'sine=frequency=500', '-t', String(fixture.seconds),
      '-c:v', fixture.codec, '-preset', 'ultrafast', '-threads:v', '1', '-pix_fmt', fixture.pix,
      ...(fixture.codec === 'libx265' ? ['-x265-params', 'pools=none:frame-threads=1:log-level=error'] : []),
      ...(fixture.hdr ? ['-color_trc', 'arib-std-b67', '-color_primaries', 'bt2020', '-colorspace', 'bt2020nc'] : []),
      '-c:a', 'aac', input]);
    const source = await probe(input);
    const bytes = (await stat(input)).size;
    const count = fixture.name === 'guard-4k' ? 1 : 3;
    const list = fixture.name === 'guard-4k' || fixture.name === 'smart-copy' ? ['current'] : candidates;
    for (let sample = 0; sample < count; sample++) {
      for (const candidate of [...list.slice(sample % list.length), ...list.slice(0, sample % list.length)]) {
        console.log(JSON.stringify(await measure(fixture, candidate, sample, source, bytes)));
      }
    }
  }
} finally {
  process.env.PATH = originalPath;
  await rm(dir, { recursive: true, force: true });
}
