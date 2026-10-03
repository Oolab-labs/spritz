'use strict';

// The control channel shares the LAN HTTP server's port through `upgrade`.
//
// lanserver creates its server lazily inside ensure(), and did not expose it, so nothing could
// attach an upgrade handler. Opening a SECOND listener instead would mean a second port to discover
// and a second thing to get through whatever the network allows — the single-port property is the
// reason the receiver only ever needs one address.
//
// The subscription has to survive the server being created LATE and being replaced: lanserver
// relists after teardown, and a subscriber registered against the old instance would silently stop
// receiving upgrades on the new one.

const { test } = require('node:test');
const assert = require('assert');
const createLanServer = require('../src/main/lanserver');

test('a subscriber is handed the server even when it registers BEFORE one exists', async () => {
  const lan = createLanServer({});
  try {
    const seen = [];
    lan.onServer((s) => seen.push(s));
    assert.equal(seen.length, 0, 'no server exists yet, so nothing should have been handed over');
    await new Promise((res) => lan.ensureServer(res));
    assert.equal(seen.length, 1, 'the subscriber was not told when the server appeared');
    assert.ok(typeof seen[0].on === 'function', 'what arrived is not an http.Server');
  } finally { lan.teardown(); }
});

test('a subscriber registering AFTER the server exists is handed it immediately', async () => {
  const lan = createLanServer({});
  try {
    await new Promise((res) => lan.ensureServer(res));
    const seen = [];
    lan.onServer((s) => seen.push(s));
    assert.equal(seen.length, 1, 'a late subscriber was never given the running server');
  } finally { lan.teardown(); }
});

test('the port the subscriber gets is the port the media is served on', async () => {
  const lan = createLanServer({});
  try {
    let got = null;
    lan.onServer((s) => { got = s; });
    await new Promise((res) => lan.ensureServer(res));
    assert.equal(got.address().port, lan.serverPort(), 'the control channel would be on a different port');
  } finally { lan.teardown(); }
});
