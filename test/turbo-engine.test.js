import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { repackVideo } from '../src/ffmpeg.js';

const run = promisify(execFile);

test('Turbo baseline keeps bounded HEVC settings, audio mapping, and explicit HLG behavior', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wa-turbo-test-'));
  const originalPath = process.env.PATH;
  t.after(async () => {
    process.env.PATH = originalPath;
    await rm(dir, { recursive: true, force: true });
  });
  const { stdout } = await run('sh', ['-c', 'command -v ffmpeg']);
  const ffmpeg = stdout.trim();
  const output = path.join(dir, 'output.mp4');
  const argsFile = path.join(dir, 'command.args');
  await writeFile(path.join(dir, 'ffmpeg'), `#!/bin/sh
printf '%s\\n' "$@" > "${argsFile}"
exec "${ffmpeg}" "$@"
`, { mode: 0o700 });
  process.env.PATH = `${dir}:${originalPath}`;

  for (const hdr of [false, true]) {
    const input = path.join(dir, hdr ? 'hlg.mov' : 'sdr.mov');
    await run(ffmpeg, ['-v', 'error', '-y', '-filter_threads', '1', '-f', 'lavfi', '-i',
      'testsrc2=size=160x96:rate=30', '-itsoffset', '0.16', '-f', 'lavfi', '-i', 'sine=frequency=500',
      '-t', '0.5', '-c:v', 'libx265', '-preset', 'ultrafast', '-threads:v', '1',
      '-x265-params', 'pools=none:frame-threads=1:log-level=error' +
        (hdr ? ':colorprim=bt2020:transfer=arib-std-b67:colormatrix=bt2020nc' : ''),
      '-pix_fmt', hdr ? 'yuv420p10le' : 'yuv420p',
      ...(hdr ? ['-color_trc', 'arib-std-b67', '-color_primaries', 'bt2020', '-colorspace', 'bt2020nc', '-movflags', '+write_colr'] : []),
      '-c:a', 'aac', input]);
    const timings = [];
    const result = await repackVideo(input, output, {
      statusVideo: true, maxOutputBytes: 1_000_000, onProgress() {},
      onStage: fields => timings.push(fields.stage)
    });
    const command = (await readFile(argsFile, 'utf8')).trim().split('\n');
    const value = name => command[command.indexOf(name) + 1];
    assert.equal(value('-threads'), '1');
    assert.equal(value('-threads:v'), '1');
    assert.equal(value('-filter_threads'), '1');
    assert.equal(value('-progress'), 'pipe:3');
    assert.equal(value('-preset'), 'ultrafast');
    assert.equal(value('-c:a'), 'copy');
    assert.equal(value('-map'), '0:0');
    assert.equal(command[command.lastIndexOf('-map') + 1], '0:1');
    assert.ok(!command.includes('-vf'));
    assert.match(value('-maxrate:v'), /^\d+k$/);
    assert.equal(value('-movflags'), '+faststart');
    assert.equal(result.output.fps, '30/1');
    assert.equal(result.output.width, 160);
    assert.equal(result.output.height, 96);
    assert.deepEqual(timings, ['ffprobe', 'ffmpeg', 'verification']);

    const { stdout: probe } = await run('ffprobe', ['-v', 'error', '-show_entries',
      'stream=pix_fmt,color_transfer,start_time', '-of', 'json', output]);
    const [video, audio] = JSON.parse(probe).streams;
    assert.equal(video.pix_fmt, 'yuv420p');
    const { stdout: sourceTransfer } = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=color_transfer', '-of', 'default=nw=1:nk=1', input]);
    assert.equal(sourceTransfer.trim(), hdr ? 'arib-std-b67' : 'unknown');
    if (hdr) assert.ok(video.color_transfer === undefined || video.color_transfer === 'arib-std-b67');
    else assert.equal(video.color_transfer, undefined);
    assert.ok(!command.includes('-color_trc'));
    assert.ok(Math.abs(Number(audio.start_time) - Number(video.start_time) - 0.16) < 0.04);
  }
});
