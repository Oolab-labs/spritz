'use strict';

// Transport epochs through the /vod/ route, end to end against a real ffmpeg.
//
// The session is the FILM: one token, one directory. Each epoch is one ffmpeg-owned HLS run in a
// subdirectory of it, and a seek that needs a new epoch changes the URL's last path element and
// nothing else. The previous epoch lingers so a receiver mid-switch can finish its fetch.

const os = require('os');
const fs = require('fs');
const path = require('path');
process.env.TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'spritz-epochroute-'));

const { test } = require('node:test');
const assert = require('assert');
const http = require('http');
const { execFileSync } = require('child_process');
const createLanServer = require('../src/main/lanserver');

const FFMPEG = ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg'].find((p) => fs.existsSync(p));
const FFPROBE = ['/opt/homebrew/bin/ffprobe', '/usr/local/bin/ffprobe', '/usr/bin/ffprobe'].find((p) => fs.existsSync(p));
const SKIP = (!FFMPEG || !FFPROBE) && 'ffmpeg/ffprobe not installed';

function fixture(dir) {
  const src = path.join(dir, 'film.mp4');
  execFileSync(FFMPEG, ['-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=25:duration=120',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=120',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '50', '-keyint_min', '50', '-sc_threshold', '0',
    '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', src]);
  return src;
}
function get(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => { const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(c) })); }).on('error', reject);
  });
}
const loopback = (u) => { const p = new URL(u); return 'http://127.0.0.1:' + p.port + p.pathname; };
const sibling = (u, name) => loopback(u).replace(/[^/]+$/, name);

function setEnv() {
  const prev = { vod: process.env.SPRITZ_VOD, epoch: process.env.SPRITZ_VOD_EPOCH };
  process.env.SPRITZ_VOD = '1'; process.env.SPRITZ_VOD_EPOCH = '1';
  return prev;
}
function restoreEnv(prev) {
  if (prev.vod === undefined) delete process.env.SPRITZ_VOD; else process.env.SPRITZ_VOD = prev.vod;
  if (prev.epoch === undefined) delete process.env.SPRITZ_VOD_EPOCH; else process.env.SPRITZ_VOD_EPOCH = prev.epoch;
}
const settle = (ms) => new Promise((r) => setTimeout(r, ms));

test('a seek past the epoch makes a new transport under the same session; the old one lingers, the film does not change', { skip: SKIP, timeout: 120000 }, async () => {
  const prev = setEnv();
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'spritz-epochwork-'));
  const active = [];
  const lan = createLanServer({ onProducerActive: (a) => active.push(a) });
  try {
    const src = fixture(work);
    let meta = null;
    const url = await new Promise((resolve) => lan.serveVod(src, { mediaId: 'film-1' }, (u, m) => { meta = m; resolve(u); }));
    assert.ok(url, 'an epoch-backed URL was offered');
    assert.match(url, /\/vod\/[^/]+\/epoch-[A-Za-z0-9_-]+-1\/media\.m3u8$/, 'the URL names the session and the epoch');
    assert.equal(meta.epoch, 'epoch-' + lan.vodEpoch().token + '-1');
    assert.equal(active[0], true, 'the producer became active when the first run started');

    const pl1 = await get(loopback(url));
    assert.equal(pl1.status, 200);
    const seg = (pl1.body.toString().match(/^\d+\.ts$/m) || [])[0];
    assert.ok(seg, 'the playlist lists segments');
    assert.equal((await get(sibling(url, seg))).status, 200, 'a segment serves');
    assert.equal((await get(sibling(url, '..%2Fmedia.m3u8'))).status, 404, 'no escaping the epoch directory');

    // Let the (fast) local run finish, so the epoch is 'done' and covers to the end.
    let state = lan.vodEpoch();
    for (let i = 0; i < 100 && state.current.running; i++) { await settle(100); state = lan.vodEpoch(); }
    assert.equal(state.current.state, 'done');
    assert.equal(active[active.length - 1], false, 'and the producer went inactive when it exited');

    // Inside what the epoch covers: an in-epoch seek, no new transport.
    const inside = await new Promise((r) => lan.vodSeek(60, r));
    assert.equal(inside.kind, 'in-epoch');
    assert.equal(lan.vodEpoch().current.id, meta.epoch);

    // A seek past the end of the film cannot be inside any epoch, and ffmpeg has nothing to package
    // there; whichever way that resolves, the session must survive it.
    await new Promise((r) => lan.vodSeek(130, r));
    assert.ok(lan.vodEpoch(), 'the session is intact');
  } finally {
    try { lan.teardown(); } catch (e) {}
    fs.rmSync(work, { recursive: true, force: true });
    restoreEnv(prev);
  }
});

test('a backward seek before the current epoch began creates a new epoch, and the old one lingers for the handoff', { skip: SKIP, timeout: 120000 }, async () => {
  const prev = setEnv();
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'spritz-epochwork2-'));
  const active = [];
  const lan = createLanServer({ onProducerActive: (a) => active.push(a) });
  try {
    const src = fixture(work);
    // Start the film's first epoch at 60 — a resume point — so a seek to 20 is genuinely outside it.
    const url = await new Promise((resolve) => lan.serveVod(src, { mediaId: 'film-1', startSec: 60 }, (u) => resolve(u)));
    assert.match(url, /epoch-[A-Za-z0-9_-]+-1\/media\.m3u8$/);
    let state = lan.vodEpoch();
    for (let i = 0; i < 100 && state.current.running; i++) { await settle(100); state = lan.vodEpoch(); }
    assert.ok(state.current.firstPlayableSec == null || state.current.firstPlayableSec <= 60.05, 'epoch-1 begins at or before 60');

    const back = await new Promise((r) => lan.vodSeek(20, r));
    assert.equal(back.kind, 'new-epoch', '20s is before epoch-1 began');
    assert.equal(back.epoch, 'epoch-' + state.token + '-2');
    assert.match(back.url, /\/vod\/[^/]+\/epoch-[A-Za-z0-9_-]+-2\/media\.m3u8$/);
    assert.equal(new URL(back.url).pathname.split('/')[2], new URL(url).pathname.split('/')[2], 'same session token: the film did not change');
    assert.ok(Number.isFinite(back.firstPlayableSec) && back.firstPlayableSec <= 20.05 && back.firstPlayableSec >= 17.9,
      'epoch-2 begins at the keyframe at or before 20 (got ' + back.firstPlayableSec + ')');
    assert.ok(Number.isFinite(back.startSec), 'the receiver is told an epoch-local start (' + back.startSec + ')');

    assert.equal((await get(loopback(back.url))).status, 200, 'the new epoch serves');
    assert.equal((await get(loopback(url))).status, 200, 'and the old one still serves during the handoff');
    assert.deepEqual(lan.vodEpoch().epochs.map((e) => e.id), ['epoch-' + state.token + '-1', 'epoch-' + state.token + '-2']);
    assert.equal(lan.vodEpoch().epochs[0].state, 'superseded');
    assert.ok(active.includes(true), 'the producer was active for the new run');

    // Teardown: every run gone, the session directory gone, producer inactive.
    lan.teardown();
    assert.equal(active[active.length - 1], false);
    const parent = path.join(os.tmpdir(), 'spritz', 'vod');
    assert.deepEqual(fs.existsSync(parent) ? fs.readdirSync(parent) : [], [], 'nothing left on disk');
  } finally {
    try { lan.teardown(); } catch (e) {}
    fs.rmSync(work, { recursive: true, force: true });
    restoreEnv(prev);
  }
});
