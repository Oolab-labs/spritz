'use strict';

// The LAN media server, exercised over real HTTP.
//
// This is the widest genuine exposure Spritz has: it binds 0.0.0.0 so televisions can reach it,
// which means everything on the network can too. Access control is a 128-bit random token in the
// path — there is no other gate — so the properties worth pinning are that the token is actually
// required, that it is unguessable, and that a token grants exactly one file rather than a
// foothold in the directory around it.
//
// Nothing tested casting before, because casting needed a television. It does not need one to
// answer these questions.

const { test } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const createLan = require('../src/main/lanserver.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spritz-lan-'));
const media = path.join(tmp, 'Movie.mp4');
const secret = path.join(tmp, 'secret.txt');
fs.writeFileSync(media, 'PRETEND-MP4-BYTES');
fs.writeFileSync(secret, 'TOP SECRET');

function get(url, headers) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { headers: headers || {} }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: d }));
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('timeout')));
  });
}

// lanAddress() returns null when there is no non-loopback private IPv4 (an offline CI runner), and
// serve() then yields no URL. Skip rather than fail: the guard being tested is in the request
// handler, not in the address lookup, and a red suite on a laptop with wifi off teaches nothing.
const lan = createLan({});
const served = new Promise((resolve) => lan.serve(media, resolve));

test('a valid token serves the file it was issued for', async (t) => {
  const url = await served;
  if (!url) return t.skip('no LAN address available on this machine');
  const res = await get(url);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body, 'PRETEND-MP4-BYTES');
});

test('the token is required, and unguessable', async (t) => {
  const url = await served;
  if (!url) return t.skip('no LAN address available on this machine');
  const base = url.slice(0, url.indexOf('/file/'));
  const token = url.split('/file/')[1].split('/')[0];

  assert.match(token, /^[0-9a-f]{32}$/, '128 bits of hex — the only thing gating LAN access');

  for (const bad of ['/file/', '/file/0000000000000000000000000000000/x.mp4',
    // A near-miss token: the real one with its LAST character changed. Flipped conditionally,
    // because hardcoding '0' reconstructs the real token whenever it happens to end in '0' — a
    // 1-in-16 flake that made this test intermittently claim the server leaked a file it had every
    // right to serve.
    '/file/' + token.slice(0, -1) + (token.endsWith('0') ? '1' : '0') + '/x.mp4', '/']) {
    const res = await get(base + bad);
    assert.notStrictEqual(res.status, 200, bad + ' must not serve content');
    assert.ok(!res.body.includes('PRETEND-MP4-BYTES'), bad + ' must not leak the file');
  }
});

test('a token grants one file, not the directory around it', async (t) => {
  const url = await served;
  if (!url) return t.skip('no LAN address available on this machine');
  const base = url.slice(0, url.indexOf('/file/'));
  const token = url.split('/file/')[1].split('/')[0];

  // The filename after the token is cosmetic — the server resolves the token, not the name — so
  // these must all either serve the SAME file or refuse, and must never reach a sibling.
  for (const tail of ['/secret.txt', '/../secret.txt', '/%2e%2e%2fsecret.txt',
    '/..%2f..%2fetc%2fpasswd']) {
    const res = await get(base + '/file/' + token + tail);
    assert.ok(!res.body.includes('TOP SECRET'), tail + ' must not reach a sibling file');
  }
});

test('suffix, open and ignored ranges retain correct HTTP bodies', async (t) => {
  const url = await served;
  if (!url) return t.skip('no LAN address');
  for (const [range, status, body] of [
    ['bytes=-5', 206, 'BYTES'], ['bytes=12-', 206, 'BYTES'],
    ['bytes=-999999999999999999999999', 206, 'PRETEND-MP4-BYTES'],
    ['items=0-1', 200, 'PRETEND-MP4-BYTES'],
    ['bytes=0-1,4-5', 200, 'PRETEND-MP4-BYTES'],
    ['junk bytes=0-1', 200, 'PRETEND-MP4-BYTES'],
    ['bytes=-0', 416, ''], ['bytes=999999999999999999999-', 416, '']
  ]) {
    const result = await get(url, { Range: range });
    assert.strictEqual(result.status, status, range);
    assert.strictEqual(result.body, body, range);
  }
});

test('abandoned full and partial requests destroy their file readers', async (t) => {
  const url = await served;
  if (!url) return t.skip('no LAN address');
  const original = fs.createReadStream;
  const { PassThrough } = require('stream');
  try {
    for (const headers of [{}, { Range: 'bytes=0-6' }]) {
      let source;
      const closed = new Promise((resolve) => {
        fs.createReadStream = () => {
          source = new PassThrough();
          source.once('close', resolve);
          source.write('P');
          return source;
        };
      });
      await new Promise((resolve, reject) => {
        const request = http.get(url, { headers }, (response) => {
          response.once('data', () => { response.destroy(); resolve(); });
        });
        request.on('error', reject);
        request.setTimeout(2000, () => request.destroy(new Error('timeout')));
      });
      await Promise.race([closed, new Promise((_, reject) => {
        const timer = setTimeout(() => reject(new Error('reader remained open')), 2000);
        closed.then(() => clearTimeout(timer));
      })]);
      assert.ok(source.destroyed);
    }
  } finally { fs.createReadStream = original; }
});

test('range requests are answered with 206 and the right slice', async (t) => {
  // AVPlayer rejects the whole stream if a Range request gets a plain 200, so this is a
  // correctness property for AirPlay, not only a nicety.
  const url = await served;
  if (!url) return t.skip('no LAN address available on this machine');
  const res = await get(url, { Range: 'bytes=0-6' });
  assert.strictEqual(res.status, 206);
  assert.strictEqual(res.body, 'PRETEND');
  assert.strictEqual(res.headers['content-range'], 'bytes 0-6/17');
});

test('an unsatisfiable range is refused rather than served whole', async (t) => {
  const url = await served;
  if (!url) return t.skip('no LAN address available on this machine');
  const res = await get(url, { Range: 'bytes=9999-' });
  assert.strictEqual(res.status, 416);
});

test('cleanup', () => {
  lan.teardown();
  fs.rmSync(tmp, { recursive: true, force: true });
});

// The probe asks ffprobe for an explicit field list, and a field that is not requested is simply
// absent from the JSON — no error, no warning. That bit us: `stream_side_data=side_data_type` said
// a stream carried Dolby Vision but never which profile, so every DV file looked like "profile
// unknown", was refused the cheap strip it qualified for, and went to a 4K H.264 re-encode the
// receiver would not play. The symptom was a TV on its idle screen, about as far from the cause as
// a symptom gets. Pin the fields whose absence silently changes the decision.
test('the probe asks for the Dolby Vision fields the plan depends on', () => {
  const { PROBE_ENTRIES } = require('../src/main/lanserver.js');
  assert.ok(PROBE_ENTRIES, 'the probe field list should be exported');
  assert.match(PROBE_ENTRIES, /dv_profile/, 'without dv_profile every DV file is "profile unknown"');
  assert.match(PROBE_ENTRIES, /dv_bl_signal_compatibility_id/, 'compatibility id says what the base layer really is');
  assert.match(PROBE_ENTRIES, /side_data_type/, 'still needed to spot DV at all');
  // The side-data list is only populated when stream_side_data is requested in the first place.
  assert.match(PROBE_ENTRIES, /stream_side_data=/, 'side data must be requested, not assumed');
});

// The cast stream is a live pipe with no seeking and no known length, so what the receiver is told
// has to match what the socket actually delivers. Those two facts lived in three places and had
// already drifted: the server sent Matroska, one call site declared Matroska, the other fell through
// to a video/mp4 guess because a /mkv/ token URL has no file extension.
test('the cast route publishes the container it actually serves', () => {
  const lan = require('../src/main/lanserver.js')({ onWarn: () => {} });
  assert.equal(typeof lan.castMime, 'function', 'call sites need to read the type, not restate it');
  assert.match(lan.castMime(), /^video\//, 'should be a video MIME type');
  lan.teardown();
});

test('repeated aborted file responses close actual owned descriptors', { timeout: 10000 }, async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spritz-abort-fd-'));
  const lan = createLan({});
  t.after(() => { lan.teardown(); fs.rmSync(tmp, { recursive: true, force: true }); });
  const small = path.join(tmp, 'small.mp4'); fs.writeFileSync(small, 'PRETEND-MP4-BYTES');
  const served = new Promise(resolve => lan.serve(small, resolve));
  const file = path.join(tmp, 'abort-large.mp4');
  fs.writeFileSync(file, 'P'); fs.truncateSync(file, 64 * 1024 * 1024);
  const url = await new Promise(resolve => lan.serve(file, resolve));
  assert.ok(url, 'a media endpoint is required for descriptor-drain verification');
  const original = fs.createReadStream;
  let reader, closed;
  t.mock.method(fs, 'createReadStream', (input, options) => {
    const stream = original.call(fs, input, options);
    if (input === file) {
      reader = stream;
      closed = new Promise(resolve => stream.once('close', resolve));
    }
    return stream;
  });
  for (let i = 0; i < 6; i++) {
    await new Promise((resolve, reject) => {
      const request = http.get(url, { headers: i % 2 ? { Range: 'bytes=0-33554431' } : {} }, response => {
        response.once('data', () => {
          try { assert.ok(Number.isInteger(reader.fd), 'abort must happen with a real open descriptor'); }
          catch (error) { response.destroy(); reject(error); return; }
          response.destroy(); resolve();
        });
      });
      request.on('error', reject);
      request.setTimeout(2000, () => request.destroy(new Error('response timeout')));
    });
    await closed;
    assert.equal(reader.fd, null);
    assert.equal(reader.closed, true);
  }
  const other = await get(await served);
  assert.equal(other.status, 200); assert.equal(other.body, 'PRETEND-MP4-BYTES');
});
