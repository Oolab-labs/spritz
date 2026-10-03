'use strict';

// End-to-end over the /dlna/ proxy: does a ranged GET actually reach the torrent engine, and does
// the advertised profile actually change?
//
// The pure arithmetic is tested in seek-window.test.js and the flag strings in dlna-flags.test.js.
// Neither would notice the wiring being absent, which is the failure that matters here — the whole
// feature is one hook called from one branch, and a unit test of both ends passes happily while
// nothing connects them.

const { test } = require('node:test');
const assert = require('assert');
const http = require('http');

const createLanServer = require('../src/main/lanserver');
const { STATIC, LIVE } = require('../src/main/dlna-flags');

// Stands in for webtorrent's own HTTP server: answers ranged GETs and HEAD probes, nothing more.
function upstream() {
  const body = Buffer.alloc(1024, 7);
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const m = /^bytes=(\d+)-/.exec(String(req.headers.range || ''));
      const start = m ? Number(m[1]) : 0;
      res.writeHead(m ? 206 : 200, {
        'Content-Type': 'video/x-matroska',
        'Content-Length': String(body.length - start),
        'Content-Range': 'bytes ' + start + '-' + (body.length - 1) + '/' + body.length
      });
      res.end(body.slice(start));
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, url: 'http://127.0.0.1:' + srv.address().port + '/webtorrent/ab/Film.mkv' }));
  });
}

function get(url, headers) {
  return new Promise((resolve, reject) => {
    const r = http.get(url, { headers: headers || {} }, (res) => {
      res.resume();
      res.on('end', () => resolve(res));
    });
    r.on('error', reject);
  });
}

// The proxy hands out a LAN URL; in a test the LAN address may be anything, so talk to loopback on
// the port it chose and keep the path.
const loopback = (proxyUrl, port) => 'http://127.0.0.1:' + port + new URL(proxyUrl).pathname;

// Set/restore in plain synchronous helpers: assigning process.env directly after an await is a
// documented race-condition smell, and the linter is right that a shared global deserves the care.
function setSeek(on) {
  const prev = process.env.SPRITZ_TORRENT_SEEK;
  if (on) process.env.SPRITZ_TORRENT_SEEK = '1'; else delete process.env.SPRITZ_TORRENT_SEEK;
  return prev;
}
function restoreSeek(prev) {
  if (prev === undefined) delete process.env.SPRITZ_TORRENT_SEEK;
  else process.env.SPRITZ_TORRENT_SEEK = prev;
}

async function withProxy(seekEnv, fn) {
  const prev = setSeek(seekEnv);
  const up = await upstream();
  const seen = [];
  const lan = createLanServer({ onSeekBytes: (b) => seen.push(b) });
  try {
    const proxyUrl = await new Promise((resolve) => lan.serveDlna(up.url, 'video/x-matroska', resolve));
    if (!proxyUrl) return { skipped: true };  // no LAN address on this machine
    const port = new URL(proxyUrl).port;
    await fn({ url: loopback(proxyUrl, port), seen });
  } finally {
    try { lan.teardown(); } catch (e) {}
    up.srv.close();
    restoreSeek(prev);
  }
  return { skipped: false };
}

test('by default the proxy advertises the un-seekable profile and never asks for pieces', async (t) => {
  const r = await withProxy(false, async ({ url, seen }) => {
    const res = await get(url, { Range: 'bytes=500-' });
    assert.equal(res.headers['contentfeatures.dlna.org'], LIVE);
    assert.deepEqual(seen, [], 'nothing should be prioritised while seeking is off');
  });
  if (r.skipped) t.skip('no LAN address available');
});

test('with the opt-in, a ranged GET both advertises seekability and prioritises the pieces', async (t) => {
  const r = await withProxy(true, async ({ url, seen }) => {
    const res = await get(url, { Range: 'bytes=500-' });
    assert.equal(res.headers['contentfeatures.dlna.org'], STATIC);
    assert.deepEqual(seen, [500], 'the byte the receiver asked for must reach the torrent engine');
  });
  if (r.skipped) t.skip('no LAN address available');
});

test('the opening request of linear playback is not treated as a seek', async (t) => {
  const r = await withProxy(true, async ({ url, seen }) => {
    await get(url, { Range: 'bytes=0-' });
    await get(url, {});
    assert.deepEqual(seen, [], 'bytes=0- and an unranged GET are how playback starts, not a jump');
  });
  if (r.skipped) t.skip('no LAN address available');
});

test('the body still arrives — prioritising must not block the response', async (t) => {
  // The hook is fire-and-forget precisely so headers are not delayed. A hook that hangs must not
  // stop the proxy answering, because on real hardware that hang is the swarm.
  const prev = setSeek(true);
  const up = await upstream();
  const lan = createLanServer({ onSeekBytes: () => { /* never calls back */ } });
  try {
    const proxyUrl = await new Promise((resolve) => lan.serveDlna(up.url, 'video/x-matroska', resolve));
    if (!proxyUrl) return t.skip('no LAN address available');
    const res = await get(loopback(proxyUrl, new URL(proxyUrl).port), { Range: 'bytes=500-' });
    assert.equal(res.statusCode, 206);
    assert.equal(res.headers['content-range'], 'bytes 500-1023/1024');
  } finally {
    try { lan.teardown(); } catch (e) {}
    up.srv.close();
    restoreSeek(prev);
  }
});
