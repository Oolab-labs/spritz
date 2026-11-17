'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { atLeast, minosOf, tooNew } = require('../build/macho-minos');

// The package check that would have caught the macOS 11 promise: every Mach-O we bundle carries the macOS
// version it was built for (LC_BUILD_VERSION minos), and none may be newer than what the app declares.

test('versions compare component by component', () => {
  assert.equal(atLeast('27.0', '26.0'), true);
  assert.equal(atLeast('12.0', '11.4'), true);
  assert.equal(atLeast('10.15', '11.0'), false);
  assert.equal(atLeast('27.0', '27.0'), true);
});

test('a bundled binary built for a newer macOS than the app declares is reported', () => {
  const found = tooNew([
    { file: 'bin/ffmpeg', minos: '16.0' },
    { file: 'lib/libssl.3.dylib', minos: '27.0' },
    { file: 'lib/libz.dylib', minos: '11.0' },
    { file: 'odd.node', minos: null }
  ], '26.0');
  assert.deepEqual(found.map((f) => f.file), ['lib/libssl.3.dylib']);
});

test('macOS 16 is read as the macOS 26 it is, never as older than 26', () => {
  // Apple renamed 16 to 26; toolchains still write 16.0 into some binaries.
  assert.deepEqual(tooNew([{ file: 'bin/ffmpeg', minos: '16.0' }], '15.0').map((f) => f.file), ['bin/ffmpeg']);
  assert.deepEqual(tooNew([{ file: 'bin/ffmpeg', minos: '16.0' }], '26.0'), []);
});

test('minos is read from a real binary', { skip: process.platform !== 'darwin' && 'macOS only' }, () => {
  const v = minosOf('/bin/ls');
  assert.match(String(v), /^\d+\.\d+/);
});
