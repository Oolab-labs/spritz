'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// build.mac.minimumSystemVersion becomes LSMinimumSystemVersion in the packaged Info.plist: it is what lets
// macOS refuse to open the app with a clear message instead of letting it launch and fail. It said 11.0,
// and every release said "macOS 11+". Measured on the installed rc.17: 64 of the bundled Homebrew libraries
// declare minos 26.0, ffmpeg and ffprobe 16.0 (macOS 26's other number), and libssl/libcrypto 27.0 — they
// were built for the Mac that built the app, and dyld refuses to load a library built for a newer macOS.
// The real floor of these builds is macOS 27, the only version they have been run on. The declared floor
// must be at least what every component requires, and what a user reads before downloading must say so.

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const pkg = JSON.parse(read('package.json'));
const declared = pkg.build.mac.minimumSystemVersion;
const { atLeast } = require('../build/macho-minos');

test('the declared minimum is macOS 27, the floor of the libraries the app bundles', () => {
  assert.match(String(declared), /^\d+\.\d+$/);
  assert.ok(atLeast(declared, '27.0'), `the app declares ${declared}; its bundled libssl and libcrypto need 27.0`);
});

test("the declared minimum covers every native addon's deployment target", () => {
  const addons = fs.readdirSync(path.join(root, 'native')).filter((d) => fs.existsSync(path.join(root, 'native', d, 'binding.gyp')));
  assert.ok(addons.length >= 3, 'found the addons');
  for (const d of addons) {
    const m = read(path.join('native', d, 'binding.gyp')).match(/"MACOSX_DEPLOYMENT_TARGET"\s*:\s*"([\d.]+)"/);
    assert.ok(m, d + ' declares a deployment target');
    assert.ok(atLeast(declared, m[1]), `${d} targets macOS ${m[1]} but the app declares ${declared}`);
  }
});

// CI installs with --ignore-scripts, which skips Electron's download, so the bundle is not always there.
const ELECTRON_PLIST = path.join(root, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'Info.plist');
test('the declared minimum covers what Electron itself requires', { skip: !fs.existsSync(ELECTRON_PLIST) && 'Electron is not downloaded' }, () => {
  const m = fs.readFileSync(ELECTRON_PLIST, 'utf8').match(/<key>LSMinimumSystemVersion<\/key>\s*<string>([\d.]+)<\/string>/);
  assert.ok(m, 'Electron declares a minimum');
  assert.ok(atLeast(declared, m[1]), `Electron requires macOS ${m[1]} but the app declares ${declared}`);
});

test('the README, the site and the current release notes state the declared minimum and no lower one', () => {
  const major = String(declared).split('.')[0];
  for (const f of ['README.md', 'site/index.html', 'RELEASE-NOTES-v' + pkg.version + '.md']) {
    const text = read(f);
    assert.ok(text.includes('macOS ' + major + '+') || text.includes('macOS ' + major + ' or later'), `${f} says macOS ${major}+`);
    // Every "macOS N+", "macOS N or later", "macOS N and later" and "macOS N to M" names a floor; none may sit below the real one.
    for (const m of text.matchAll(/macOS (\d+)(?:\s*\([^)]*\))?\s*(?:\+|or later|and later|to \d+)/g)) {
      assert.ok(+m[1] >= +major, `${f} says "${m[0]}" but the app needs macOS ${major}`);
    }
  }
});
