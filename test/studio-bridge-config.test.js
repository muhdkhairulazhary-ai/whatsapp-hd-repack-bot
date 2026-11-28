import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';
import { BridgeConfigError, readBridgeConfig } from '../src/studio-bridge.js';

const key = 'a501e792d3c486fb'.repeat(4);
const valid = {
  SHELBY_STUDIO_BRIDGE_KEY: key,
  SHELBY_STUDIO_API_ORIGIN: 'https://studio.example.test',
  BAILEYS_AUTH_REDIS_URL: 'https://redis.example.test',
  BAILEYS_AUTH_REDIS_TOKEN: 'fixture-token'
};

test('optional bridge uses the normalized Studio origin and existing Redis REST settings', () => {
  assert.equal(readBridgeConfig({}), undefined);
  assert.deepEqual(readBridgeConfig({
    SHELBY_STUDIO_BRIDGE_KEY: ' ' + key + '\n',
    SHELBY_STUDIO_API_ORIGIN: valid.SHELBY_STUDIO_API_ORIGIN + '/// ',
    BAILEYS_AUTH_REDIS_URL: ' ' + valid.BAILEYS_AUTH_REDIS_URL + '///\t',
    BAILEYS_AUTH_REDIS_TOKEN: ' fixture-token\n'
  }), { key: Buffer.from(key, 'hex'), origin: 'https://studio.example.test',
    redisUrl: 'https://redis.example.test/', redisToken: 'fixture-token' });
});

test('bridge identifies missing and malformed settings without reporting their values', () => {
  const check = (variable, value, reason) => assert.throws(
    () => readBridgeConfig({ ...valid, [variable]: value }),
    error => error instanceof BridgeConfigError &&
      assert.deepEqual(error.issues, [{ variable, reason }]) === undefined
  );
  for (const variable of Object.keys(valid)) check(variable, ' \t', 'missing');
  for (const invalid of [key.toUpperCase(), key.slice(1), '"' + key + '"', key.slice(0, 10) + ' ' + key.slice(10)]) {
    check('SHELBY_STUDIO_BRIDGE_KEY', invalid, 'expected_64_lowercase_hex_characters');
  }
  for (const invalid of ['http://studio.example.test/', 'https://private@studio.example.test',
    'https://studio.example.test/path/', 'https://studio.example.test/?secret=value', 'https://studio.example.test/#private']) {
    check('SHELBY_STUDIO_API_ORIGIN', invalid, 'expected_https_origin');
    check('BAILEYS_AUTH_REDIS_URL', invalid, 'expected_https_rest_root');
  }
  check('BAILEYS_AUTH_REDIS_TOKEN', 'invalid\nfixture-token', 'expected_token_without_whitespace_or_non_ascii_characters');
});

test('production entrypoint logs only field names and safe reasons with multiple invalid settings', async () => {
  const run = promisify(execFile);
  await assert.rejects(run(process.execPath, ['src/baileys-server.js'], { env: {
    PATH: process.env.PATH, NODE_ENV: 'production', DOTENV_CONFIG_PATH: '/nonexistent/shelby-fixture',
    SHELBY_STUDIO_BRIDGE_KEY: 'fixture-secret',
    SHELBY_STUDIO_API_ORIGIN: 'http://private-studio.example.test',
    BAILEYS_AUTH_REDIS_URL: 'https://private-redis.example.test/incorrect',
    BAILEYS_AUTH_REDIS_TOKEN: 'private redis token'
  } }), error => {
    assert.equal(error.code, 1);
    const lines = error.stdout.trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(lines.map(({ variable, reason }) => [variable, reason]), [
      ['SHELBY_STUDIO_BRIDGE_KEY', 'expected_64_lowercase_hex_characters'],
      ['SHELBY_STUDIO_API_ORIGIN', 'expected_https_origin'],
      ['BAILEYS_AUTH_REDIS_URL', 'expected_https_rest_root'],
      ['BAILEYS_AUTH_REDIS_TOKEN', 'expected_token_without_whitespace_or_non_ascii_characters']
    ]);
    assert.doesNotMatch(error.stdout + error.stderr, /fixture-secret|private-studio|private-redis|private redis token/);
    return true;
  });
});
