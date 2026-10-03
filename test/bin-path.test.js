'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { resolveBin } = require('../src/main/bin-path');

const RES = '/Applications/Spritz.app/Contents/Resources';
const has = (...paths) => (p) => paths.includes(p);

// A packaged app must never borrow Homebrew's copy: on the build machine that hides a broken
// package, and elsewhere the "fallback" does not exist anyway.
test('packaged: bundled binary is used', () => {
  assert.strictEqual(resolveBin('ffmpeg', { packaged: true, resourcesPath: RES, exists: has(RES + '/bin/ffmpeg', '/opt/homebrew/bin/ffmpeg') }), RES + '/bin/ffmpeg');
});

test('packaged: missing bundled binary does NOT fall back to Homebrew or system', () => {
  assert.strictEqual(resolveBin('yt-dlp', { packaged: true, resourcesPath: RES, exists: has('/opt/homebrew/bin/yt-dlp', '/usr/bin/yt-dlp') }), RES + '/bin/yt-dlp');
});

test('development: Homebrew then system then bare name', () => {
  assert.strictEqual(resolveBin('ffmpeg', { packaged: false, resourcesPath: '/x', exists: has('/opt/homebrew/bin/ffmpeg') }), '/opt/homebrew/bin/ffmpeg');
  assert.strictEqual(resolveBin('ffmpeg', { packaged: false, resourcesPath: '/x', exists: has('/x/bin/ffmpeg', '/opt/homebrew/bin/ffmpeg') }), '/x/bin/ffmpeg');
  assert.strictEqual(resolveBin('nope', { packaged: false, resourcesPath: undefined, exists: has() }), 'nope');
});

test('isPackaged: Electron without defaultApp only', () => {
  const { isPackaged } = require('../src/main/bin-path');
  assert.strictEqual(isPackaged({ versions: { electron: '42.9.0' } }), true);
  assert.strictEqual(isPackaged({ versions: { electron: '42.9.0' }, defaultApp: true }), false);
  assert.strictEqual(isPackaged({ versions: {} }), false);
});

test('user-installed optional tools (whisper) are still found on the system', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '../src/main/main.js'), 'utf8');
  assert.match(src, /userBinPath\(n\)/, 'whisperBin must not use the bundled-only resolver');
});
