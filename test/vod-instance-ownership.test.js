'use strict';

// One Spritz must not delete another Spritz's media.
//
// VOD artifacts lived under a single global directory — os.tmpdir()/spritz/vod — and every
// createLanServer wiped that whole directory at construction, while teardown() wiped it again. The
// directory is keyed on nothing but the temp root, so it is shared by every process on the machine
// and by every lanserver inside one process. Neither wipe asked whose media it was removing.
//
// Observed twice, once in production and once here:
//
//   - quitting one Spritz deleted a SECOND running Spritz's active segments, and the television
//     reported MEDIA_ERR_SRC_NOT_SUPPORTED. That reads like a codec fault and was a 404. It cost a
//     hardware comparison round before the cause was found.
//   - under `node --test`, which runs files concurrently, one file constructing a lanserver deleted
//     another file's live VOD session. It surfaced as an intermittent 500 in vod-route.test.js's
//     "a segment is produced on demand, and a LATER one can be fetched FIRST", passing when that
//     file was run alone. Two test files already carry a private TMPDIR to dodge it.
//
// This test asserts the ownership rule directly instead of waiting for either symptom. It uses the
// PRE-SEGMENT path deliberately: preseg serves segments straight off disk, so a deleted segment is a
// 404 — exactly the production failure. On the on-demand path ensureSegment would quietly re-cut a
// deleted segment and hand back a 200, hiding the very deletion under test.

const os = require('os');
const fs = require('fs');
const path = require('path');

// A private temp root, set BEFORE lanserver is required, because the VOD parent is a module-level
// const derived from os.tmpdir(). This is not the fix — it is what keeps THIS file's two servers
// arguing only with each other, so a failure here means the ownership rule broke rather than some
// other test file wandering through.
process.env.TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'spritz-owner-'));

const { test } = require('node:test');
const assert = require('assert');
const http = require('http');
const { execFileSync } = require('child_process');
const createLanServer = require('../src/main/lanserver');

const VOD_PARENT = path.join(os.tmpdir(), 'spritz', 'vod');

const FFMPEG = ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg'].find((p) => fs.existsSync(p));
const SKIP = !FFMPEG && 'ffmpeg not installed';

function fixture(dir, name) {
  const src = path.join(dir, name + '.mp4');
  execFileSync(FFMPEG, ['-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=25:duration=20',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=20',
    '-c:v', 'libx264', '-g', '50', '-keyint_min', '50', '-sc_threshold', '0',
    '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', src]);
  return src;
}

function get(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
}

const loopback = (u, name) => { const p = new URL(u); return 'http://127.0.0.1:' + p.port + p.pathname.replace(/[^/]+$/, name); };

function setEnv() {
  const prev = { vod: process.env.SPRITZ_VOD, preseg: process.env.SPRITZ_VOD_PRESEG };
  process.env.SPRITZ_VOD = '1';
  process.env.SPRITZ_VOD_PRESEG = '1';
  return prev;
}
function restoreEnv(prev) {
  if (prev.vod === undefined) delete process.env.SPRITZ_VOD; else process.env.SPRITZ_VOD = prev.vod;
  if (prev.preseg === undefined) delete process.env.SPRITZ_VOD_PRESEG; else process.env.SPRITZ_VOD_PRESEG = prev.preseg;
}

test('a second lanserver neither deletes nor inherits the first one\'s VOD media', { skip: SKIP }, async () => {
  const prev = setEnv();
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'spritz-ownwork-'));
  let lanA = null, lanB = null;
  try {
    // A serves a film and is genuinely serving it: the segment is fetched, not merely offered.
    lanA = createLanServer({});
    const urlA = await new Promise((r) => lanA.serveVod(fixture(work, 'a'), {}, r));
    assert.ok(urlA, 'A offered a VOD url');
    const segA = loopback(urlA, '0.ts');
    const beforeB = await get(segA);
    assert.equal(beforeB.status, 200, 'A serves its own segment before B exists');
    assert.ok(beforeB.body.length > 0, 'and it has a body');

    // The production sequence: a second Spritz starts while the first is mid-cast.
    lanB = createLanServer({});
    const afterBConstruct = await get(segA);
    assert.equal(afterBConstruct.status, 200,
      'constructing a second lanserver must not delete the first one\'s media');

    // B produces its own, so both instances hold live artifacts at once.
    const urlB = await new Promise((r) => lanB.serveVod(fixture(work, 'b'), {}, r));
    assert.ok(urlB, 'B offered a VOD url');
    assert.notEqual(new URL(urlB).pathname, new URL(urlA).pathname, 'B got its own session');
    assert.equal((await get(loopback(urlB, '0.ts'))).status, 200, 'B serves its own segment');
    assert.equal((await get(segA)).status, 200, 'and A is still serving');

    // The production failure itself: quitting the second Spritz.
    lanB.teardown(); lanB = null;
    const afterBTeardown = await get(segA);
    assert.equal(afterBTeardown.status, 200,
      'tearing down the second lanserver must not delete the first one\'s media');
    assert.equal(afterBTeardown.body.length, beforeB.body.length,
      'and the media is the same media, not a re-cut of it');

    // A owns what it made, so its own teardown must still clean up after itself — an ownership
    // scheme that leaks is not an improvement on one that over-deletes.
    lanA.teardown(); lanA = null;
    const leftovers = fs.existsSync(VOD_PARENT) ? fs.readdirSync(VOD_PARENT) : [];
    assert.deepEqual(leftovers, [], 'both teardowns together leave nothing behind');
  } finally {
    try { if (lanB) lanB.teardown(); } catch (e) {}
    try { if (lanA) lanA.teardown(); } catch (e) {}
    fs.rmSync(work, { recursive: true, force: true });
    restoreEnv(prev);
  }
});

// The one legitimate job the old global wipe was doing: recovering disk after a crash.
//
// A crashed Spritz cannot clean up after itself, and its root would otherwise sit there forever —
// a VOD root is roughly the size of the film. So construction sweeps roots whose OWNER IS GONE.
// That sweep deletes things, which makes it exactly the code that must not be taken on trust: the
// bug being fixed was over-broad deletion, and a sweep that misjudged liveness would reintroduce it
// with extra steps. So both directions are asserted, and no ffmpeg is involved — this is about who
// owns a directory, not about media.
test('construction sweeps dead owners\' roots and leaves live ones alone', () => {
  const parent = path.join(os.tmpdir(), 'spritz', 'vod');
  fs.mkdirSync(parent, { recursive: true });

  // A pid that cannot be running: 0x7FFFFFFF is above every platform's pid_max.
  const dead = path.join(parent, '2147483647-deadbeef');
  // This very process, which is indisputably alive — and is also the same-pid case that a
  // pid-only root name would have collided on.
  const live = path.join(parent, process.pid + '-0badc0de');
  // Not an owner id at all. Left alone rather than guessed about: the sweep only claims authority
  // over names it can actually parse an owner out of.
  const foreign = path.join(parent, 'not-an-owner-root');
  for (const d of [dead, live, foreign]) { fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'seg.ts'), 'x'); }

  const lan = createLanServer({});
  try {
    assert.equal(fs.existsSync(dead), false, 'a root whose owner is gone is swept');
    assert.equal(fs.existsSync(live), true, 'a root whose owner is running is left alone');
    assert.equal(fs.existsSync(foreign), true, 'an unrecognised name is not the sweep\'s business');
  } finally {
    lan.teardown();
    for (const d of [live, foreign]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) {} }
  }
});
