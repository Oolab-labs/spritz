'use strict';

// What source bytes is the PACKAGER reading, right now?
//
// During torrent-backed playback the packager (ffmpeg) reads the torrent through this module's
// HTTP proxy, and the torrent scheduler needs to know where that read is so the swarm can be aimed
// at it — see critical-authority.js for why the producer, not the viewer, is the authority while
// packaging is active. The proxy is the one place that demand is DIRECTLY observable, as opposed to
// inferred from which segment number ffmpeg has most recently written.
//
// Measured against a real ffmpeg (scratchpad, 2026-09-03) before this was designed:
//
//   - a seek is a NEW Range request whose start is the exact demand point: `-ss 30` on a Matroska
//     file produced bytes=0- (header), bytes=1618166- (the Cues, at the tail), bytes=755085- (the
//     target), each a fresh request;
//   - linear packaging is ONE Range request held open for the whole read. A Range header therefore
//     arrives once, and the ongoing position is only visible as bytes delivered through that one
//     response. So both are reported: the range start at open, and the advancing position after.
//
// Bytes DELIVERED run ahead of bytes ffmpeg has CONSUMED by the socket buffers — on the measured
// run a header read had 917 KB delivered when ffmpeg wanted a few KB. That makes the position an
// upper bound in the AHEAD direction, which is the harmless direction for aiming priority; a log
// should call it what it is.

const { test } = require('node:test');
const assert = require('assert');
const http = require('http');

const createLanServer = require('../src/main/lanserver');

const SIZE = 4 * 1024 * 1024; // several coalescing windows, so progress has room to be observed

// Stands in for webtorrent's HTTP server. `delayMs` between chunks makes a response take long
// enough that the proxy's progress reports are separable in time from its open and close.
function upstream(delayMs = 0) {
  const body = Buffer.alloc(SIZE, 0x47);
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const m = /^bytes=(\d+)-(\d*)/.exec(String(req.headers.range || ''));
      const start = m ? Number(m[1]) : 0;
      const end = m && m[2] ? Number(m[2]) : SIZE - 1;
      res.writeHead(m ? 206 : 200, { 'Content-Type': 'video/x-matroska',
        'Content-Length': String(end - start + 1), 'Content-Range': 'bytes ' + start + '-' + end + '/' + SIZE });
      let at = start;
      const step = () => {
        if (at > end) return res.end();
        const n = Math.min(64 * 1024, end - at + 1);
        res.write(body.subarray(at, at + n)); at += n;
        if (delayMs) setTimeout(step, delayMs); else setImmediate(step);
      };
      step();
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, url: 'http://127.0.0.1:' + srv.address().port + '/webtorrent/ab/Film.mkv' }));
  });
}

// Read a response fully, or only `upTo` bytes and then let go — the second is what ffmpeg does
// when it has the header it wanted and seeks elsewhere.
function read(url, { range, upTo } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.get(url, { headers: range ? { Range: range } : {} }, (res) => {
      let n = 0;
      res.on('data', (c) => { n += c.length; if (upTo && n >= upTo) { res.destroy(); resolve({ status: res.statusCode, got: n, letGo: true }); } });
      res.on('end', () => resolve({ status: res.statusCode, got: n, letGo: false }));
      res.on('error', () => resolve({ status: res.statusCode, got: n, letGo: true }));
    });
    r.on('error', reject);
  });
}

// A close is observed when the SERVER notices the socket go, which is a tick or two after a client
// that abandoned the read has already moved on. Bounded wait rather than a sleep.
async function untilSeen(seen, pred, ms = 2000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const hit = seen.find(pred);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 10));
  }
  return null;
}

async function withSource(delayMs, fn) {
  const up = await upstream(delayMs);
  const seen = [];
  const lan = createLanServer({ onSourceRead: (o) => seen.push(Object.assign({ t: Date.now() }, o)) });
  try {
    const url = await new Promise((resolve) => lan.serveSource(up.url, resolve));
    assert.ok(url, 'a source URL is handed out');
    await fn({ url, seen, lan });
  } finally {
    try { lan.teardown(); } catch (e) {}
    up.srv.close();
  }
}

test('the source URL is loopback: it is for the packager on this machine, never a television', async () => {
  await withSource(0, async ({ url }) => {
    assert.equal(new URL(url).hostname, '127.0.0.1');
  });
});

test('opening a range reports its exact start as the demand point', async () => {
  await withSource(0, async ({ url, seen }) => {
    await read(url, { range: 'bytes=755085-' });
    const open = seen.find((o) => o.event === 'open');
    assert.ok(open, 'an open was reported');
    assert.equal(open.reader, 'producer');
    assert.equal(open.byteStart, 755085);
    assert.equal(open.position, 755085, 'at open nothing has been delivered yet');
  });
});

test('a response held open reports its ADVANCING position, coalesced', async () => {
  await withSource(2, async ({ url, seen }) => {
    await read(url, { range: 'bytes=0-' });
    const progress = seen.filter((o) => o.event === 'progress');
    assert.ok(progress.length >= 2, 'position was reported more than once during one response (got ' + progress.length + ')');
    for (let i = 1; i < progress.length; i++) {
      assert.ok(progress[i].position > progress[i - 1].position, 'positions advance');
      assert.ok(progress[i].position - progress[i - 1].position >= createLanServer.SOURCE_READ_COALESCE_BYTES,
        'reports are at least a coalescing window apart, so a fast read does not become a firehose');
    }
    assert.ok(progress.length <= Math.ceil(SIZE / createLanServer.SOURCE_READ_COALESCE_BYTES) + 1, 'and bounded by the body size');
  });
});

test('closing reports the final position and whether the reader let go early', async () => {
  await withSource(0, async ({ url, seen }) => {
    await read(url, { range: 'bytes=0-' });
    const done = await untilSeen(seen, (o) => o.event === 'close');
    assert.ok(done, 'a close was reported');
    assert.equal(done.position, SIZE, 'a complete read ends at the end of the range');
    assert.equal(done.complete, true);

    seen.splice(0); // not `seen.length = 0` after an await: require-atomic-updates
    const early = await read(url, { range: 'bytes=0-', upTo: 128 * 1024 });
    assert.equal(early.letGo, true);
    const closed = await untilSeen(seen, (o) => o.event === 'close');
    assert.ok(closed, 'letting go is still reported');
    assert.equal(closed.complete, false, 'a read the client abandoned is not a complete one');
    assert.ok(closed.position < SIZE, 'and the position stops where delivery did');
  });
});

test('the television\'s DLNA proxy reads are attributed to the viewer, not the producer', async () => {
  const up = await upstream(0);
  const seen = [];
  const lan = createLanServer({ onSourceRead: (o) => seen.push(o) });
  try {
    const url = await new Promise((resolve) => lan.serveDlna(up.url, 'video/x-matroska', resolve));
    if (!url) return; // no LAN address on this machine
    const p = new URL(url);
    await read('http://127.0.0.1:' + p.port + p.pathname, { range: 'bytes=4096-' });
    const open = seen.find((o) => o.event === 'open');
    assert.ok(open, 'the DLNA route reports too — the arbiter needs the viewer side as well');
    assert.equal(open.reader, 'viewer');
    assert.equal(open.byteStart, 4096);
  } finally {
    try { lan.teardown(); } catch (e) {}
    up.srv.close();
  }
});

test('a producer seek is NOT a viewer seek: it reaches onSourceRead, never onSeekBytes', async () => {
  // onSeekBytes leads to torrent.ensureBytes, which moves the viewer's playhead. That is right for
  // a television and exactly wrong for the packager, whose header/index/target reads would
  // otherwise drag the viewer's position around the file.
  const prev = setSeek(true);
  const up = await upstream(0);
  const seeks = [], seen = [];
  const lan = createLanServer({ onSeekBytes: (b) => seeks.push(b), onSourceRead: (o) => seen.push(o) });
  try {
    const url = await new Promise((resolve) => lan.serveSource(up.url, resolve));
    await read(url, { range: 'bytes=755085-' });
    assert.deepEqual(seeks, [], 'the producer never touched the viewer-seek hook');
    assert.equal(seen.find((o) => o.event === 'open').byteStart, 755085, 'and its demand went out as a source read');
  } finally {
    try { lan.teardown(); } catch (e) {}
    up.srv.close();
    restoreSeek(prev);
  }
});

// Plain synchronous set/restore, for the reason torrent-seek-proxy.test.js gives: assigning
// process.env after an await trips require-atomic-updates, and the linter is right.
function setSeek(on) {
  const prev = process.env.SPRITZ_TORRENT_SEEK;
  if (on) process.env.SPRITZ_TORRENT_SEEK = '1'; else delete process.env.SPRITZ_TORRENT_SEEK;
  return prev;
}
function restoreSeek(prev) {
  if (prev === undefined) delete process.env.SPRITZ_TORRENT_SEEK; else process.env.SPRITZ_TORRENT_SEEK = prev;
}
