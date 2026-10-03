'use strict';

// A response must deliver EXACTLY the Content-Length it promised — no fewer bytes, and no more.
//
// Both directions were live. serveFile stats the file, commits Content-Length from that stat, and
// then opens a read stream with no `end`, so the body is "whatever the file holds by the time it is
// read". If the file has GROWN since the stat — a segment still being written by the read-ahead's
// ffmpeg, which ensureSegment serves on existence alone — the response carries more bytes than it
// declared, and on a keep-alive socket the surplus is parsed as the NEXT response's status line.
// That is the exact wire signature that surfaced in the LRU watch-through test:
//
//   HPE_INVALID_CONSTANT, bytesParsed: 0, rawPacket: <ff ff ff ff ...>   (MPEG-TS stuffing)
//
// If the file has SHRUNK — evicted or truncated after the stream opened — the stream simply ends
// early with no error, res.end() is called as though the body were complete, and the client is
// left waiting for bytes that will never come on a socket the server thinks is reusable.
//
// The rule these tests hold serveFile to: a complete body keeps the connection; anything else must
// not leave that socket usable for another request. Forced deterministically by hooking
// fs.createReadStream, the same technique vod-evict-race.test.js uses — the natural windows are
// microseconds wide and no amount of hammering reproduces them on purpose.

const os = require('os');
const fs = require('fs');
const path = require('path');
process.env.TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'spritz-framing-'));

const { test } = require('node:test');
const assert = require('assert');
const http = require('http');

// The hook. `mutate` runs with the file path once serveFile has committed its headers and is
// opening the stream — i.e. AFTER the stat that sized Content-Length.
let mutate = null;
const realCreateReadStream = fs.createReadStream;
fs.createReadStream = function (file, opts) {
  if (mutate && typeof file === 'string') { const m = mutate; mutate = null; m(file); }
  return realCreateReadStream.call(this, file, opts);
};

const createLanServer = require('../src/main/lanserver');

const SIZE = 200 * 1024; // larger than one read chunk, so a truncation lands before the body is done

// One keep-alive socket, so the second request MUST reuse the first one's connection if the
// server left it open. That reuse is the whole question.
function agent() { return new http.Agent({ keepAlive: true, maxSockets: 1 }); }

function get(url, ag, deadlineMs = 4000) {
  return new Promise((resolve) => {
    const req = http.get(url, { agent: ag }, (res) => {
      let n = 0;
      res.on('data', (c) => { n += c.length; });
      res.on('end', () => { clearTimeout(timer); resolve({ status: res.statusCode, declared: Number(res.headers['content-length']), got: n, complete: res.complete }); });
      res.on('error', (e) => { clearTimeout(timer); resolve({ error: e.code || e.message, declared: Number(res.headers['content-length']), got: n }); });
      res.on('aborted', () => { clearTimeout(timer); resolve({ error: 'aborted', declared: Number(res.headers['content-length']), got: n }); });
    });
    req.on('error', (e) => { clearTimeout(timer); resolve({ error: e.code || e.message }); });
    const timer = setTimeout(() => { req.destroy(); resolve({ error: 'timed out' }); }, deadlineMs);
  });
}

const loopback = (u) => { const p = new URL(u); return 'http://127.0.0.1:' + p.port + p.pathname; };

async function withServed(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spritz-framefix-'));
  const file = path.join(dir, 'seg.ts');
  fs.writeFileSync(file, Buffer.alloc(SIZE, 0x47));
  const lan = createLanServer({});
  const ag = agent();
  try {
    const url = await new Promise((r) => lan.serve(file, r));
    assert.ok(url, 'the file is served');
    await fn({ url: loopback(url), file, ag });
  } finally {
    ag.destroy();
    try { lan.teardown(); } catch (e) {}
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('a complete body keeps the keep-alive connection', async () => {
  await withServed(async ({ url, ag }) => {
    const a = await get(url, ag);
    assert.equal(a.status, 200); assert.equal(a.got, a.declared, 'delivered what was promised');
    const b = await get(url, ag);
    assert.equal(b.status, 200, 'the second request on the same socket is answered');
    assert.equal(b.got, b.declared);
  });
});

test('a file that GREW after the stat must not deliver more than it promised', async () => {
  // The read-ahead shape: stat sees a partial segment, ffmpeg keeps appending.
  await withServed(async ({ url, file, ag }) => {
    mutate = (f) => fs.appendFileSync(f, Buffer.alloc(64 * 1024, 0xff));
    const a = await get(url, ag);
    assert.equal(a.status, 200, 'the grown file still serves a valid response (got ' + JSON.stringify(a) + ')');
    assert.equal(a.got, a.declared, 'a response is exactly its Content-Length, whatever the file has become');
    // The bytes the file grew by must not be sitting on the socket waiting to poison the next reply.
    const b = await get(url, ag);
    assert.notEqual(b.error, 'HPE_INVALID_CONSTANT', 'surplus body bytes were parsed as the next response');
    assert.equal(b.status, 200, 'the next request on that socket is a clean response (got ' + JSON.stringify(b) + ')');
  });
});

test('a file that SHRANK after the stream opened must not leave the socket reusable', async () => {
  // The eviction shape: the stat succeeded, the open succeeded, then the LRU took the file away.
  await withServed(async ({ url, file, ag }) => {
    mutate = (f) => fs.truncateSync(f, 16 * 1024);
    const a = await get(url, ag);
    // The first response is a failure whichever way it is reported — the point is what it is NOT:
    // a clean, complete-looking response that under-delivered.
    assert.ok(a.error || a.got < a.declared, 'the short body was not passed off as complete');
    assert.notEqual(a.complete, true, 'a short body is not a complete response');
    // And the socket it happened on is gone, so the next request gets a fresh one and a real answer.
    const b = await get(url, ag);
    assert.equal(b.status, 200, 'the next request is answered on a fresh connection');
    assert.equal(b.got, b.declared);
  });
});
