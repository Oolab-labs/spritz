'use strict';

// The one thing an UNPAIRED television may ask the Mac.
//
// A receiver has to find Spritz before it can pair, and it cannot use mDNS: a webOS web application
// has no multicast and no raw sockets. So it probes addresses on the LAN, and needs an endpoint that
// answers "a Spritz is here" without being a hole.
//
// That makes this endpoint's RESTRAINT the whole point. It is reachable by anything on the network,
// before any trust exists, so it must reveal nothing beyond enough to recognise Spritz and show a
// human which machine they are pairing with.

const { test } = require('node:test');
const assert = require('assert');
const http = require('http');
const createLanServer = require('../src/main/lanserver');

function get(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    }).on('error', reject);
  });
}

async function withLan(fn) {
  const lan = createLanServer({});
  const server = await new Promise((res) => lan.ensureServer(res));
  try { await fn({ lan, base: 'http://127.0.0.1:' + server.address().port }); } finally { lan.teardown(); }
}

test('an unauthenticated probe identifies Spritz and nothing else', async () => {
  await withLan(async ({ base }) => {
    const res = await get(base + '/spritz/hello');
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.spritz, true, 'a receiver must be able to recognise Spritz');
    assert.equal(typeof body.name, 'string', 'a human pairing needs to see which machine this is');
    assert.ok(Number.isInteger(body.protocol), 'the receiver needs to know which protocol is spoken');
  });
});

// Everything a stranger must NOT be able to learn from it.
test('the probe reveals no receivers, no media and no credentials', async () => {
  await withLan(async ({ base }) => {
    const body = await get(base + '/spritz/hello').then((r) => r.body);
    const j = JSON.parse(body);
    for (const forbidden of ['receivers', 'paired', 'token', 'media', 'library', 'files', 'pending']) {
      assert.ok(!(forbidden in j), 'the probe exposed "' + forbidden + '" to an unauthenticated caller');
    }
    // A whole-body check as well, so a future field cannot smuggle something in under a new name.
    assert.ok(body.length < 300, 'the probe answer has grown — it should stay a bare identification');
  });
});

// The receiver fetches this with XHR from an app origin, so it is cross-origin.
test('the probe is reachable cross-origin', async () => {
  await withLan(async ({ base }) => {
    const res = await get(base + '/spritz/hello');
    assert.equal(res.headers['access-control-allow-origin'], '*');
  });
});
