'use strict';

// A response must deliver the Content-Length it declares.
//
// serveFile stats the file, writes Content-Length from that stat, and only THEN opens the read
// stream. The LRU can unlink a segment inside that window — touchSegment's guard covers segments
// being PRODUCED (procs/waiters) but nothing that is being SERVED, despite its comment claiming
// "never delete something being produced or served right now". When it fires, createReadStream
// errors, the handler calls res.end() having written zero bytes, and the socket is left holding a
// response short of its declared length. On keep-alive the client then reads the NEXT response as
// the previous body and fails with HPE_INVALID_CONSTANT ("Expected HTTP/, RTSP/ or ICE/") — which is
// how this surfaced: an intermittent parse error in the LRU watch-through test, on a socket that had
// nothing wrong with it.
//
// So this asserts the invariant directly rather than waiting for the parse error to reappear.

const os = require('os');
const fs = require('fs');
const path = require('path');
process.env.TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'spritz-testroot-'));

const { test } = require('node:test');
const assert = require('assert');
const http = require('http');
const { execFileSync } = require('child_process');

// Force the window rather than wait for it. The natural race is a few microseconds wide between
// serveFile's stat and its open, so hammering the route does NOT reproduce it (measured: a full
// watch-through with three concurrent requests per segment passed clean). Deleting the file inside
// createReadStream reproduces exactly the state the LRU leaves behind — stat succeeded, the file is
// gone by the time the stream opens — and nothing else about the server is altered.
let evictOnce = null;
const realCreateReadStream = fs.createReadStream;
fs.createReadStream = function (file, opts) {
  if (evictOnce && typeof file === 'string' && file.endsWith(evictOnce)) {
    evictOnce = null;
    try { fs.unlinkSync(file); } catch (e) {}
  }
  return realCreateReadStream.call(this, file, opts);
};

const createLanServer = require('../src/main/lanserver');

const FFMPEG = ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg'].find((p) => fs.existsSync(p));
const SKIP = !FFMPEG && 'ffmpeg not installed';

function setVod(on) {
  const prev = process.env.SPRITZ_VOD;
  if (on) process.env.SPRITZ_VOD = '1'; else delete process.env.SPRITZ_VOD;
  return prev;
}
function restoreVod(prev) {
  if (prev === undefined) delete process.env.SPRITZ_VOD; else process.env.SPRITZ_VOD = prev;
}

// Long enough to pass the cache bound, so eviction actually runs.
function longFixture(dir) {
  const src = path.join(dir, 'long.mp4');
  execFileSync(FFMPEG, ['-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=25:duration=600',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=600',
    '-c:v', 'libx264', '-g', '25', '-keyint_min', '25', '-sc_threshold', '0',
    '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', src]);
  return src;
}

// Deliberately NOT using a helper that hides the mismatch: the whole point is to compare the bytes
// that arrived against the Content-Length that was promised.
function getChecked(url) {
  return new Promise((resolve, reject) => {
    // A deadline, because the first symptom of this bug is not a wrong answer but NO answer: the
    // response promises N bytes, sends none, and never ends, so a plain get() hangs forever rather
    // than failing. Resolving with timedOut lets the assertion name what happened.
    const req = http.get(url, (res) => {
      let n = 0;
      res.on('data', (c) => { n += c.length; });
      res.on('end', () => {
        clearTimeout(timer);
        resolve({
          status: res.statusCode,
          declared: res.headers['content-length'] === undefined ? null : Number(res.headers['content-length']),
          received: n,
          timedOut: false
        });
      });
    });
    const timer = setTimeout(() => { try { req.destroy(); } catch (e) {} resolve({ timedOut: true }); }, 5000);
    // A destroyed socket is one of the two ACCEPTABLE outcomes: the server promised a length it
    // cannot deliver, and cutting the connection is how it says so. What must not happen is a
    // silent short body or a response that never ends.
    req.on('error', (e) => {
      clearTimeout(timer);
      if (e && (e.code === 'ECONNRESET' || /socket hang up/i.test(e.message))) return resolve({ aborted: true });
      reject(e);
    });
  });
}

const loopback = (u, name) => { const p = new URL(u); return 'http://127.0.0.1:' + p.port + p.pathname.replace(/[^/]+$/, name); };

test('a segment evicted while it is being served still delivers its declared length',
  { skip: SKIP, timeout: 600000 }, async (t) => {
  const prev = setVod(true);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spritz-evictrace-'));
  const lan = createLanServer({});
  const bound = createLanServer.VOD_CACHE_SEGMENTS;
  try {
    const url = await new Promise((resolve) => lan.serveVod(longFixture(dir), {}, resolve));
    if (!url) return t.skip('no LAN address available');
    const media = (await getCheckedBody(loopback(url, 'media.m3u8'))).body;
    const count = (media.match(/^[0-9]+\.ts$/gm) || []).length;
    assert.ok(count > bound, 'fixture produced ' + count + ' segments, under the bound of ' + bound);

    // Warm it so the segment exists and the request takes the serve path, not the produce path.
    assert.equal((await getChecked(loopback(url, '3.ts'))).status, 200);

    // Now lose 3.ts inside serveFile's stat->open window.
    evictOnce = '3.ts';
    const r = await getChecked(loopback(url, '3.ts'));

    // Either answer is acceptable — a clean error, or the bytes. What is NOT acceptable is a
    // response that promises a length and then delivers less, because that desynchronises the
    // keep-alive socket and the NEXT response on it is read as this one's body.
    assert.ok(!r.timedOut, 'the response never completed — it declared a length and then sent nothing');
    if (!r.aborted && r.declared !== null && r.status === 200) {
      assert.equal(r.received, r.declared,
        'declared Content-Length ' + r.declared + ' but sent ' + r.received + ' bytes');
    }

    // And the socket must still be usable afterwards: this is the actual observed symptom.
    const after = await getChecked(loopback(url, '4.ts'));
    assert.ok(!after.timedOut, 'the next request on the connection never completed');
    assert.equal(after.status, 200, 'the next request on the connection should still work');
  } finally {
    try { lan.teardown(); } catch (e) {}
    fs.rmSync(dir, { recursive: true, force: true });
    restoreVod(prev);
  }
});

function getCheckedBody(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    }).on('error', reject);
  });
}


