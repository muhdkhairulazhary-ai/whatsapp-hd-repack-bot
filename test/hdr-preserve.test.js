import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { repackVideo } from '../src/ffmpeg.js';
import { createAccountStore } from '../src/shelby-accounts.js';
import { createHdrPreferences } from '../src/shelby-hdr-preferences.js';
import { commandReply } from '../src/shelby-commands.js';

const exec = promisify(execFile);
async function fixture(t, transfer) {
  const dir = await mkdtemp(join(tmpdir(), 'shelby-hdr-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'orig.mov');
  const input = join(dir, 'rotated.mov');
  const params = `pools=none:frame-threads=1:log-level=error:colorprim=bt2020:transfer=${transfer}:colormatrix=bt2020nc:master-display=G(8500,39850)B(6550,2300)R(35400,14600)WP(15635,16450)L(10000000,1):max-cll=1000,400`;
  await exec('ffmpeg', ['-v', 'error', '-filter_threads', '1', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=30000/1001',
    '-f', 'lavfi', '-i', 'sine=frequency=500', '-t', '0.7', '-c:v', 'libx265', '-threads:v', '1',
    '-pix_fmt', 'yuv420p10le', '-x265-params', params, '-color_primaries', 'bt2020',
    '-color_trc', transfer, '-colorspace', 'bt2020nc', '-tag:v', 'hvc1', '-c:a', 'aac', '-movflags', '+write_colr', path]);
  const { stdout: help } = await exec('ffmpeg', ['-hide_banner', '-h', 'full'], { maxBuffer: 8 * 1024 ** 2 });
  const displayRotation = help.includes('-display_rotation');
  await exec('ffmpeg', ['-v', 'error', ...(displayRotation ? ['-display_rotation', '90'] : []), '-i', path, '-c', 'copy',
    ...(!displayRotation ? ['-metadata:s:v:0', 'rotate=90'] : []), '-movflags', '+write_colr', input]);
  return { input, output: join(dir, 'output.mp4'), dir };
}

for (const transfer of ['arib-std-b67', 'smpte2084']) {
  test(`copies ${transfer} packets, color, orientation and timing without transcode headroom`, async t => {
    const { input, output } = await fixture(t, transfer);
    const result = await repackVideo(input, output, {
      statusVideo: true, preserveHdr: true,
      readMemory() { assert.fail('HDR remux must never enter the encoding memory guard'); }
    });
    assert.equal(result.hdrPreserved, true);
    assert.equal(result.videoMode, 'copy');
    assert.equal(result.audioMode, 'copy');
    assert.equal(result.output.width, 90);
    assert.equal(result.output.height, 160);
    assert.equal(result.output.fps, '30000/1001');
    const { stdout } = await exec('ffprobe', ['-v', 'error', '-select_streams', 'v', '-read_intervals', '%+0.3',
      '-show_frames', '-show_entries', 'frame=color_transfer:frame_side_data=side_data_type', '-of', 'json', output]);
    const frames = JSON.parse(stdout).frames;
    assert.ok(frames.some(frame => frame.color_transfer === transfer));
    assert.ok(frames.some(frame => frame.side_data_list?.some(data => /Mastering display/i.test(data.side_data_type))));
    assert.ok(frames.some(frame => frame.side_data_list?.some(data => /Content light/i.test(data.side_data_type))));
  });
}

test('rejects an over-budget HDR remux without starting an encode retry', async t => {
  const { input, output } = await fixture(t, 'smpte2084');
  const attempts = [];
  await assert.rejects(repackVideo(input, output, { statusVideo: true, preserveHdr: true, maxOutputBytes: 100,
    onVideoStage(info) { if (info.stage === 'attempt') attempts.push(info.videoMode); }
  }), { reason: 'output_limit' });
  assert.deepEqual(attempts, ['copy']);
});

test('HDR is off by default and preferences survive reopened account stores without affecting registration', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'shelby-hdr-pref-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const user = '15550000111@s.whatsapp.net';
  const properties = new Map();
  const env = { BAILEYS_AUTH_REDIS_URL: 'https://redis.example.test', BAILEYS_AUTH_REDIS_TOKEN: 'fixture',
    BAILEYS_AUTH_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64') };
  const command = async ([verb, key, value]) => {
    assert.match(key, /^shelby:preferences:hdr:[a-f0-9]{64}$/);
    if (verb === 'SET') return properties.set(key, value);
    if (verb === 'DEL') return properties.delete(key);
    return properties.get(key);
  };
  let accounts = createAccountStore(dir, createHdrPreferences(env, command));
  assert.equal(await accounts.getHdr(user), false);
  await accounts.register(user, 'Fixture');
  assert.match(await commandReply('.hdr on', user, accounts), /WhatsApp Status mungkin/);
  accounts = createAccountStore(dir, createHdrPreferences({ ...env, BAILEYS_AUTH_SESSION_ID: 'new-label' }, command));
  assert.equal(await accounts.getHdr(user), true);
  assert.equal((await accounts.get(user)).name, 'Fixture');
  assert.equal(await accounts.getHdr('555@lid'), false);
  await commandReply('.hdr off', user, accounts);
  assert.equal(await createAccountStore(dir, createHdrPreferences(env, command)).getHdr(user), false);
});

test('a registered SDR user can enable HDR without changing the H.264 Smart Copy path', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'shelby-hdr-sdr-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const input = join(dir, 'input.mp4');
  await exec('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=25',
    '-t', '0.4', '-c:v', 'libx264', '-threads:v', '1', '-pix_fmt', 'yuv420p', input]);
  const user = '555@lid';
  const accounts = createAccountStore(dir);
  await accounts.register(user, 'Fixture');
  await accounts.setHdr(user, true);
  const reopened = createAccountStore(dir);
  const result = await repackVideo(input, join(dir, 'output.mp4'), {
    statusVideo: true, preserveHdr: await reopened.getHdr(user)
  });
  assert.equal(result.videoMode, 'copy');
  assert.equal(result.hdrPreserved, undefined);
  assert.equal(result.output.videoCodec, 'h264');
  assert.equal(result.output.fps, '25/1');
});

const dolbyFixture = fileURLToPath(new URL('./fixtures/dolby-vision-84.mov', import.meta.url));

test('copies Dolby Vision 8.4 MOV with original AAC, HLG, packet hashes, timing and configuration', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'shelby-dv84-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const output = join(dir, 'output.mp4');
  const result = await repackVideo(dolbyFixture, output, {
    statusVideo: true, preserveHdr: true,
    readMemory() { assert.fail('Dolby Vision Smart Copy may not start an encoder'); }
  });
  assert.equal(result.hdrPreserved, true);
  assert.equal(result.audioMode, 'copy');
  assert.equal(result.videoMode, 'copy');
  assert.equal(result.output.width, 1080);
  assert.equal(result.output.height, 1920);
  assert.equal(result.output.fps, '60/1');
  assert.equal(result.output.videoBitrateBps, result.input.videoBitrateBps);

  const probe = async file => JSON.parse((await exec('ffprobe', ['-v', 'error', '-show_packets',
    '-show_data_hash', 'sha256', '-show_entries',
    'packet=stream_index,pts_time,dts_time,duration_time,data_hash:stream=codec_name,codec_tag_string,profile,sample_rate,channels,color_primaries,color_transfer,color_space:stream_side_data',
    '-of', 'json', file])).stdout);
  const [before, after] = await Promise.all([probe(dolbyFixture), probe(output)]);
  assert.deepEqual(after.streams, before.streams);
  assert.deepEqual(after.packets, before.packets);
  const [video, audio] = after.streams;
  assert.equal(video.codec_tag_string, 'hvc1');
  assert.equal(video.color_transfer, 'arib-std-b67');
  assert.equal(video.color_primaries, 'bt2020');
  assert.equal(video.color_space, 'bt2020nc');
  assert.equal(audio.sample_rate, '44100');
  assert.equal(audio.channels, 2);
  assert.equal(audio.profile, 'LC');
  const record = video.side_data_list.find(data => data.side_data_type === 'DOVI configuration record');
  assert.equal(record.dv_profile, 8);
  assert.equal(record.dv_bl_signal_compatibility_id, 4);
  assert.equal(record.rpu_present_flag, 1);
  assert.equal(record.el_present_flag, 0);
  assert.equal(record.bl_present_flag, 1);

  // Inspect encoded NALs without decoding the 1080p stream. Dolby Vision RPU
  // NALs have HEVC type 62 and must remain unchanged after extracting Annex B.
  const extract = async file => (await exec('ffmpeg', ['-v', 'error', '-i', file, '-map', '0:v:0',
    '-c', 'copy', '-bsf:v', 'hevc_mp4toannexb,filter_units=pass_types=62', '-f', 'hevc', '-'],
  { encoding: 'buffer' })).stdout;
  const expectedRpu = await extract(dolbyFixture);
  assert.ok(expectedRpu.length > 0);
  assert.deepEqual(await extract(output), expectedRpu);
});

test('rejects a Dolby Vision record with the wrong compatibility ID before remuxing', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'shelby-dv84-negative-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bytes = await readFile(dolbyFixture);
  const recordOffset = bytes.indexOf('dvvC');
  assert.ok(recordOffset > 0);
  assert.equal(bytes[recordOffset + 8], 0x40);
  bytes[recordOffset + 8] = 0x10;
  const input = join(dir, 'unsupported.mov');
  await writeFile(input, bytes);
  await assert.rejects(repackVideo(input, join(dir, 'output.mp4'), {
    statusVideo: true, preserveHdr: true,
    onVideoStage() { assert.fail('Unsupported Dolby Vision must never start a remux or fallback'); }
  }), { reason: 'hdr_unsupported' });
});

test('fails verification when the remux keeps packet bytes but drops the Dolby Vision record', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'shelby-dv84-lost-record-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { stdout: realFfmpeg } = await exec('which', ['ffmpeg']);
  // Simulate a muxer that ignores the Dolby Vision option, with real packet
  // copying and probing. Isolate the executable override in the child process.
  await writeFile(join(dir, 'ffmpeg'), `#!/bin/bash
args=()
while (( $# )); do
  if [[ "$1" == "-strict" && "$2" == "unofficial" ]]; then shift 2; continue; fi
  args+=("$1")
  shift
done
exec "$REAL_FFMPEG" "${'\$'}{args[@]}"
`, { mode: 0o700 });
  const run = `
    import assert from 'node:assert/strict';
    import { repackVideo } from './src/ffmpeg.js';
    const attempts = [];
    await assert.rejects(repackVideo(process.argv[1], process.argv[2], {
      statusVideo: true, preserveHdr: true,
      onVideoStage(update) { if (update.stage === 'attempt') attempts.push(update.videoMode); }
    }), { reason: 'hdr_metadata_changed' });
    assert.deepEqual(attempts, ['copy']);
  `;
  await exec(process.execPath, ['--input-type=module', '-e', run, dolbyFixture, join(dir, 'output.mp4')], {
    env: { ...process.env, PATH: dir + ':' + process.env.PATH, REAL_FFMPEG: realFfmpeg.trim() }
  });
});
