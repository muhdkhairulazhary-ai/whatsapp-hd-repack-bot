import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import { promisify } from 'node:util';
import { repackVideo, runTool } from '../src/ffmpeg.js';
import { createStderrDiagnostics, describeFfmpegInput } from '../src/ffmpeg-diagnostics.js';

const run = promisify(execFile);

test('an advisory unsupported codec line does not turn a mapping error into unsupported_video', async () => {
  const raw = 'Unsupported codec with id 0 for input stream 3\nStream map /private/path?token=secret matches no streams';
  await assert.rejects(runTool('sh', ['-c', 'printf "%s" "$1" >&2; exit 1', 'sh', raw], {
    stage: 'ffmpeg', timeoutMs: 1000
  }), error => {
    assert.equal(error.reason, 'encode_failed');
    assert.deepEqual(error.details.stderrCategories, ['stream_mapping']);
    assert.doesNotMatch(JSON.stringify(error.details), /private|token|secret/);
    return true;
  });
});

test('stderr summaries are fixed categories, bounded, and recognize split decoder messages', () => {
  const diagnostics = createStderrDiagnostics();
  diagnostics.observe(Buffer.from('Decoder (codec none) not'));
  diagnostics.observe(Buffer.from(' found for input stream #0:1\n'));
  diagnostics.observe(Buffer.alloc(50_000, 'x'));
  diagnostics.observe(Buffer.from('error opening encoder for https://host/private?token=value'));
  const result = diagnostics.summary();
  assert.deepEqual(result.stderrCategories, ['decoder_unavailable', 'encoder_options']);
  assert.ok(result.stderrBytes > 50_000);
  assert.ok(JSON.stringify(result).length < 140);
  assert.doesNotMatch(JSON.stringify(result), /https|private|token/);

  const input = describeFfmpegInput({
    video: { codec_name: 'raw-private-text', codec_tag_string: 'dvh1', pix_fmt: 'yuv420p10le', color_transfer: 'smpte2084' },
    audio: null
  }, { videoMode: 'encode' });
  assert.equal(input.videoCodec, 'other_or_unknown');
  assert.equal(input.dolbyVision, true);
  assert.equal(input.colorTransfer, 'smpte2084');
  assert.doesNotMatch(JSON.stringify(input), /raw-private-text/);
});

test('HEVC HLG MOV with an unknown primary audio track retains the timed AAC alternate', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wa-mov-track-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const input = path.join(dir, 'source.mov');
  const output = path.join(dir, 'output.mp4');
  await run('ffmpeg', ['-v', 'error', '-filter_threads', '1',
    '-f', 'lavfi', '-i', 'testsrc2=size=160x96:rate=30',
    '-f', 'lavfi', '-i', 'sine=frequency=400',
    '-itsoffset', '0.18', '-f', 'lavfi', '-i', 'sine=frequency=800',
    '-map', '0:v', '-map', '1:a', '-map', '2:a', '-t', '0.8',
    '-c:v', 'libx265', '-preset', 'ultrafast', '-threads:v', '1',
    '-x265-params', 'pools=none:frame-threads=1:log-level=error',
    '-pix_fmt', 'yuv420p10le', '-color_primaries', 'bt2020', '-color_trc', 'arib-std-b67',
    '-colorspace', 'bt2020nc', '-c:a', 'aac', input]);

  // Mark the first AAC sample description as unrecognized without damaging the
  // MOV structure. This models an unavailable spatial-audio decoder.
  const bytes = await readFile(input);
  const audioTag = bytes.indexOf('mp4a');
  const descriptor = bytes.indexOf('esds', audioTag);
  assert.ok(audioTag > 0 && descriptor > audioTag);
  bytes.write('apac', audioTag);
  bytes.write('free', descriptor);
  await writeFile(input, bytes);
  const probe = async file => {
    const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries',
      'stream=codec_name,codec_type,codec_tag_string,start_time', '-of', 'json', file]);
    return JSON.parse(stdout).streams;
  };
  const [video, primary, alternate] = await probe(input);
  assert.equal(primary.codec_tag_string, 'apac');
  assert.ok(!primary.codec_name || primary.codec_name === 'unknown');
  assert.equal(alternate.codec_name, 'aac');

  const before = performance.now();
  await assert.rejects(runTool('ffmpeg', ['-v', 'error', '-y', '-i', input, '-map', '0:V:0',
    '-map', '0:a:0', '-c:v', 'libx264', '-c:a', 'aac', output], {
    stage: 'ffmpeg', timeoutMs: 5000
  }), error => error.reason === 'decoder_unavailable' && !JSON.stringify(error.details).includes(dir));
  const oldMs = Math.round(performance.now() - before);
  const after = performance.now();
  const result = await repackVideo(input, output, { statusVideo: true, maxOutputBytes: 150_000_000 });
  const newMs = Math.round(performance.now() - after);
  const [encodedVideo, copiedAudio] = await probe(output);
  assert.equal(result.videoMode, 'encode');
  assert.equal(result.audioMode, 'copy');
  assert.equal(result.output.fps, '30/1');
  assert.equal(result.output.width, 160);
  assert.equal(result.output.height, 96);
  assert.ok(Math.abs((Number(alternate.start_time) - Number(video.start_time)) -
    (Number(copiedAudio.start_time) - Number(encodedVideo.start_time))) < 0.01);
  t.diagnostic(`Synthetic audio mapping: first-track path failed in ${oldMs} ms; AAC alternate completed in ${newMs} ms (${result.output.bytes} bytes).`);
});
