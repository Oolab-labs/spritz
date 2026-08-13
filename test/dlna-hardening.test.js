'use strict';

// DLNA discovery treats the network as trusted input, and it is not.
//
// SSDP is an unauthenticated multicast protocol: anything on the LAN can answer an M-SEARCH and
// claim to be a television. Whatever it returns is then parsed, stored, shown in the device list,
// written to a cache file, and — crucially — used to decide where our SOAP commands get posted.
// Those commands carry the LAN URL of whatever the user is playing.
//
// So the responder is an attacker in the threat model, and these tests treat it as one.

const { test } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { fakeRenderer } = require('./fake-devices');

// Per-file cache path — see the note in cast-dlna.test.js. Must be set before dlna.js loads.
const CACHE = path.join(os.tmpdir(), 'spritz-test-cache-hardening.json');
process.env.SPRITZ_DLNA_CACHE = CACHE;
let saved = null;
function seed(loc) {
  try { saved = fs.readFileSync(CACHE, 'utf8'); } catch (e) { saved = null; }
  fs.writeFileSync(CACHE, JSON.stringify([{ location: loc, host: new URL(loc).hostname, name: 'x' }]));
}
function restore() {
  try { if (saved === null) fs.unlinkSync(CACHE); else fs.writeFileSync(CACHE, saved); } catch (e) {}
}

// Discovery is fire-and-forget, so "was it registered?" is answered by waiting a beat and reading
// the device list, not by awaiting a promise. Short, because the fakes are on loopback.
function devicesAfter(dlna, ms) {
  return new Promise((resolve) => {
    let last = [];
    dlna.on('devices', (l) => { last = l; });
    dlna.startDiscovery();
    setTimeout(() => resolve(last), ms);
  });
}

test('a control URL pointing off the LAN is refused', async (t) => {
  // The attack: answer discovery from a LAN address, but set <URLBase> to a host you control.
  // Every later SOAP action — SetAVTransportURI carries the media URL — would go there instead.
  const r = await fakeRenderer({ urlBase: 'http://198.51.100.7:80' }); // TEST-NET-2, never local
  if (!r.location) return t.skip('no LAN address on this machine');
  seed(r.location);
  const dlna = require('../src/main/dlna.js')();
  try {
    const list = await devicesAfter(dlna, 1500);
    const found = list.find((d) => d.location === r.location);
    assert.ok(!found, 'a renderer whose control URL leaves the LAN must not be registered');
  } finally { dlna.teardown(); r.srv.close(); restore(); }
});

test('an endless description body cannot exhaust memory', async (t) => {
  // Without a cap this accumulates into a string until the main process dies. The device must
  // simply not appear; the app must stay up.
  const r = await fakeRenderer({ giant: true });
  if (!r.location) return t.skip('no LAN address on this machine');
  seed(r.location);
  const dlna = require('../src/main/dlna.js')();
  const before = process.memoryUsage().heapUsed;
  try {
    const list = await devicesAfter(dlna, 3000);
    assert.ok(!list.find((d) => d.location === r.location), 'must not register');
    const grew = (process.memoryUsage().heapUsed - before) / (1024 * 1024);
    assert.ok(grew < 64, 'heap grew ' + Math.round(grew) + 'MB — the body cap did not hold');
  } finally { dlna.teardown(); r.srv.close(); restore(); }
});

test('a hostile friendlyName is bounded and stripped of control characters', async (t) => {
  // Raw control characters are written as escapes on purpose: invisible bytes in a test
  // file are unreadable in review and get mangled by editors and tooling.
  const nasty = 'A'.repeat(5000) + '\u001b[31m\nInjected\u0000tail';
  const r = await fakeRenderer({ name: nasty });
  if (!r.location) return t.skip('no LAN address on this machine');
  seed(r.location);
  const dlna = require('../src/main/dlna.js')();
  try {
    const list = await devicesAfter(dlna, 1500);
    const found = list.find((d) => d.location === r.location);
    assert.ok(found, 'a rude name is not grounds for dropping a working renderer');
    assert.ok(found.name.length <= 128, 'name must be bounded, got ' + found.name.length);
    assert.ok(!/[\u0000-\u001f\u007f]/.test(found.name), 'control characters must be stripped');
  } finally { dlna.teardown(); r.srv.close(); restore(); }
});

test('a well-behaved renderer on the LAN still registers', async (t) => {
  // The control that matters most: none of the above may have made discovery stricter than the
  // real LG, whose control URL sits on a different port from its LOCATION.
  const r = await fakeRenderer({});
  if (!r.location) return t.skip('no LAN address on this machine');
  seed(r.location);
  const dlna = require('../src/main/dlna.js')();
  try {
    const list = await devicesAfter(dlna, 1500);
    const found = list.find((d) => d.location === r.location);
    // The emitted shape is {id,type,name,location} — avControl stays internal. Registration
    // itself is the proof the control URL resolved: fetchDevice drops the device when it doesn't.
    assert.ok(found, 'a normal renderer must still be discovered');
    assert.strictEqual(found.type, 'dlna');
  } finally { dlna.teardown(); r.srv.close(); restore(); }
});
