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

function fixture({ bins = ['ffmpeg', 'ffprobe', 'yt-dlp'], addon = true, entitlements = true } = {}) {
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

test('a missing yt-dlp is refused: the packaged app no longer falls back to Homebrew', () => {
  const root = fixture({ bins: ['ffmpeg', 'ffprobe'] });
  assert.ok(mentions(check(root), /bin\/yt-dlp is missing/));
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

function packagedApp({ addons = ['mpv_render.node', 'airplay.node', 'nowplaying.node'], bins = ['ffmpeg', 'ffprobe', 'yt-dlp'], ytdlpScript = false, shaders = true, receiver = true , licenses = true} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spritz-pkg-'));
  const app = path.join(root, 'Spritz.app');
  fs.mkdirSync(path.join(app, 'Contents/Frameworks'), { recursive: true });
  fs.mkdirSync(path.join(app, 'Contents/MacOS'), { recursive: true });
  const executable = Buffer.alloc(64);
  executable.writeUInt32LE(0xfeedfacf, 0); executable.writeUInt32LE(1, 16); executable.writeUInt32LE(24, 20);
  executable.writeUInt32LE(0x1b, 32); executable.writeUInt32LE(24, 36);
  require('../build/app-uuid').stampUuid(executable, 'app.spritz.player/Contents/MacOS/Spritz');
  fs.writeFileSync(path.join(app, 'Contents/MacOS/Spritz'), executable);
  const bin = path.join(app, 'Contents', 'Resources', 'bin');
  fs.mkdirSync(bin, { recursive: true });
  for (const b of bins) fs.writeFileSync(path.join(bin, b), b === 'yt-dlp' && ytdlpScript ? '#!/opt/homebrew/bin/python\n' : 'binary');
  const unpacked = path.join(app, 'Contents', 'Resources', 'app.asar.unpacked', 'native', 'x', 'build', 'Release');
  fs.mkdirSync(unpacked, { recursive: true });
  for (const a of addons) fs.writeFileSync(path.join(unpacked, a), 'addon');
  require('./helpers/asar').writeAsar(path.join(app, 'Contents', 'Resources', 'app.asar'), { 'package.json': JSON.stringify({ name: 'spritz', dependencies: {} }) });
  if (receiver) {
    const rd = path.join(app, 'Contents', 'Resources', 'receiver');
    fs.mkdirSync(rd, { recursive: true });
    fs.writeFileSync(path.join(rd, 'com.spritz.receiver_' + require('../webos-receiver/appinfo.json').version + '_all.ipk'), 'ipk');
  }
  if (licenses) {
    const ld = path.join(app, 'Contents', 'Resources', 'licenses');
    fs.mkdirSync(ld, { recursive: true });
    fs.writeFileSync(path.join(ld, 'LICENSE'), 'GNU GENERAL PUBLIC LICENSE\nVersion 3');
    fs.writeFileSync(path.join(ld, 'THIRD_PARTY_NOTICES.md'), '# Third-Party Notices\nFFmpeg, x264, libass');
    fs.writeFileSync(path.join(ld, 'LICENSES.chromium.html'), '<html>chromium</html>');
    fs.writeFileSync(path.join(ld, 'ELECTRON-LICENSE'), 'MIT');
    fs.writeFileSync(path.join(ld, 'npm-licenses.txt'), 'a@1.0.0 (MIT)');
  }
  if (shaders) {
    const sh = path.join(app, 'Contents', 'Resources', 'app.asar.unpacked', 'vendor', 'shaders', 'anime4k');
    fs.mkdirSync(sh, { recursive: true });
    fs.writeFileSync(path.join(sh, 'Anime4K_Clamp_Highlights.glsl'), '// shader');
  }
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

// libmpv is native code and cannot read inside app.asar: shaders left in the archive fail with
// "Not a directory" at runtime while the UI still toasts "Anime4K · Mode A".
test('a package whose shaders are not unpacked is refused', () => {
  const { root, app } = packagedApp({ shaders: false });
  assert.ok(verify(app).some((p) => /shaders/.test(p.what)), JSON.stringify(verify(app)));
  cleanup(root);
});

test('a package without the receiver installer, or with a stale one, is refused', () => {
  const a = packagedApp({ receiver: false });
  assert.ok(verify(a.app).some((p) => /receiver \.ipk is not in the package/i.test(p.what)));
  cleanup(a.root);
  const b = packagedApp();
  const rd = path.join(b.app, 'Contents', 'Resources', 'receiver');
  for (const f of fs.readdirSync(rd)) fs.renameSync(path.join(rd, f), path.join(rd, 'com.spritz.receiver_0.0.1_all.ipk'));
  assert.ok(verify(b.app).some((p) => /is not version/.test(p.what)));
  cleanup(b.root);
});

// rc.2 was built with signing disabled and came out with Electron's stock signature (identifier
// "Electron", no sealed resources): codesign --verify fails, and macOS treats it as a different app
// from the one the user granted Local Network access. A fake bundle is not a signed one.
test('a package whose bundle signature does not verify is refused', () => {
  const { root, app } = packagedApp();
  fs.mkdirSync(path.join(app, 'Contents', 'MacOS'), { recursive: true });
  fs.writeFileSync(path.join(app, 'Contents', 'MacOS', 'Spritz'), 'not a signed executable');
  const problems = verify(app);
  assert.ok(problems.some((p) => /signature/i.test(p.what)), JSON.stringify(problems));
  cleanup(root);
});

// The shipped binary used to have every Electron fuse at its default: RunAsNode on (the app binary doubled
// as a Node interpreter that inherits Spritz's entitlements and Local Network permission), the asar not
// integrity-checked and the app loadable from an unpacked folder. Config alone is not proof; verify-package
// reads the fuses back from the real binary (see the real-bundle check).
test('the build flips the Electron fuses that make the binary a general Node runtime', () => {
  const f = require('../package.json').build.electronFuses;
  assert.ok(f, 'build.electronFuses is not set');
  assert.strictEqual(f.runAsNode, false);
  assert.strictEqual(f.enableNodeOptionsEnvironmentVariable, false);
  assert.strictEqual(f.enableNodeCliInspectArguments, false);
  assert.strictEqual(f.enableEmbeddedAsarIntegrityValidation, true);
  assert.strictEqual(f.onlyLoadAppFromAsar, true);
});

// Each broad entitlement is a door for anything that can run code as the app. These stay because something
// needs them (JIT for V8, unsigned executable memory for Electron, library validation off because the
// bundled ffmpeg/mpv dylibs are ad hoc signed, network client/server for casting); DYLD environment
// variables were never needed (libraries are relocated with @loader_path / @executable_path).
test('the entitlements do not grant DYLD environment variable injection', () => {
  const plist = fs.readFileSync(path.join(__dirname, '..', 'build', 'entitlements.mac.plist'), 'utf8');
  assert.ok(!/allow-dyld-environment-variables/.test(plist));
  for (const needed of ['allow-jit', 'allow-unsigned-executable-memory', 'disable-library-validation', 'network.client', 'network.server']) {
    assert.ok(plist.includes(needed), needed + ' should still be granted');
  }
});

test('a real-looking bundle whose fuses cannot be read or are not hardened is refused', () => {
  const { root, app } = packagedApp();
  fs.mkdirSync(path.join(app, 'Contents', 'MacOS'), { recursive: true });
  fs.writeFileSync(path.join(app, 'Contents', 'MacOS', 'Spritz'), 'not an electron binary');
  assert.ok(verify(app).some((p) => /fuse/i.test(p.what)), JSON.stringify(verify(app)));
  cleanup(root);
});

test('the build is configured to sign in-build (ad hoc identity) rather than skip signing', () => {
  const mac = require('../package.json').build.mac;
  assert.strictEqual(mac.identity, '-');
});

test('asarUnpack covers vendor/shaders', () => {
  assert.ok(require('../package.json').build.asarUnpack.includes('vendor/shaders/**'));
});

test('a complete package payload passes (synthetic executable is unsigned)', () => {
  const { root, app } = packagedApp();
  assert.deepEqual(verify(app).filter(p => !/bundle signature|Electron fuses/.test(p.what)), []);
  cleanup(root);
});

test('a missing build is reported rather than passing vacuously', () => {
  // An empty dist/ must not read as "nothing wrong with the package".
  const problems = verify(path.join(os.tmpdir(), 'spritz-does-not-exist-' + Date.now(), 'Spritz.app'));
  assert.equal(problems.length, 1);
  assert.match(problems[0].what, /no packaged app/);
});

// The shipped app carried no licence text at all: not the GPL, not the notices, not Chromium's. They ride
// inside the app (Contents/Resources/licenses) and a build without them is refused.
test('a package without its licence files is refused, naming each missing one', () => {
  const { root, app } = packagedApp({ licenses: false });
  const problems = verify(app);
  for (const f of ['LICENSE', 'THIRD_PARTY_NOTICES.md', 'LICENSES.chromium.html', 'ELECTRON-LICENSE', 'npm-licenses.txt']) {
    assert.ok(problems.some((p) => p.what.includes(f)), f + ' ' + JSON.stringify(problems.map((q) => q.what)));
  }
  cleanup(root);
});

test('an empty licence file, or a LICENSE that is not the GPL, is refused', () => {
  const { root, app } = packagedApp();
  const ld = path.join(app, 'Contents', 'Resources', 'licenses');
  fs.writeFileSync(path.join(ld, 'npm-licenses.txt'), '');
  fs.writeFileSync(path.join(ld, 'LICENSE'), 'All rights reserved');
  const problems = verify(app);
  assert.ok(problems.some((p) => /npm-licenses\.txt/.test(p.what) && /empty/.test(p.what)), JSON.stringify(problems));
  assert.ok(problems.some((p) => /LICENSE/.test(p.what) && /GPL/.test(p.what)), JSON.stringify(problems));
  cleanup(root);
});

test('a bundled library the notices never name is refused outside CI', () => {
  const { root, app } = packagedApp();
  const lib = path.join(app, 'Contents', 'Resources', 'bin', 'lib');
  fs.mkdirSync(lib, { recursive: true });
  fs.writeFileSync(path.join(lib, 'libx264.165.dylib'), 'x');       // named in the fixture's notices
  fs.writeFileSync(path.join(lib, 'libharfbuzz.0.dylib'), 'x');     // not named
  const saved = process.env.CI; delete process.env.CI;
  try {
    const problems = verify(app);
    assert.ok(problems.some((p) => /libharfbuzz/.test(p.what) && /THIRD_PARTY_NOTICES/.test(p.what)), JSON.stringify(problems));
    assert.ok(!problems.some((p) => /libx264/.test(p.what)));
  } finally { if (saved !== undefined) process.env.CI = saved; }
  cleanup(root);
});

test('CI builds with Homebrew\'s own libraries are not held to the notices', () => {
  // The CI package job stands Homebrew's ffmpeg in, which pulls in dozens of libraries the release build does not.
  const { root, app } = packagedApp();
  const lib = path.join(app, 'Contents', 'Resources', 'bin', 'lib');
  fs.mkdirSync(lib, { recursive: true });
  fs.writeFileSync(path.join(lib, 'libharfbuzz.0.dylib'), 'x');
  const saved = process.env.CI; process.env.CI = 'true';
  try { assert.ok(!verify(app).some((p) => /libharfbuzz/.test(p.what))); }
  finally { if (saved === undefined) delete process.env.CI; else process.env.CI = saved; }
  cleanup(root);
});

test('Electron\'s own libraries (Chromium, covered by its licence page) are not held to the notices', () => {
  const { root, app } = packagedApp();
  const fw = path.join(app, 'Contents', 'Frameworks', 'Electron Framework.framework', 'Libraries');
  fs.mkdirSync(fw, { recursive: true });
  fs.writeFileSync(path.join(fw, 'libEGL.dylib'), 'x');
  fs.writeFileSync(path.join(fw, 'libvk_swiftshader.dylib'), 'x');
  const saved = process.env.CI; delete process.env.CI;
  try { assert.deepStrictEqual(verify(app).filter((p) => /never names it/.test(p.what)), []); }
  finally { if (saved !== undefined) process.env.CI = saved; }
  cleanup(root);
});
