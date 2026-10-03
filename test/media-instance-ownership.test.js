'use strict';

// The same ownership rule as vod-instance-ownership.test.js, for the other two temp media classes.
//
// VOD was fixed first because that is where the bug was caught: quitting one Spritz deleted a second
// running Spritz's active segments, and the television reported MEDIA_ERR_SRC_NOT_SUPPORTED — a 404
// wearing a codec fault's clothes. HLS_DIR and REMUX_DIR had the identical shape, a global path
// wiped at both construction and teardown, and the live-HLS route serves ACTIVE media out of
// HLS_DIR. The same cross-process deletion was available there and simply had not been noticed yet.
//
// These are two-instance tests rather than a hope that `node --test` concurrency reproduces the
// race: the sequence they walk is the production one — a second Spritz starting, and then quitting,
// while the first is mid-cast.

const os = require('os');
const fs = require('fs');
const path = require('path');

// A private temp root, set BEFORE lanserver is required, because the parents are module-level consts
// derived from os.tmpdir(). Keeps this file's two servers arguing only with each other.
process.env.TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'spritz-mediaowner-'));

const { test } = require('node:test');
const assert = require('assert');
const http = require('http');
const { execFileSync } = require('child_process');
const createLanServer = require('../src/main/lanserver');

const FFMPEG = ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg'].find((p) => fs.existsSync(p));
const SKIP = !FFMPEG && 'ffmpeg not installed';

function videoFixture(dir, name) {
  const src = path.join(dir, name + '.mp4');
  execFileSync(FFMPEG, ['-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=25:duration=10',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=10',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', src]);
  return src;
}

// A .vtt, because serveSubtitleForDlna passes SRT and SMI straight through: only a format it must
// CONVERT produces an artifact under the remux root, which is the thing under test.
function vttFixture(dir, name) {
  const src = path.join(dir, name + '.vtt');
  fs.writeFileSync(src, 'WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nhello\n');
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

const loopback = (u) => { const p = new URL(u); return 'http://127.0.0.1:' + p.port + p.pathname + (p.search || ''); };

test('a second lanserver neither deletes nor inherits the first one\'s LIVE HLS media', { skip: SKIP }, async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'spritz-hlsown-'));
  let lanA = null, lanB = null;
  try {
    lanA = createLanServer({});
    const urlA = await new Promise((r) => lanA.serveHls(videoFixture(work, 'a'), (u) => r(u)));
    assert.ok(urlA, 'A offered an HLS url');
    const plA = loopback(urlA);
    const before = await get(plA);
    assert.equal(before.status, 200, 'A serves its own playlist before B exists');

    lanB = createLanServer({});
    assert.equal((await get(plA)).status, 200,
      'constructing a second lanserver must not delete the first one\'s HLS media');

    const urlB = await new Promise((r) => lanB.serveHls(videoFixture(work, 'b'), (u) => r(u)));
    assert.ok(urlB, 'B offered its own HLS url');
    assert.equal((await get(loopback(urlB))).status, 200, 'B serves its own playlist');
    assert.equal((await get(plA)).status, 200, 'and A is still serving');

    lanB.teardown(); lanB = null;
    assert.equal((await get(plA)).status, 200,
      'tearing down the second lanserver must not delete the first one\'s HLS media');

    lanA.teardown(); lanA = null;
    const parent = path.join(os.tmpdir(), 'spritz', 'hls');
    const leftovers = fs.existsSync(parent) ? fs.readdirSync(parent) : [];
    assert.deepEqual(leftovers, [], 'both teardowns together leave no HLS artifacts behind');
  } finally {
    try { if (lanB) lanB.teardown(); } catch (e) {}
    try { if (lanA) lanA.teardown(); } catch (e) {}
    fs.rmSync(work, { recursive: true, force: true });
  }
});

test('a second lanserver neither deletes nor inherits the first one\'s REMUX artifacts', { skip: SKIP }, async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'spritz-remuxown-'));
  let lanA = null, lanB = null;
  try {
    // The smallest artifact the remux root really holds on a production path: a converted subtitle
    // sidecar, written under the remux root and served over /file/.
    lanA = createLanServer({});
    const urlA = await new Promise((r) => lanA.serveSubtitleForDlna(vttFixture(work, 'a'), r));
    assert.ok(urlA, 'A produced a converted sidecar');
    const fileA = loopback(urlA);
    const before = await get(fileA);
    assert.equal(before.status, 200, 'A serves its own sidecar before B exists');
    assert.ok(before.body.length > 0, 'and it has a body');

    lanB = createLanServer({});
    assert.equal((await get(fileA)).status, 200,
      'constructing a second lanserver must not delete the first one\'s remux artifacts');

    const urlB = await new Promise((r) => lanB.serveSubtitleForDlna(vttFixture(work, 'b'), r));
    assert.ok(urlB, 'B produced its own sidecar');
    assert.equal((await get(loopback(urlB))).status, 200, 'B serves its own sidecar');
    assert.equal((await get(fileA)).status, 200, 'and A is still serving');

    lanB.teardown(); lanB = null;
    const after = await get(fileA);
    assert.equal(after.status, 200,
      'tearing down the second lanserver must not delete the first one\'s remux artifacts');
    assert.equal(after.body.length, before.body.length, 'and it is the same artifact');

    lanA.teardown(); lanA = null;
    const parent = path.join(os.tmpdir(), 'spritz', 'remux');
    const leftovers = fs.existsSync(parent) ? fs.readdirSync(parent) : [];
    assert.deepEqual(leftovers, [], 'both teardowns together leave no remux artifacts behind');
  } finally {
    try { if (lanB) lanB.teardown(); } catch (e) {}
    try { if (lanA) lanA.teardown(); } catch (e) {}
    fs.rmSync(work, { recursive: true, force: true });
  }
});
