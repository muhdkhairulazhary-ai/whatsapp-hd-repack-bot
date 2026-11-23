import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { promisify } from 'node:util';
import { repackVideo } from '../src/ffmpeg.js';
import { createVideoProgress } from '../src/video-progress.js';
import { memorySnapshot } from '../src/runtime-diagnostics.js';

const run = promisify(execFile);
const dir = await mkdtemp(path.join(os.tmpdir(), 'wa-size-bench-'));
const maxOutputBytes = 3_000_000;
try {
  for (const fps of [30, 60]) {
    const input = path.join(dir, 'source.mov');
    await run('ffmpeg', ['-v', 'error', '-y', '-filter_threads', '1',
      '-f', 'lavfi', '-i', `testsrc2=size=1080x1920:rate=${fps}`,
      '-f', 'lavfi', '-i', 'sine=frequency=500', '-t', '3', '-c:v', 'libx265',
      '-threads:v', '1', '-preset', 'ultrafast', '-x265-params', 'pools=none:frame-threads=1:log-level=error',
      '-pix_fmt', 'yuv420p10le', '-tag:v', 'hvc1', '-c:a', 'aac', input]);

    for (const [sizeControl, liveProgress] of [[false, false], [true, false], [true, true]]) {
      const output = path.join(dir, 'output.mp4');
      const memory = memorySnapshot();
      let peakCgroupBytes = memory.cgroupBytes;
      const timer = setInterval(() => {
        const { cgroupBytes } = memorySnapshot();
        if (cgroupBytes !== undefined) peakCgroupBytes = Math.max(peakCgroupBytes ?? 0, cgroupBytes);
      }, 20);
      let result;
      const progress = liveProgress && createVideoProgress({
        title: 'Benchmark', initialStage: 'downloading',
        async send() { return { key: { fromMe: true, id: 'synthetic' } }; },
        onClose() {}, onFailedEdit() {}
      });
      const started = performance.now();
      let elapsedMs;
      try {
        result = await repackVideo(input, output, {
          statusVideo: true, ...(sizeControl && { maxOutputBytes }),
          ...(progress && {
            onVideoStage: fields => fields.stage === 'attempt'
              ? progress.startAttempt(fields) : progress.update(fields.stage),
            onProgress: fields => progress.sample(fields)
          })
        });
      } finally {
        elapsedMs = Math.round(performance.now() - started);
        clearInterval(timer);
        progress?.close?.();
      }
      const { stdout } = await run('ffmpeg', ['-v', 'error', '-threads', '1', '-i', input,
        '-threads', '1', '-i', output, '-filter_complex_threads', '1',
        '-filter_complex', '[0:v]format=yuv420p[ref];[ref][1:v]ssim=stats_file=-', '-an', '-f', 'null', '-']);
      const scores = [...stdout.matchAll(/All:([\d.]+)/g)].map(match => Number(match[1]));
      console.log(JSON.stringify({
        fps, sizeControl, liveProgress, elapsedMs, peakCgroupBytes, cgroupLimitBytes: memory.cgroupLimitBytes,
        outputBytes: result.output.bytes, ssim: Number((scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(5)),
        width: result.output.width, height: result.output.height
      }));
      await rm(output);
    }
  }
} finally {
  await rm(dir, { recursive: true, force: true });
}
