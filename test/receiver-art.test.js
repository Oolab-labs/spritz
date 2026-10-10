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

// webOS 24 (LG 55NANO80T6A, firmware 33.31.75) showed no splash with only the legacy bgImage; with
// splashBackground set, the splash appeared on a launcher start. Keep both for older firmware.
test('the splash is declared for current webOS (splashBackground) as well as legacy (bgImage)', () => {
  assert.strictEqual(info.splashBackground, info.bgImage);
  assert.deepStrictEqual(size(info.splashBackground), [1920, 1080]);
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

// Legibility (2026-10 polish). Measured on the art this replaced: median luma ~11 (the bubbles read as
// dark holes on a near-black field), brightest 1% ~188, and the 16px Mac icon's brightest 1% only 123
// (a downsampled 1024px drawing). These floors sit between that art and the current art.
const { readPng, lumas, pct } = require('./helpers/png');
const MIN_FIELD_MEDIAN = 22, MIN_HIGHLIGHT_P99 = 195, MIN_SMALL_P99 = 200;

test('TV launcher icons are lifted off black and carry real highlights', () => {
  for (const f of [info.icon, info.largeIcon]) {
    const l = lumas(readPng(fs.readFileSync(path.join(DIR, f))));
    assert.ok(pct(l, 0.5) >= MIN_FIELD_MEDIAN, `${f}: median luma ${pct(l, 0.5).toFixed(1)} < ${MIN_FIELD_MEDIAN}`);
    assert.ok(pct(l, 0.99) >= MIN_HIGHLIGHT_P99, `${f}: p99 luma ${pct(l, 0.99).toFixed(1)} < ${MIN_HIGHLIGHT_P99}`);
  }
});

const { execFileSync } = require('child_process');
const hasIconutil = (() => { try { execFileSync('which', ['iconutil'], { stdio: 'ignore' }); return true; } catch (e) { return false; } })();
test('every size in the shipped Mac icon is legible, with a transparent margin', { skip: !hasIconutil && 'needs macOS iconutil' }, () => {
  const os = require('os');
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'spritz-icns-')), 'x.iconset');
  try {
    execFileSync('iconutil', ['-c', 'iconset', path.join(__dirname, '..', require('../package.json').build.mac.icon), '-o', dir]);
    const files = fs.readdirSync(dir);
    assert.ok(files.includes('icon_16x16.png') && files.includes('icon_512x512@2x.png'), 'icns is missing sizes: ' + files.join(', '));
    for (const f of files) {
      const img = readPng(fs.readFileSync(path.join(dir, f))), l = lumas(img);
      const small = img.width <= 32;
      assert.strictEqual(img.rgba[3], 0, `${f}: corner should be transparent (macOS does not mask icons)`);
      assert.ok(pct(l, 0.5) >= MIN_FIELD_MEDIAN, `${f}: median luma ${pct(l, 0.5).toFixed(1)} < ${MIN_FIELD_MEDIAN}`);
      assert.ok(pct(l, 0.99) >= (small ? MIN_SMALL_P99 : MIN_HIGHLIGHT_P99), `${f}: p99 luma ${pct(l, 0.99).toFixed(1)} too dim`);
    }
  } finally { fs.rmSync(path.dirname(dir), { recursive: true, force: true }); }
});
