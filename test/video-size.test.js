import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { repackVideo } from '../src/ffmpeg.js';
import { planHevcSize } from '../src/video-size.js';

const run = promisify(execFile);

test('HEVC bitrate budget includes frame rate, audio, container and VBV headroom', () => {
  const video = { width: 1080, height: 1920, avg_frame_rate: '60/1', bit_rate: '8000000' };
  const budget = { duration: 60, maxBytes: 120_000_000, video, audio: { bit_rate: '256000' } };
  const high = planHevcSize(budget);
  const low = planHevcSize({ ...budget, video: { ...video, avg_frame_rate: '30/1' } });
  assert.ok(high.estimatedBytes <= budget.maxBytes * 0.95);
  assert.ok(high.minimumKbps > low.minimumKbps);
  assert.ok(planHevcSize({ ...budget, maxBytes: 1_000_000 }).videoKbps < high.minimumKbps);
  assert.equal(planHevcSize(budget, 7000).videoKbps, 7000);
  assert.ok(planHevcSize({ ...budget, audio: { bit_rate: '1000000' } }).videoKbps < high.videoKbps);
});

async function fixture(t, { portrait = false } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wa-size-plan-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const input = path.join(dir, 'source.mov');
  const output = path.join(dir, 'output.mp4');
  await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i',
    portrait ? 'testsrc2=size=1080x1920:rate=60' : 'testsrc2=size=160x96:rate=30',
    '-t', portrait ? '1' : '0.5', '-c:v', 'libx265', '-preset', 'ultrafast', '-threads:v', '1',
    '-x265-params', portrait ? 'pools=none:frame-threads=1:log-level=error' : 'pools=none:frame-threads=1:log-level=error:lossless=1', input]);
  return { dir, input, output };
}

test('real 1080p60 HEVC is capped and retains resolution and frame rate', async t => {
  const { input, output } = await fixture(t, { portrait: true });
  const baseline = await repackVideo(input, output, { statusVideo: true });
  const plans = [];
  const maxOutputBytes = 1_800_000;
  const result = await repackVideo(input, output, { statusVideo: true, maxOutputBytes, onSizePlan: plan => plans.push(plan) });
  assert.ok(baseline.output.bytes > maxOutputBytes);
  assert.ok(result.output.bytes <= maxOutputBytes);
  assert.equal(plans.length, 1);
  assert.equal(result.output.width, 1080);
  assert.equal(result.output.height, 1920);
  assert.equal(result.output.fps, '60/1');
});

test('an oversized HEVC encode retries once at a lower bitrate and never retries a cancelled job', async t => {
  const { dir, input, output } = await fixture(t);
  const previousPath = process.env.PATH;
  t.after(() => { process.env.PATH = previousPath; });
  const count = path.join(dir, 'attempts');
  await writeFile(path.join(dir, 'ffmpeg'), `#!/bin/sh
for arg do output="$arg"; done
echo attempt >> "${count}"
truncate -s 350000 "$output"
`, { mode: 0o700 });
  process.env.PATH = `${dir}:${previousPath}`;
  const plans = [];
  await assert.rejects(repackVideo(input, output, {
    statusVideo: true, maxOutputBytes: 300_000, onSizePlan: plan => plans.push(plan)
  }), { reason: 'output_limit' });
  assert.equal(plans.length, 2);
  assert.ok(plans[1].videoKbps < plans[0].videoKbps);
  assert.equal((await readFile(count, 'utf8')).trim().split('\n').length, 2);

  const cancelled = new AbortController();
  await assert.rejects(repackVideo(input, output, {
    statusVideo: true, maxOutputBytes: 300_000, signal: cancelled.signal,
    onStage: stage => { if (stage.stage === 'verification') cancelled.abort(); }
  }), { reason: 'cancelled' });
  assert.equal((await readFile(count, 'utf8')).trim().split('\n').length, 3);
});
