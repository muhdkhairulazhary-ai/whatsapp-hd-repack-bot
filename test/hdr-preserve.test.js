import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
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
