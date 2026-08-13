'use strict';

// Validators for renderer-supplied paths. See src/main/ipc-validate.js for the threat model —
// these are not path-traversal guards (the user can open any file anyway); they exist to keep
// renderer-named values from reaching ffmpeg's non-file protocols, and to bound reads.

const { test } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { localMediaPath, readTextCapped } = require('../src/main/ipc-validate');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spritz-validate-'));
const realFile = path.join(tmp, 'Movie.mkv');
fs.writeFileSync(realFile, 'not really a movie');

test('a real local file is accepted and returned', () => {
  assert.strictEqual(localMediaPath(realFile), realFile);
});

test('non-file inputs are refused', () => {
  assert.strictEqual(localMediaPath(tmp), null, 'a directory is not a media file');
  assert.strictEqual(localMediaPath(path.join(tmp, 'nope.mkv')), null, 'missing file');
  for (const bad of [null, undefined, '', 42, {}, [], true]) {
    assert.strictEqual(localMediaPath(bad), null, JSON.stringify(bad) + ' is not a path');
  }
});

test('anything with a URL scheme is refused', () => {
  // This is the point of the guard: these all reach ffmpeg's -i quite happily otherwise, and
  // would let a compromised renderer make the app fetch hosts it cannot reach itself.
  for (const u of ['http://169.254.169.254/latest/meta-data/', 'https://example.invalid/x.mp4',
    'tcp://10.0.0.1:9000', 'concat:/etc/passwd|/etc/hosts', 'subfile,,start,0,end,100,:/etc/passwd',
    'file:///etc/passwd', 'data:video/mp4;base64,AAAA']) {
    assert.strictEqual(localMediaPath(u), null, u + ' must be refused');
  }
});

test('relative paths and null bytes are refused', () => {
  assert.strictEqual(localMediaPath('Movie.mkv'), null, 'no cwd-relative resolution');
  assert.strictEqual(localMediaPath('../Movie.mkv'), null);
  assert.strictEqual(localMediaPath(realFile + '\0.txt'), null, 'null byte truncation');
});

test('readTextCapped returns content under the cap', () => {
  const f = path.join(tmp, 'list.m3u');
  fs.writeFileSync(f, '#EXTM3U\n/a/b.mkv\n');
  assert.strictEqual(readTextCapped(f, 1024), '#EXTM3U\n/a/b.mkv\n');
});

test('readTextCapped refuses a file over the cap instead of allocating it', () => {
  const big = path.join(tmp, 'big.m3u');
  fs.writeFileSync(big, Buffer.alloc(64 * 1024, 0x41));
  assert.strictEqual(readTextCapped(big, 1024), null, 'over cap must be refused, not truncated');
  assert.ok(readTextCapped(big, 128 * 1024).length === 64 * 1024, 'under a larger cap it reads');
});

test('readTextCapped fails closed on bad input', () => {
  assert.strictEqual(readTextCapped(path.join(tmp, 'missing'), 1024), null);
  assert.strictEqual(readTextCapped(tmp, 1024), null, 'a directory is not readable text');
  for (const bad of [null, undefined, '', 42, {}]) {
    assert.strictEqual(readTextCapped(bad, 1024), null);
  }
});

test('cleanup', () => {
  fs.rmSync(tmp, { recursive: true, force: true });
  assert.ok(!fs.existsSync(tmp));
});
