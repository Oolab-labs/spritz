'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'webos-receiver');
const info = JSON.parse(fs.readFileSync(path.join(DIR, 'appinfo.json'), 'utf8'));

// PNG header: 8-byte signature, then IHDR whose first two fields are width and height.
const size = (file) => { const b = fs.readFileSync(path.join(DIR, file)); return [b.readUInt32BE(16), b.readUInt32BE(20)]; };

// webOS shows `icon` (80x80) and `largeIcon` (130x130) in the launcher and `bgImage` as the launch
// splash. A wrong size is scaled badly rather than rejected, so it only shows on the TV.
test('the receiver ships correctly sized launcher artwork, and appinfo points at it', () => {
  assert.deepStrictEqual(size(info.icon), [80, 80]);
  assert.deepStrictEqual(size(info.largeIcon), [130, 130]);
  assert.deepStrictEqual(size(info.bgImage), [1920, 1080]);
});

test('icon and largeIcon are different files (the 80px placeholder was used for both before)', () => {
  assert.notStrictEqual(info.icon, info.largeIcon);
});

test('the drawing the PNGs are generated from is in the repo', () => {
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'build', 'receiver-art', 'bubbles.js')));
});

// A missing icon is not a build error: electron-builder falls back to Electron's stock icon, which is
// exactly how the app shipped for a long time.
test('the Mac app has its own icon configured and present', () => {
  const pkg = require('../package.json');
  const rel = pkg.build.mac.icon;
  assert.ok(rel, 'build.mac.icon is not set');
  const file = path.join(__dirname, '..', rel);
  assert.ok(fs.existsSync(file), rel + ' is missing');
  assert.strictEqual(fs.readFileSync(file).subarray(0, 4).toString('latin1'), 'icns');
});
