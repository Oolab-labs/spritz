'use strict';

// A broken package is not a broken build. electron-builder will happily produce a .dmg with no
// ffmpeg in it, and an addon still linked to /opt/homebrew runs perfectly on the machine that built
// it — the failure only appears on someone else's Mac, as a crash on launch with no clue attached.
// These check that the preflight actually refuses in each of those cases.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { check } = require('../build/preflight-dist');

function fixture({ bins = ['ffmpeg', 'ffprobe'], addon = true, entitlements = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spritz-preflight-'));
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
  for (const b of bins) fs.writeFileSync(path.join(root, 'bin', b), 'not a real binary');
  if (addon) {
    const d = path.join(root, 'native', 'mpv', 'build', 'Release');
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'mpv_render.node'), 'not a real addon');
  } else {
    fs.mkdirSync(path.join(root, 'native'), { recursive: true });
  }
  if (entitlements) {
    fs.mkdirSync(path.join(root, 'build'), { recursive: true });
    fs.writeFileSync(path.join(root, 'build', 'entitlements.mac.plist'), '<plist/>');
  }
  return root;
}
const cleanup = (d) => fs.rmSync(d, { recursive: true, force: true });
const mentions = (problems, re) => problems.some((p) => re.test(p.what));

test('a complete tree passes', () => {
  const root = fixture();
  assert.deepEqual(check(root), [], 'nothing should be reported');
  cleanup(root);
});

test('a missing ffmpeg is refused, not shipped', () => {
  // The original bug: build.files listed src/native/vendor and no bin/, so the package had no media
  // binaries at all and nothing said so.
  const root = fixture({ bins: ['ffprobe'] });
  const problems = check(root);
  assert.ok(mentions(problems, /bin\/ffmpeg is missing/), JSON.stringify(problems));
  cleanup(root);
});

test('a missing ffprobe is refused too', () => {
  const root = fixture({ bins: ['ffmpeg'] });
  assert.ok(mentions(check(root), /bin\/ffprobe is missing/));
  cleanup(root);
});

test('an unbuilt native addon is refused', () => {
  const root = fixture({ addon: false });
  assert.ok(mentions(check(root), /no compiled native addons/));
  cleanup(root);
});

test('missing entitlements are refused, because Gatekeeper will refuse the result', () => {
  const root = fixture({ entitlements: false });
  assert.ok(mentions(check(root), /entitlements\.mac\.plist is missing/));
  cleanup(root);
});

test('every problem carries the command that fixes it', () => {
  // A build that stops without saying what to do just gets bypassed.
  const root = fixture({ bins: [], addon: false, entitlements: false });
  const problems = check(root);
  assert.ok(problems.length >= 3);
  for (const p of problems) {
    assert.ok(p.what && p.what.length, 'each problem describes itself');
    assert.ok(p.fix && p.fix.length, 'and names a fix: ' + p.what);
  }
  cleanup(root);
});

test('a script bound to this machine is refused, even though otool sees nothing in it', () => {
  // The hole that let a "ready to package" tree ship a dead yt-dlp: Homebrew generates a Python shim
  // whose shebang points into /opt/homebrew/Cellar, with the formula VERSION in the path — so it
  // breaks on the next local upgrade as well as on every other Mac. It is not Mach-O, so the
  // library check passed it silently.
  const root = fixture();
  fs.writeFileSync(path.join(root, 'bin', 'yt-dlp'),
    '#!/opt/homebrew/Cellar/yt-dlp/2026.6.9/libexec/bin/python\nimport sys\n');
  const problems = check(root);
  assert.ok(mentions(problems, /yt-dlp is a script whose interpreter is/), JSON.stringify(problems));
  assert.match(problems.find((p) => /yt-dlp/.test(p.what)).fix, /yt-dlp_macos/, 'and points at the standalone build');
  cleanup(root);
});

test('an ordinary script that is not machine-bound is left alone', () => {
  const root = fixture();
  fs.writeFileSync(path.join(root, 'bin', 'helper'), '#!/bin/sh\necho hi\n');
  assert.deepEqual(check(root), [], '/bin/sh exists everywhere');
  cleanup(root);
});

test('the real tree is checked without throwing', () => {
  // Whatever the answer is here, it must be an answer — a preflight that crashes on an unexpected
  // tree is a preflight that gets deleted.
  const problems = check(path.join(__dirname, '..'));
  assert.ok(Array.isArray(problems));
});

// Verifying the OUTPUT, which the input preflight structurally cannot do. It passed a tree that
// produced a .dmg with no native addons in it at all — the app would have launched and played
// nothing, and nothing in the build said a word.
const { verify } = require('../build/verify-package');

function packagedApp({ addons = ['mpv_render.node', 'airplay.node', 'nowplaying.node'], bins = ['ffmpeg', 'ffprobe', 'yt-dlp'], ytdlpScript = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spritz-pkg-'));
  const app = path.join(root, 'Spritz.app');
  const bin = path.join(app, 'Contents', 'Resources', 'bin');
  fs.mkdirSync(bin, { recursive: true });
  for (const b of bins) fs.writeFileSync(path.join(bin, b), b === 'yt-dlp' && ytdlpScript ? '#!/opt/homebrew/bin/python\n' : 'binary');
  const unpacked = path.join(app, 'Contents', 'Resources', 'app.asar.unpacked', 'native', 'x', 'build', 'Release');
  fs.mkdirSync(unpacked, { recursive: true });
  for (const a of addons) fs.writeFileSync(path.join(unpacked, a), 'addon');
  return { root, app };
}

test('a package missing its native addons is refused', () => {
  const { root, app } = packagedApp({ addons: ['airplay.node', 'nowplaying.node'] });
  const problems = verify(app);
  assert.ok(problems.some((p) => /mpv_render\.node is not in the package/.test(p.what)), JSON.stringify(problems));
  cleanup(root);
});

test('a package missing a media binary is refused', () => {
  const { root, app } = packagedApp({ bins: ['ffprobe', 'yt-dlp'] });
  assert.ok(verify(app).some((p) => /ffmpeg is not in the package/.test(p.what)));
  cleanup(root);
});

test('a package carrying the Homebrew yt-dlp shim is refused', () => {
  const { root, app } = packagedApp({ ytdlpScript: true });
  assert.ok(verify(app).some((p) => /yt-dlp is a script/.test(p.what)));
  cleanup(root);
});

test('a complete package passes', () => {
  const { root, app } = packagedApp();
  assert.deepEqual(verify(app), []);
  cleanup(root);
});

test('a missing build is reported rather than passing vacuously', () => {
  // An empty dist/ must not read as "nothing wrong with the package".
  const problems = verify(path.join(os.tmpdir(), 'spritz-does-not-exist-' + Date.now(), 'Spritz.app'));
  assert.equal(problems.length, 1);
  assert.match(problems[0].what, /no packaged app/);
});
