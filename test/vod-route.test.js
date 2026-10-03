'use strict';

// The /vod/ route end to end, against a real file and a real ffmpeg.
//
// The point of a VOD playlist is that the receiver is handed the whole finite shape of the film
// before any of it has been encoded, and then fetches parts in whatever order it likes. So these
// tests fetch OUT OF ORDER on purpose: a seek is the case the live-pipe path cannot serve at all,
// and it is the only reason to build this.

const { test } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');
const createLanServer = require('../src/main/lanserver');

const FFMPEG = ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg'].find((p) => fs.existsSync(p));
const FFPROBE = ['/opt/homebrew/bin/ffprobe', '/usr/local/bin/ffprobe', '/usr/bin/ffprobe'].find((p) => fs.existsSync(p));
const SKIP = !FFMPEG && 'ffmpeg not installed';

function fixture(dir) {
  const src = path.join(dir, 'fixture.mp4');
  execFileSync(FFMPEG, ['-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=25:duration=40',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=40',
    '-c:v', 'libx264', '-g', '250', '-keyint_min', '250', '-sc_threshold', '0',
    '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', src]);
  return src;
}

function get(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
}

// Where the CURRENT session's segments are on disk.
//
// The layout is os.tmpdir()/spritz/vod/<owner-id>/<token>: each lanserver owns one <owner-id> root
// and never touches a sibling's, so that one process quitting cannot delete another's active media
// (see vod-instance-ownership.test.js). These two tests read the cache directly — there is no HTTP
// answer that distinguishes "primed" from "produced on request" — so they have to know the shape.
// Newest at each level, because a test file may leave more than one behind.
function newestSessionDir() {
  const parent = path.join(os.tmpdir(), 'spritz', 'vod');
  const newestDirIn = (root) => fs.readdirSync(root).map((d) => path.join(root, d))
    .filter((d) => { try { return fs.statSync(d).isDirectory(); } catch (e) { return false; } })
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
  const owned = newestDirIn(parent);
  return owned && newestDirIn(owned);
}

const loopback = (u, name) => { const p = new URL(u); return 'http://127.0.0.1:' + p.port + p.pathname.replace(/[^/]+$/, name); };

function setVod(on) {
  const prev = process.env.SPRITZ_VOD;
  if (on) process.env.SPRITZ_VOD = '1'; else delete process.env.SPRITZ_VOD;
  return prev;
}
function restoreVod(prev) {
  if (prev === undefined) delete process.env.SPRITZ_VOD; else process.env.SPRITZ_VOD = prev;
}

// Same shape as setVod/restoreVod above, and separate functions for the same reason: assigning
// process.env directly after an await trips require-atomic-updates.
function setRun(on) {
  const prev = process.env.SPRITZ_VOD_RUN;
  if (on) process.env.SPRITZ_VOD_RUN = '1'; else delete process.env.SPRITZ_VOD_RUN;
  return prev;
}
function restoreRun(prev) {
  if (prev === undefined) delete process.env.SPRITZ_VOD_RUN; else process.env.SPRITZ_VOD_RUN = prev;
}

async function withVod(fn) {
  const prev = setVod(true);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spritz-vodroute-'));
  const lan = createLanServer({});
  try {
    const src = fixture(dir);
    const url = await new Promise((resolve) => lan.serveVod(src, {}, resolve));
    if (!url) return { skipped: true };
    await fn({ lan, url, playlist: loopback(url, 'media.m3u8'), seg: (i) => loopback(url, i + '.ts') });
  } finally {
    try { lan.teardown(); } catch (e) {}
    fs.rmSync(dir, { recursive: true, force: true });
    restoreVod(prev);
  }
  return { skipped: false };
}

test('the route is off unless opted into', { skip: SKIP }, async () => {
  const prev = setVod(false);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spritz-vodoff-'));
  const lan = createLanServer({});
  try {
    const url = await new Promise((resolve) => lan.serveVod(fixture(dir), {}, resolve));
    assert.equal(url, null, 'without SPRITZ_VOD=1 nothing is offered');
  } finally {
    try { lan.teardown(); } catch (e) {}
    fs.rmSync(dir, { recursive: true, force: true });
    restoreVod(prev);
  }
});

test('the playlist is complete and finite before a single segment exists', { skip: SKIP }, async (t) => {
  const r = await withVod(async ({ playlist }) => {
    const res = await get(playlist);
    assert.equal(res.status, 200);
    const body = res.body.toString();
    // ENDLIST is the whole argument: the receiver knows where the film ends, so it can seek
    // anywhere in it without being told the length later.
    assert.ok(body.includes('#EXT-X-ENDLIST'), body);
    assert.ok(body.includes('#EXT-X-PLAYLIST-TYPE:VOD'), body);
    assert.equal((body.match(/#EXTINF:/g) || []).length, 4, '40s of fixture, keyframes every 10s');
    assert.ok(/application\/vnd\.apple\.mpegurl/.test(res.headers['content-type']));
  });
  if (r.skipped) t.skip('no LAN address available');
});

test('a segment is produced on demand, and a LATER one can be fetched FIRST', { skip: SKIP, timeout: 30000 }, async (t) => {
  const r = await withVod(async ({ seg }) => {
    // This is the seek. Nothing before it has been encoded, and it must still work.
    const last = await get(seg(3));
    assert.equal(last.status, 200);
    assert.ok(last.body.length > 1000, 'got ' + last.body.length + ' bytes');
    const first = await get(seg(0));
    assert.equal(first.status, 200);
    assert.ok(first.body.length > 1000);
  });
  if (r.skipped) t.skip('no LAN address available');
});

// A timeout, not just a skip: losing the de-duplication makes a waiter that is never called back,
// so the failure is a request that never answers. Without a bound that stalls the run instead of
// failing it, and a hung suite is a worse signal than a red one.
test('two simultaneous requests for one segment produce it once and both get it', { skip: SKIP, timeout: 30000 }, async (t) => {
  const r = await withVod(async ({ seg }) => {
    const [a, b] = await Promise.all([get(seg(2)), get(seg(2))]);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    // Two ffmpegs writing the same path would hand at least one caller a truncated file.
    assert.equal(a.body.length, b.body.length, 'the two responses disagree about the segment');
    assert.ok(a.body.equals(b.body));
  });
  if (r.skipped) t.skip('no LAN address available');
});

test('an index past the end of the film is refused', { skip: SKIP }, async (t) => {
  const r = await withVod(async ({ seg, url }) => {
    assert.equal((await get(seg(99))).status, 404);
    assert.equal((await get(loopback(url, 'nonsense'))).status, 404);
    assert.equal((await get(loopback(url, '../../etc/passwd'))).status, 404);
  });
  if (r.skipped) t.skip('no LAN address available');
});

test('a stale token gets nothing, not segments of whatever is playing now', { skip: SKIP }, async (t) => {
  const r = await withVod(async ({ lan, seg }) => {
    const stale = seg(1);
    await new Promise((resolve) => lan.cancelVod ? (lan.cancelVod(), resolve()) : resolve());
    assert.equal((await get(stale)).status, 404);
  });
  if (r.skipped) t.skip('no LAN address available');
});

test('a source needing a real transcode is declined, not copied hopefully', { skip: SKIP, timeout: 60000 }, async () => {
  // Every segment is `-c:v copy`. A receiver that cannot decode the source video must be sent down
  // the live-HLS path instead — and the decision has to happen HERE, because once segments are
  // being produced there is no way to change course mid-film.
  //
  // HEVC, because the planner deliberately treats non-tall H.264 as copyable by every receiver, so
  // H.264 cannot express "this one has to be re-encoded" no matter what caps are passed.
  const prev = setVod(true);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spritz-vodgate-'));
  const lan = createLanServer({});
  try {
    const src = path.join(dir, 'hevc.mp4');
    execFileSync(FFMPEG, ['-loglevel', 'error', '-y', '-f', 'lavfi',
      '-i', 'testsrc=size=320x180:rate=25:duration=8',
      '-c:v', 'libx265', '-x265-params', 'log-level=none', '-pix_fmt', 'yuv420p', '-tag:v', 'hvc1', src]);
    const refused = await new Promise((resolve) => lan.serveVod(src, { caps: { hevc: false } }, resolve));
    assert.equal(refused, null, 'a receiver that cannot decode HEVC must not be handed copied HEVC');
    // And the same file IS offered to a receiver that can — otherwise this test would pass with the
    // gate stuck permanently shut, which is the failure it would least likely notice.
    const offered = await new Promise((resolve) => lan.serveVod(src, { caps: { hevc: true } }, resolve));
    assert.ok(offered && /\/vod\//.test(offered), 'an HEVC-capable receiver should get a playlist, got ' + offered);
  } finally {
    try { lan.teardown(); } catch (e) {}
    fs.rmSync(dir, { recursive: true, force: true });
    restoreVod(prev);
  }
});

// ---- subtitles ---------------------------------------------------------------------------------

// An MKV with one embedded SRT track. Real extraction, real muxing — the point is that the cue text
// survives all the way from the source file to the .vtt the receiver fetches.
function subbedFixture(dir) {
  const srt = path.join(dir, 'sub.srt');
  fs.writeFileSync(srt, '1\n00:00:01,000 --> 00:00:04,000\nHELLO FROM THE FIXTURE\n\n' +
                        '2\n00:00:20,000 --> 00:00:24,000\nSECOND CUE\n\n');
  const out = path.join(dir, 'subbed.mkv');
  execFileSync(FFMPEG, ['-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=25:duration=40',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=40',
    '-i', srt,
    '-c:v', 'libx264', '-g', '250', '-keyint_min', '250', '-sc_threshold', '0', '-pix_fmt', 'yuv420p',
    // NO -shortest: the SRT is the shortest stream here, and it would truncate the film to the last
    // cue. The lavfi inputs already agree on 40s, so ffmpeg ends where they do.
    '-c:a', 'aac', '-c:s', 'srt', '-metadata:s:s:0', 'language=eng', out]);
  return out;
}

async function withSubbedVod(fn) {
  const prev = setVod(true);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spritz-vodsub-'));
  const lan = createLanServer({});
  try {
    const url = await new Promise((resolve) => lan.serveVod(subbedFixture(dir), {}, resolve));
    if (!url) return { skipped: true };
    await fn({ url, at: (n) => loopback(url, n), master: await get(loopback(url, 'master.m3u8')) });
  } finally {
    try { lan.teardown(); } catch (e) {}
    fs.rmSync(dir, { recursive: true, force: true });
    restoreVod(prev);
  }
  return { skipped: false };
}

test('a subtitled file is offered, and the master advertises the track', { skip: SKIP, timeout: 60000 }, async (t) => {
  const r = await withSubbedVod(async ({ url, master }) => {
    assert.ok(/\/master\.m3u8$/.test(url), 'a subtitled film must be handed a master, got ' + url);
    const body = master.body.toString();
    assert.ok(body.includes('#EXT-X-MEDIA:TYPE=SUBTITLES'), body);
    assert.ok(body.includes('LANGUAGE="eng"'), body);
    assert.ok(body.includes('SUBTITLES="subs"'), 'the variant must reference the group');
  });
  if (r.skipped) t.skip('no LAN address available');
});

test('the cue text survives from the source file to the served WebVTT', { skip: SKIP, timeout: 60000 }, async (t) => {
  const r = await withSubbedVod(async ({ at, master }) => {
    const body = master.body.toString();
    const uri = /URI="([^"]+)"/.exec(body)[1];
    const pl = await get(at(uri));
    assert.equal(pl.status, 200);
    const vttName = pl.body.toString().split('\n').find((l) => l.endsWith('.vtt'));
    assert.ok(vttName, pl.body.toString());

    const vtt = await get(at(vttName));
    assert.equal(vtt.status, 200);
    const text = vtt.body.toString();
    // The whole point: this string started life in an .srt, went through an MKV mux, an on-demand
    // ffmpeg extraction and a header rewrite.
    assert.ok(text.includes('HELLO FROM THE FIXTURE'), text.slice(0, 300));
    assert.ok(text.includes('SECOND CUE'), text.slice(0, 300));
    // And the anchor, without which some players render nothing at all.
    assert.ok(text.startsWith('WEBVTT'), text.slice(0, 60));
    assert.ok(text.includes('X-TIMESTAMP-MAP=MPEGTS:0,LOCAL:00:00:00.000'), text.slice(0, 120));
    assert.equal((text.match(/WEBVTT/g) || []).length, 1, 'ffmpeg\'s own header must be replaced, not duplicated');
  });
  if (r.skipped) t.skip('no LAN address available');
});

test('two simultaneous fetches of one subtitle extract it once', { skip: SKIP, timeout: 60000 }, async (t) => {
  const r = await withSubbedVod(async ({ at, master }) => {
    const uri = /URI="([^"]+)"/.exec(master.body.toString())[1];
    const pl = await get(at(uri));
    const vttName = pl.body.toString().split('\n').find((l) => l.endsWith('.vtt'));
    const [a, b] = await Promise.all([get(at(vttName)), get(at(vttName))]);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.ok(a.body.equals(b.body), 'a half-written .vtt renders as garbage or not at all');
  });
  if (r.skipped) t.skip('no LAN address available');
});

// ---- alternate audio ---------------------------------------------------------------------------

// Two audio languages and a subtitle track — the shape of an actual release, and the case the
// muxed segment cannot express.
function multiTrackFixture(dir) {
  const srt = path.join(dir, 'm.srt');
  fs.writeFileSync(srt, '1\n00:00:01,000 --> 00:00:04,000\nMULTI TRACK CUE\n\n');
  const out = path.join(dir, 'multi.mkv');
  execFileSync(FFMPEG, ['-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=25:duration=40',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=40',
    '-f', 'lavfi', '-i', 'sine=frequency=880:duration=40',
    '-i', srt,
    '-map', '0:v', '-map', '1:a', '-map', '2:a', '-map', '3:s',
    '-c:v', 'libx264', '-g', '250', '-keyint_min', '250', '-sc_threshold', '0', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-c:s', 'srt',
    '-metadata:s:a:0', 'language=eng', '-metadata:s:a:1', 'language=jpn',
    '-metadata:s:s:0', 'language=eng', out]); // no -shortest — see subbedFixture
  return out;
}

async function withMultiVod(fn) {
  const prev = setVod(true);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spritz-vodmulti-'));
  const lan = createLanServer({});
  try {
    const url = await new Promise((resolve) => lan.serveVod(multiTrackFixture(dir), {}, resolve));
    if (!url) return { skipped: true };
    const master = (await get(loopback(url, 'master.m3u8'))).body.toString();
    await fn({ at: (n) => loopback(url, n), master });
  } finally {
    try { lan.teardown(); } catch (e) {}
    fs.rmSync(dir, { recursive: true, force: true });
    restoreVod(prev);
  }
  return { skipped: false };
}

test('a multi-audio film is offered, with a rendition per language', { skip: SKIP, timeout: 60000 }, async (t) => {
  const r = await withMultiVod(async ({ master }) => {
    assert.equal((master.match(/#EXT-X-MEDIA:TYPE=AUDIO/g) || []).length, 2, master);
    assert.ok(master.includes('LANGUAGE="eng"'));
    assert.ok(master.includes('LANGUAGE="jpn"'));
    assert.ok(master.includes('AUDIO="aud"'), 'the variant must reference the audio group');
    assert.equal((master.match(/DEFAULT=YES/g) || []).length, 1, 'no default is silence; two is ambiguous');
    // Subtitles still ride alongside.
    assert.ok(master.includes('#EXT-X-MEDIA:TYPE=SUBTITLES'));
  });
  if (r.skipped) t.skip('no LAN address available');
});

test('each audio rendition has its own segments, aligned with the video', { skip: SKIP, timeout: 60000 }, async (t) => {
  const r = await withMultiVod(async ({ at, master }) => {
    const uris = [...master.matchAll(/TYPE=AUDIO[^\n]*URI="([^"]+)"/g)].map((m) => m[1]);
    assert.equal(uris.length, 2);
    const video = (await get(at('media.m3u8'))).body.toString();
    const videoSegs = video.split('\n').filter((l) => l.endsWith('.ts'));

    for (const uri of uris) {
      const pl = (await get(at(uri))).body.toString();
      const segs = pl.split('\n').filter((l) => l.endsWith('.ts'));
      // Segment-for-segment alignment is what makes a mid-film language switch land in the right
      // place rather than near it.
      assert.equal(segs.length, videoSegs.length, uri + ' does not line up with the video');
      const vDur = [...video.matchAll(/#EXTINF:([\d.]+)/g)].map((m) => m[1]);
      const aDur = [...pl.matchAll(/#EXTINF:([\d.]+)/g)].map((m) => m[1]);
      assert.deepEqual(aDur, vDur, uri + ' promises different durations than the video');
    }
  });
  if (r.skipped) t.skip('no LAN address available');
});

test('the two audio renditions carry genuinely different audio', { skip: SKIP, timeout: 60000 }, async (t) => {
  const r = await withMultiVod(async ({ at }) => {
    const eng = await get(at('a0_1.ts'));
    const jpn = await get(at('a1_1.ts'));
    assert.equal(eng.status, 200);
    assert.equal(jpn.status, 200);
    assert.ok(eng.body.length > 500 && jpn.body.length > 500);
    // 440Hz against 880Hz: if the track mapping were wrong these would be byte-identical, which is
    // exactly the failure a "both renditions play" check would miss.
    assert.ok(!eng.body.equals(jpn.body), 'both renditions returned the same audio — the track mapping is wrong');
  });
  if (r.skipped) t.skip('no LAN address available');
});

test('the picture segments carry no audio when audio is a separate rendition', { skip: SKIP, timeout: 60000 }, async (t) => {
  const r = await withMultiVod(async ({ at }) => {
    const v = await get(at('1.ts'));
    assert.equal(v.status, 200);
    assert.ok(v.body.length > 500);
    // Comparing bytes against the audio rendition proves nothing — they would differ either way.
    // Muxing audio into the video variant AND offering it as a rendition makes a player decode
    // both, so the question is what streams are actually IN the segment. Ask it.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spritz-vseg-'));
    try {
      const f = path.join(tmp, 'v.ts');
      fs.writeFileSync(f, v.body);
      const kinds = execFileSync(FFPROBE, ['-v', 'error', '-show_entries', 'stream=codec_type',
        '-of', 'csv=p=0', f]).toString().split('\n').map((l) => l.trim()).filter(Boolean);
      assert.ok(kinds.includes('video'), 'the picture segment has no video: ' + kinds.join(','));
      assert.ok(!kinds.includes('audio'), 'the picture segment still carries audio: ' + kinds.join(','));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
  if (r.skipped) t.skip('no LAN address available');
});

test('an audio segment for a track that does not exist is refused', { skip: SKIP, timeout: 60000 }, async (t) => {
  const r = await withMultiVod(async ({ at }) => {
    assert.equal((await get(at('a9_1.ts'))).status, 404);
    assert.equal((await get(at('a0_999.ts'))).status, 404);
  });
  if (r.skipped) t.skip('no LAN address available');
});

// ---- supersession ------------------------------------------------------------------------------

test('a second serveVod supersedes the first, and the first never hands out a dead URL', { skip: SKIP, timeout: 60000 }, async () => {
  // serveHls learned this the hard way and guards it by comparing a captured token. serveVod does
  // the same work asynchronously — two probes in flight, the second replacing `vod` under the
  // first — so without a guard the first caller gets a URL whose token was already thrown away and
  // every fetch against it 404s. Loading two files quickly is an ordinary thing to do.
  const prev = setVod(true);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spritz-vodrace-'));
  const lan = createLanServer({});
  try {
    const a = fixture(dir);
    const b = path.join(dir, 'second.mp4');
    fs.copyFileSync(a, b);
    const [first, second] = await Promise.all([
      new Promise((resolve) => lan.serveVod(a, {}, resolve)),
      new Promise((resolve) => lan.serveVod(b, {}, resolve))
    ]);
    // Whatever each caller was told, a URL that was handed out must WORK — or must not have been
    // handed out at all. Silently returning a dead one is the failure.
    for (const u of [first, second]) {
      if (!u) continue;
      const res = await get(loopback(u, 'media.m3u8'));
      assert.equal(res.status, 200, 'a URL was handed out that immediately 404s: ' + u);
    }
    assert.ok(second, 'the later request must succeed — it is the one the viewer is waiting for');
  } finally {
    try { lan.teardown(); } catch (e) {}
    fs.rmSync(dir, { recursive: true, force: true });
    restoreVod(prev);
  }
});

// ---- read-ahead --------------------------------------------------------------------------------

test('serving a segment primes the ones after it', { skip: SKIP, timeout: 60000 }, async (t) => {
  // Asserts the cushion exists — the part a "does it play?" check cannot see on a fast disk, where
  // a just-in-time cut and a primed one are indistinguishable.
  //
  // Note what this does NOT claim. On the LG the read-ahead does not stop the set firing `stalled`
  // at every segment boundary; it fires there regardless of whether the segment was already on
  // disk (see VOD_READAHEAD in lanserver.js for the measurement). The value here is that segment
  // production stays off the critical path, which is what these assertions check.
  const r = await withVod(async ({ seg }) => {
    const dir = newestSessionDir();

    assert.ok(!fs.existsSync(path.join(dir, '1.ts')), 'segment 1 should not exist before anything is asked for');
    const res = await get(seg(0));
    assert.equal(res.status, 200);

    // The read-ahead is fire-and-forget, so give the ffmpegs a moment to land.
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline && !fs.existsSync(path.join(dir, '2.ts'))) {
      await new Promise((r2) => setTimeout(r2, 250));
    }
    assert.ok(fs.existsSync(path.join(dir, '1.ts')), 'segment 1 was never primed');
    assert.ok(fs.existsSync(path.join(dir, '2.ts')), 'segment 2 was never primed');
    // ...and it is a CUSHION, not a pre-encode of the whole film — which is what this design exists
    // to avoid. The 40s fixture has 4 segments; segment 3 is two beyond 0 and must stay untouched.
    assert.ok(!fs.existsSync(path.join(dir, '3.ts')), 'read-ahead ran past its bound — that is a pre-encode');
  });
  if (r.skipped) t.skip('no LAN address available');
});

test('read-ahead near the end of the film does not run off it', { skip: SKIP, timeout: 60000 }, async (t) => {
  const r = await withVod(async ({ seg }) => {
    // The last segment: there is nothing after it to prime, and asking for one must not 500.
    const res = await get(seg(3));
    assert.equal(res.status, 200);
    await new Promise((r2) => setTimeout(r2, 1500));
    const again = await get(seg(3));
    assert.equal(again.status, 200, 'the session should still be healthy after a read-ahead at the end');
  });
  if (r.skipped) t.skip('no LAN address available');
});

// ---- subtitle rendition count ------------------------------------------------------------------

// A source with more text subtitle tracks than a receiver will tolerate in one master playlist.
// Twelve, not forty-two: enough to cross the cap of 8 with room either side, cheap enough to mux.
function fixtureWithSubs(dir, n) {
  const src = path.join(dir, 'many-subs.mkv');
  const args = ['-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=25:duration=40',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=40'];
  for (let i = 0; i < n; i++) {
    const srt = path.join(dir, 'sub' + i + '.srt');
    fs.writeFileSync(srt, '1\n00:00:01,000 --> 00:00:03,000\ntrack ' + i + '\n\n');
    args.push('-i', srt);
  }
  args.push('-map', '0:v', '-map', '1:a');
  for (let i = 0; i < n; i++) args.push('-map', String(i + 2));
  args.push('-c:v', 'libx264', '-g', '250', '-keyint_min', '250', '-sc_threshold', '0',
    '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-c:s', 'srt', '-shortest', src);
  execFileSync(FFMPEG, args);
  return src;
}

test('the master does not offer more subtitle renditions than the receiver will load', { skip: SKIP, timeout: 120000 }, async (t) => {
  // AVPlayer is the consumer of this route (main.js hands the /vod/ URL to the AirPlay launch), and
  // it walks EVERY rendition named in the master before it will show a frame. Measured on the cast
  // path and recorded on capSubSources: offering all 40 renditions of a release made AVFoundation
  // refuse the master outright — status=failed with an EMPTY error log, i.e. rejected without
  // fetching anything — where the same source at 8 loads and plays. The live-HLS path has capped
  // for that reason since; this route was built without the cap and would hand AVPlayer exactly the
  // manifest that was measured to fail. A real release of the file this was developed against has
  // 42 text tracks, so it is not a hypothetical shape.
  const prev = setVod(true);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spritz-vodsubs-'));
  const lan = createLanServer({});
  try {
    const url = await new Promise((resolve) => lan.serveVod(fixtureWithSubs(dir, 12), {}, resolve));
    if (!url) return t.skip('no LAN address available');
    const master = (await get(loopback(url, 'master.m3u8'))).body.toString();
    const renditions = (master.match(/^#EXT-X-MEDIA:TYPE=SUBTITLES/gm) || []).length;
    assert.ok(renditions > 0, 'the fixture should have produced subtitle renditions at all');
    assert.ok(renditions <= createLanServer.MAX_REMOTE_SIDELOAD_SUBS,
      'the master offered ' + renditions + ' subtitle renditions, past the cap of ' + createLanServer.MAX_REMOTE_SIDELOAD_SUBS);
  } finally {
    try { lan.teardown(); } catch (e) {}
    fs.rmSync(dir, { recursive: true, force: true });
    restoreVod(prev);
  }
});

// ---- cache eviction ----------------------------------------------------------------------------

// A film long enough to overflow the segment cache. VOD_CACHE_SEGMENTS is 40 and the GOP below is
// 10s, so 460s gives ~46 segments — past the bound with room to watch the eviction happen, and
// still a 320x180 encode that costs seconds.
function longFixture(dir) {
  const src = path.join(dir, 'long.mp4');
  execFileSync(FFMPEG, ['-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=25:duration=460',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=460',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '250', '-keyint_min', '250',
    '-sc_threshold', '0', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', src]);
  return src;
}

test('a watch-through past the cache bound evicts instead of keeping the whole film', { skip: SKIP, timeout: 600000 }, async (t) => {
  // The reason this route exists is that a film is hundreds of segments and the cache is 40, so
  // linear playback MUST evict — otherwise the "cache" is a second copy of the movie on a disk the
  // user did not agree to spend. Nothing had ever exercised that path: the longest real session
  // observed on hardware peaked at 25 segments, comfortably under the bound, so eviction had never
  // once run in anger.
  const prev = setVod(true);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spritz-vodlru-'));
  const lan = createLanServer({});
  const bound = createLanServer.VOD_CACHE_SEGMENTS;
  try {
    const url = await new Promise((resolve) => lan.serveVod(longFixture(dir), {}, resolve));
    if (!url) return t.skip('no LAN address available');
    const media = (await get(loopback(url, 'media.m3u8'))).body.toString();
    const count = (media.match(/^[0-9]+\.ts$/gm) || []).length;
    assert.ok(count > bound, 'the fixture produced ' + count + ' segments, which does not reach the cache bound of ' + bound);

    const cache = newestSessionDir();
    const onDisk = () => fs.readdirSync(cache).filter((f) => /\.ts$/.test(f)).length;

    // Watch it through in order, the way a viewer does.
    let peak = 0;
    for (let i = 0; i < count; i++) {
      const res = await get(loopback(url, i + '.ts'));
      assert.equal(res.status, 200, 'segment ' + i + ' should serve during a linear watch-through');
      peak = Math.max(peak, onDisk());
    }
    assert.ok(peak > bound - 4, 'the cache never filled (peak ' + peak + '), so this did not test eviction');
    // The read-ahead can carry a couple of in-flight segments past the bound; unbounded growth is
    // what this is guarding against, not an off-by-two.
    assert.ok(peak <= bound + 4, 'the cache grew to ' + peak + ' segments, past the bound of ' + bound);
    assert.ok(!fs.existsSync(path.join(cache, '0.ts')), 'segment 0 survived a whole film — nothing was evicted');
    // Evicted is not gone: a viewer who seeks back gets it re-cut on demand.
    const again = await get(loopback(url, '0.ts'));
    assert.equal(again.status, 200, 'an evicted segment should be re-produced when asked for again');
  } finally {
    try { lan.teardown(); } catch (e) {}
    fs.rmSync(dir, { recursive: true, force: true });
    restoreVod(prev);
  }
});

// ---- the run producer, end to end through the route ---------------------------------------------

test('with SPRITZ_VOD_RUN=1 the route serves valid segments through the run producer',
  { skip: SKIP || (!FFPROBE && 'ffprobe not installed'), timeout: 120000 }, async (t) => {
  // What this DOES cover: the run producer wired into the route end to end — a run starts, its
  // files land where segmentPath says, and what comes back over HTTP is a whole probeable segment
  // covering its EXTINF. That is the wiring, and it is new code with no other coverage.
  //
  // What this does NOT cover, stated plainly because the test was originally written to claim it:
  // the truncation race. A run writes progressively, so the segment being produced exists on disk
  // while still being appended to, and runSegmentReady exists to keep the route from serving it.
  // On this 40-second fixture the whole run finishes before the first poll, so the race never
  // occurs — the test was confirmed to pass with runSegmentReady deliberately replaced by a bare
  // existence check. The RULE is covered by the unit test in vod-segment.test.js; reproducing the
  // race here would need a fixture long enough that production is slower than a request, which
  // costs more than it is worth. Do not read a pass here as proof the race is handled.
  const prevRun = setRun(true);
  try {
    const r = await withVod(async ({ playlist, seg }) => {
      const pl = (await get(playlist)).body.toString();
      const spans = [...pl.matchAll(/#EXTINF:([0-9.]+),/g)].map((m) => parseFloat(m[1]));
      assert.ok(spans.length >= 3, 'the fixture should divide into several segments');

      for (let i = 0; i < Math.min(3, spans.length); i++) {
        const res = await get(seg(i));
        assert.equal(res.status, 200, 'segment ' + i + ' should be served');
        assert.ok(res.body.length > 0, 'segment ' + i + ' came back empty');

        const f = path.join(os.tmpdir(), 'spritz-runseg-' + process.pid + '-' + i + '.ts');
        fs.writeFileSync(f, res.body);
        try {
          const dur = parseFloat(execFileSync(FFPROBE, ['-v', 'error', '-show_entries',
            'format=duration', '-of', 'csv=p=0', f]).toString().trim());
          assert.ok(Number.isFinite(dur) && dur > 0,
            'segment ' + i + ' is not a probeable MPEG-TS');
          assert.ok(dur >= spans[i] * 0.5,
            'segment ' + i + ' holds ' + dur + 's but its EXTINF promises ' + spans[i] + 's');
        } finally {
          try { fs.unlinkSync(f); } catch (e) {}
        }
      }
    });
    if (r.skipped) t.skip('the route declined this fixture');
  } finally {
    restoreRun(prevRun);
  }
});
