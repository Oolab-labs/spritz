'use strict';

// A pre-segmented package must be internally consistent: every URI the master and its media
// playlists name has to exist.
//
// It was not. `presegmentArgs` was called with kind 'video' for a multi-audio source, so ONLY the
// picture was segmented, while serveVod still advertised one `audio_N.m3u8` per track and those
// playlists still named `aN_*.ts`. Measured against a two-track fixture: master lists audio_0 and
// audio_1, `0.ts` serves 200, `a0_0.ts` serves 404. The on-demand path hid this because it produced
// audio segments on request; the preseg path produces nothing on request, by design.
//
// The fix keeps ffmpeg the owner of the HLS timeline — one pass emitting video AND audio through
// -var_stream_map — rather than reconstructing boundaries in Spritz, which is what caused the
// receiver livelock this whole route exists to fix.

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
const http = require('http');
const { execFileSync } = require('child_process');
const createLanServer = require('../src/main/lanserver');

const FFMPEG = ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg'].find((p) => fs.existsSync(p));
const SKIP = !FFMPEG && 'ffmpeg not installed';

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

// Two audio tracks, because splitAudio is `perTrack.length > 1` — one track stays muxed and never
// exercises any of this.
function dualAudioFixture(dir) {
  const src = path.join(dir, 'dual.mkv');
  execFileSync(FFMPEG, ['-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=25:duration=40',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=40',
    '-f', 'lavfi', '-i', 'sine=frequency=880:duration=40',
    '-map', '0:v', '-map', '1:a', '-map', '2:a',
    '-c:v', 'libx264', '-g', '50', '-keyint_min', '50', '-sc_threshold', '0',
    '-pix_fmt', 'yuv420p', '-c:a', 'aac',
    '-metadata:s:a:0', 'language=eng', '-metadata:s:a:1', 'language=fra', src]);
  return src;
}

function get(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    }).on('error', reject);
  });
}

const rel = (base, name) => base.replace(/[^/]+$/, name);
// Every non-comment line in a playlist is a URI. Blank lines and #-lines are not.
const uris = (pl) => pl.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));

test('preseg + split audio: every file the package advertises exists', { skip: SKIP }, async () => {
  const prev = setEnv();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spritz-presegaudio-'));
  const lan = createLanServer({});
  try {
    const src = dualAudioFixture(dir);
    const url = await new Promise((resolve) => lan.serveVod(src, {}, resolve));
    assert.ok(url, 'serveVod should hand back a URL for a two-audio-track source');
    const master = await get(url.replace(/^http:\/\/[^/]+/, 'http://127.0.0.1:' + new URL(url).port));
    assert.equal(master.status, 200, 'master.m3u8 should serve');
    const base = 'http://127.0.0.1:' + new URL(url).port + new URL(url).pathname;

    // The master names audio renditions in EXT-X-MEDIA URI="..." attributes, not as bare lines.
    const mediaUris = [...master.body.matchAll(/URI="([^"]+)"/g)].map((m) => m[1]);
    const streamUris = uris(master.body);
    assert.ok(mediaUris.length >= 2, 'a two-track source should advertise two audio renditions');

    const missing = [];
    for (const plName of [...streamUris, ...mediaUris]) {
      const pl = await get(rel(base, plName));
      if (pl.status !== 200) { missing.push(plName + ' (playlist ' + pl.status + ')'); continue; }
      for (const seg of uris(pl.body)) {
        const r = await get(rel(base, seg));
        if (r.status !== 200) missing.push(plName + ' -> ' + seg + ' (' + r.status + ')');
      }
    }
    assert.deepEqual(missing, [], 'the package advertises files that do not exist: ' + missing.slice(0, 5).join(', '));
  } finally {
    try { lan.teardown(); } catch (e) {}
    fs.rmSync(dir, { recursive: true, force: true });
    restoreEnv(prev);
  }
});
