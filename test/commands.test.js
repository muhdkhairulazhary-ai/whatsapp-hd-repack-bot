import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCommand, HELP_TEXT } from '../src/commands.js';

test('recognises supported commands case-insensitively', () => {
  assert.equal(parseCommand('HELP'), 'help');
  assert.equal(parseCommand('/ping'), 'ping');
  assert.equal(parseCommand(' status '), 'status');
  assert.equal(parseCommand('hello'), null);
});

test('help message explains video workflow and commands', () => {
  assert.match(HELP_TEXT, /Send me a video/);
  assert.match(HELP_TEXT, /STATUS/);
});
