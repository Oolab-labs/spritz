'use strict';

// The pre-segment path must not pay for the keyframe pass.
//
// `-skip_frame nokey` decodes nothing, but it is still a FULL pass over the file: measured at 33.9s
// on a 2.8 GB 100-minute film, against ~3s for the segmenting itself. That cost buys the segment
// SPANS that the on-demand producer cuts to — and the pre-segment path does not cut to spans at all.
// It hands the whole file to one `-f hls` run, lets ffmpeg choose the boundaries, and serves the
// playlist ffmpeg writes (see serveVodFile's media.m3u8 branch). So on that path the keyframe list
// is computed, stored in sess.segments, and never read.
//
// This test patches child_process BEFORE requiring lanserver, because lanserver destructures
// `{ spawn }` at load time — patching the module object afterwards would rebind nothing.

// Its own TMPDIR, set BEFORE lanserver is required: VOD_DIR is a module-level const derived from
// os.tmpdir(), and createLanServer wipes that whole directory at construction. Two test files
// running concurrently would each delete the other's live session out from under it — which is
// exactly what happened when this file was first added (its segments 404'd only when run alongside
// the other preseg file, and passed alone).
const os = require('os');
const fs = require('fs');
const path = require('path');
process.env.TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'spritz-testroot-'));

const { test } = require('node:test');
const assert = require('assert');
const child = require('child_process');
const { execFileSync } = child;

const FFMPEG = ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg'].find((p) => fs.existsSync(p));
const SKIP = !FFMPEG && 'ffmpeg not installed';

// Record every spawn, then hand through to the real one — the run must still actually work, so a
// stub that returned a fake process would prove nothing about whether the route still functions.
const spawns = [];
const realSpawn = child.spawn;
child.spawn = function (cmd, args, opts) {
  spawns.push(Array.isArray(args) ? args.slice() : []);
  return realSpawn.call(this, cmd, args, opts);
};

// Only now, with spawn already wrapped.
delete require.cache[require.resolve('../src/main/lanserver')];
const createLanServer = require('../src/main/lanserver');

const isKeyframeScan = (args) => args.includes('-skip_frame') && args.includes('nokey');

// Separate set/restore functions rather than inline assignment, for the reason vod-route.test.js
// gives at its own setVod: assigning process.env after an await trips require-atomic-updates.
function setEnv(preseg) {
  const prev = { vod: process.env.SPRITZ_VOD, preseg: process.env.SPRITZ_VOD_PRESEG };
  process.env.SPRITZ_VOD = '1';
  if (preseg) process.env.SPRITZ_VOD_PRESEG = '1'; else delete process.env.SPRITZ_VOD_PRESEG;
  return prev;
}
function restoreEnv(prev) {
  if (prev.vod === undefined) delete process.env.SPRITZ_VOD; else process.env.SPRITZ_VOD = prev.vod;
  if (prev.preseg === undefined) delete process.env.SPRITZ_VOD_PRESEG; else process.env.SPRITZ_VOD_PRESEG = prev.preseg;
}

function fixture(dir) {
  const src = path.join(dir, 'fixture.mp4');
  execFileSync(FFMPEG, ['-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=25:duration=40',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=40',
    '-c:v', 'libx264', '-g', '250', '-keyint_min', '250', '-sc_threshold', '0',
    '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', src]);
  return src;
}

test('preseg does not run the full-file keyframe scan', { skip: SKIP }, async () => {
  const prevEnv = setEnv(true);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spritz-presegprobe-'));
  const lan = createLanServer({});
  try {
    const src = fixture(dir);
    spawns.length = 0;
    const url = await new Promise((resolve) => lan.serveVod(src, {}, resolve));
    // A null URL would make the assertion below pass for the wrong reason — the route declining is
    // not the route skipping the scan.
    assert.ok(url, 'serveVod should hand back a URL on the preseg path');
    const scans = spawns.filter(isKeyframeScan);
    assert.equal(scans.length, 0,
      'the preseg path ran the keyframe scan ' + scans.length + ' time(s); it needs no segment spans');
  } finally {
    try { lan.teardown(); } catch (e) {}
    fs.rmSync(dir, { recursive: true, force: true });
    restoreEnv(prevEnv);
  }
});

// Split audio is the case the bypass originally excluded, because those renditions' playlists were
// built from sess.segments. The package pass writes them itself now, so the spans are dead there
// too — and this is where a regression would land if someone reintroduced span-built audio.
test('preseg does not run the keyframe scan for split audio either', { skip: SKIP }, async () => {
  const prevEnv = setEnv(true);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spritz-presegprobe-'));
  const lan = createLanServer({});
  try {
    const src = path.join(dir, 'dual.mkv');
    execFileSync(FFMPEG, ['-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=25:duration=40',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=40',
      '-f', 'lavfi', '-i', 'sine=frequency=880:duration=40',
      '-map', '0:v', '-map', '1:a', '-map', '2:a',
      '-c:v', 'libx264', '-g', '50', '-keyint_min', '50', '-sc_threshold', '0',
      '-pix_fmt', 'yuv420p', '-c:a', 'aac',
      '-metadata:s:a:0', 'language=eng', '-metadata:s:a:1', 'language=fra', src]);
    spawns.length = 0;
    const url = await new Promise((resolve) => lan.serveVod(src, {}, resolve));
    assert.ok(url, 'serveVod should hand back a URL for a two-audio-track source');
    const scans = spawns.filter(isKeyframeScan);
    assert.equal(scans.length, 0,
      'the preseg package path ran the keyframe scan ' + scans.length + ' time(s); it needs no spans');
  } finally {
    try { lan.teardown(); } catch (e) {}
    fs.rmSync(dir, { recursive: true, force: true });
    restoreEnv(prevEnv);
  }
});

// The guard the bypass must not break: WITHOUT preseg, the on-demand producer cuts to spans that
// only the keyframe pass can supply, so there the scan is mandatory. A bypass that skipped it on
// both paths would pass the test above and silently break the production default.
test('the on-demand path still runs the keyframe scan', { skip: SKIP }, async () => {
  const prevEnv = setEnv(false);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spritz-presegprobe-'));
  const lan = createLanServer({});
  try {
    const src = fixture(dir);
    spawns.length = 0;
    const url = await new Promise((resolve) => lan.serveVod(src, {}, resolve));
    assert.ok(url, 'serveVod should hand back a URL on the on-demand path');
    assert.equal(spawns.filter(isKeyframeScan).length, 1,
      'the on-demand path needs exactly one keyframe scan to build its segment spans');
  } finally {
    try { lan.teardown(); } catch (e) {}
    fs.rmSync(dir, { recursive: true, force: true });
    restoreEnv(prevEnv);
  }
});
