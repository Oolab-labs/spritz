'use strict';

// Check the app that was actually built, not the tree it was built from.
//
// build/preflight-dist.js checks the inputs and cannot see this: it passed a tree that produced a
// .dmg containing no native addons at all. `!native/**/build/**` excluded everything under build/,
// which is exactly where the compiled .node files live, so the packaged app had no mpv, no AirPlay
// and no now-playing — it would have launched and played nothing. Nothing failed; the build was
// green and the package was hollow.
//
// The only way to catch that is to look inside the result. Every check below is a fact about a file
// in the packaged app.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const APP = path.join(ROOT, 'dist', 'mac-arm64', 'Spritz.app');

const REQUIRED_ADDONS = ['mpv_render.node', 'airplay.node', 'nowplaying.node'];
const REQUIRED_BINS = ['ffmpeg', 'ffprobe', 'yt-dlp'];

function walk(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

function homebrewRefs(file) {
  try {
    const out = execFileSync('otool', ['-L', file], { encoding: 'utf8', timeout: 20000 });
    return out.split('\n').slice(1).map((l) => l.trim().split(' ')[0]).filter((l) => l.startsWith('/opt/homebrew'));
  } catch (e) { return []; }
}

function verify(app) {
  const problems = [];
  if (!fs.existsSync(app)) return [{ what: `no packaged app at ${app}`, fix: 'npm run dist' }];
  const files = walk(app);
  const base = (p) => path.basename(p);

  // The media binaries, at the path binPath() looks in at runtime.
  const resBin = path.join(app, 'Contents', 'Resources', 'bin');
  for (const b of REQUIRED_BINS) {
    const p = path.join(resBin, b);
    if (!fs.existsSync(p)) problems.push({ what: `${b} is not in the package`, fix: 'check build.extraResources maps bin/ → bin' });
  }
  // yt-dlp has to be the standalone build; the Homebrew shim is a Python script bound to this Mac.
  const ytdlp = path.join(resBin, 'yt-dlp');
  if (fs.existsSync(ytdlp)) {
    let head = '';
    try { const fd = fs.openSync(ytdlp, 'r'); const b = Buffer.alloc(64); const n = fs.readSync(fd, b, 0, 64, 0); fs.closeSync(fd); head = b.subarray(0, n).toString('utf8'); } catch (e) {}
    if (head.startsWith('#!')) problems.push({ what: 'the packaged yt-dlp is a script, not a self-contained binary', fix: 'see build/preflight-dist.js — use yt-dlp_macos' });
  }

  // The addons. Their absence is silent: the app launches and plays nothing.
  for (const a of REQUIRED_ADDONS) {
    if (!files.some((f) => base(f) === a)) {
      problems.push({ what: `${a} is not in the package — the app would launch and play nothing`, fix: 'build.files excludes native/**/build/**; re-include native/**/build/Release/*.node after it' });
    }
  }

  // Nothing may point at a library that only exists on the build machine.
  for (const f of files) {
    if (!/\.(node|dylib)$/.test(f) && !REQUIRED_BINS.includes(base(f))) continue;
    const leaks = homebrewRefs(f);
    if (leaks.length) {
      problems.push({ what: `${path.relative(app, f)} links ${path.basename(leaks[0])} from Homebrew`, fix: './build/bundle-dylibs.sh — see README' });
    }
  }

  // An addon that ships without the libraries it was relocated onto is as broken as one that was
  // never packaged, and looks fine in a file listing.
  const mpv = files.find((f) => base(f) === 'mpv_render.node');
  if (mpv) {
    const refs = (() => { try { return execFileSync('otool', ['-L', mpv], { encoding: 'utf8', timeout: 20000 }); } catch (e) { return ''; } })();
    const m = /@loader_path\/lib\/(\S+\.dylib)/.exec(refs);
    if (m && !fs.existsSync(path.join(path.dirname(mpv), 'lib', m[1]))) {
      problems.push({ what: `mpv_render.node expects lib/${m[1]} beside it and it was not packaged`, fix: 'include native/**/build/Release/lib/** in build.files and asarUnpack' });
    }
  }
  return problems;
}

module.exports = { verify };

if (require.main === module) {
  const problems = verify(APP);
  if (!problems.length) {
    console.log('package verified: binaries, addons and libraries are all present and self-contained');
    process.exit(0);
  }
  console.error(`\npackage verification FAILED — ${problems.length} problem${problems.length === 1 ? '' : 's'} in the built app:\n`);
  for (const p of problems) console.error(`  ✗ ${p.what}\n    → ${p.fix}\n`);
  process.exit(1);
}
