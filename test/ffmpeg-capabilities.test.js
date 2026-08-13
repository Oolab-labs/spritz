'use strict';

// What the bundled ffmpeg can do.
//
// lanserver.js probes `ffmpeg -filters` at load and switches features on from the result:
// CAN_TONEMAP gates real HDR→SDR conversion, and the absence of `subtitles` is why bitmap subs
// were steered to DLNA. That makes the binary's capabilities load-bearing configuration, not an
// implementation detail — and it is configuration that lives outside the repo, in a hand-built
// binary that a future rebuild could quietly ship without libass or libzimg. The failure mode is
// not a crash: casting keeps working and quality silently regresses to the washed-out fallback.
//
// So: assert the capabilities, using the same probe lanserver uses. This is the only test here
// that examines a build artifact rather than source, which is the point of it.

const { test } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// Prefer the deployed bundle, fall back to a repo-local build. Skipped entirely when neither
// exists — CI checks out source and has no ffmpeg, and failing there would teach nothing.
const CANDIDATES = [
  '/Applications/Spritz.app/Contents/Resources/bin/ffmpeg',
  path.join(__dirname, '..', 'bin', 'ffmpeg')
];
const FFMPEG = CANDIDATES.find((p) => { try { return fs.statSync(p).isFile(); } catch (e) { return false; } });

// The exact test lanserver.js:76 applies, kept identical on purpose — a filter present under a
// different flag prefix would pass a looser check here and still fail there.
function hasFilter(out, name) {
  return new RegExp('(^|\\n)\\s*[.TSC]{1,3}\\s+' + name + '\\s', 'm').test(out);
}

test('the bundled ffmpeg has the filters the cast paths depend on', (t) => {
  if (!FFMPEG) return t.skip('no bundled ffmpeg on this machine');
  const out = execFileSync(FFMPEG, ['-hide_banner', '-filters'], { encoding: 'utf8', timeout: 15000 });

  // CAN_TONEMAP needs BOTH. Without them the HDR path falls back to a plain scale, which is
  // watchable but washed out — the failure this build existed to fix.
  assert.ok(hasFilter(out, 'tonemap'), 'tonemap missing — HDR would fall back to a plain scale');
  assert.ok(hasFilter(out, 'zscale'), 'zscale missing (needs libzimg) — CAN_TONEMAP would be false');
  // libass. Without it there is no text-subtitle burn-in.
  assert.ok(hasFilter(out, 'subtitles'), 'subtitles missing (needs libass)');
  assert.ok(hasFilter(out, 'overlay'), 'overlay missing — bitmap subtitle burn-in uses it');
  assert.ok(hasFilter(out, 'scale'), 'scale missing — every downscale path uses it');
});

test('the bundled ffmpeg has the encoders the cast paths depend on', (t) => {
  if (!FFMPEG) return t.skip('no bundled ffmpeg on this machine');
  const out = execFileSync(FFMPEG, ['-hide_banner', '-encoders'], { encoding: 'utf8', timeout: 15000 });
  for (const enc of [
    'libx264',              // software H.264 fallback path
    'h264_videotoolbox',    // hardware path, the normal one
    'hevc_videotoolbox',
    'aac',
    'ac3', 'eac3'           // surround passthrough re-encode for capability-confirmed receivers
  ]) {
    assert.ok(new RegExp('\\s' + enc + '\\s').test(out), enc + ' encoder missing');
  }
});

test('the bundled ffmpeg is self-contained', (t) => {
  if (!FFMPEG) return t.skip('no bundled ffmpeg on this machine');
  // It is built against Homebrew and relocated by build/bundle-dylibs.sh. If a rebuild skips that
  // step the binary still runs HERE — Homebrew is installed — and fails on any other machine, or
  // the moment `brew upgrade` bumps a soname. Cheapest possible check for a mistake that is
  // invisible on the developer's own laptop.
  const out = execFileSync('otool', ['-L', FFMPEG], { encoding: 'utf8', timeout: 10000 });
  const leaks = out.split('\n').map((l) => l.trim().split(' ')[0]).filter((p) => p.startsWith('/opt/homebrew'));
  assert.deepStrictEqual(leaks, [], 'unrelocated Homebrew dylibs: ' + leaks.join(', '));
});
