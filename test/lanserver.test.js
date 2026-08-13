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
    '/file/' + token.slice(0, -1) + '0/x.mp4', '/']) {
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
