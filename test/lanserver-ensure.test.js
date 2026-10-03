'use strict';

// The LAN server is started lazily by ensure(), and every path that needs it calls that: AirPlay
// HLS, the Chromecast MKV transport, the DLNA proxy, /file/ serving, the VOD playlist.
//
// ensure() tested `server && server.listening` and otherwise created one. listen() is
// asynchronous, so two callers arriving in the same tick BOTH saw "not listening yet" and BOTH
// created a server. The consequences are not cosmetic:
//
//   • the first server is never closed — teardown() only knows about the variable, which by then
//     holds the second — so it stays bound to its port for the life of the process;
//   • `port` is written by whichever listen finishes last, while a caller may already have built a
//     URL from the other one. A cast URL naming a port nothing is listening on is a receiver that
//     cannot fetch anything, from a Spritz that believes it is serving.
//
// Two callers at once is ordinary: resolving an AirPlay URL and a DLNA URL for the same file, or a
// source change arriving while the previous resolve is still in flight.

const { test } = require('node:test');
const assert = require('assert');
const http = require('http');
const createLanServer = require('../src/main/lanserver');

// Count servers by wrapping the constructor for the duration of one call, and KEEP the instances so
// the assertions can ask them directly. Deliberately not process._getActiveHandles(): that reads
// global process state, so it would see servers belonging to other test files running in parallel
// and report a failure that has nothing to do with this one.
// Install/restore in plain synchronous helpers — assigning onto a shared module after an await is
// the race-condition smell the linter flags, and it is right that a global deserves the care.
function installCounter(created) {
  const orig = http.createServer;
  http.createServer = function (...a) { const s = orig.apply(this, a); created.push(s); return s; };
  return orig;
}
function restoreCounter(orig) { http.createServer = orig; }

async function countingServers(fn) {
  const created = [];
  const orig = installCounter(created);
  try { await fn(created); } finally { restoreCounter(orig); }
  return created;
}

test('concurrent callers share ONE http server', async () => {
  let lan = null;
  const created = await countingServers(async () => {
    lan = createLanServer({});
    const urls = await Promise.all([
      new Promise((r) => lan.serveDlna('http://127.0.0.1:1/webtorrent/x/a.mkv', 'video/mp4', r)),
      new Promise((r) => lan.serveDlna('http://127.0.0.1:2/webtorrent/y/b.mkv', 'video/mp4', r)),
      new Promise((r) => lan.serveDlna('http://127.0.0.1:3/webtorrent/z/c.mkv', 'video/mp4', r))
    ]);
    const given = urls.filter(Boolean);
    if (given.length) {
      const ports = given.map((u) => new URL(u).port);
      assert.equal(new Set(ports).size, 1, 'callers were handed different ports: ' + ports.join(','));
    }
  });
  try {
    assert.equal(created.length, 1, 'three concurrent callers created ' + created.length + ' servers');
  } finally {
    try { lan.teardown(); } catch (e) {}
  }
});

test('every server this module opens is closed by teardown', async () => {
  let lan = null;
  const created = await countingServers(async () => {
    lan = createLanServer({});
    await Promise.all([
      new Promise((r) => lan.serveDlna('http://127.0.0.1:1/webtorrent/x/a.mkv', 'video/mp4', r)),
      new Promise((r) => lan.serveDlna('http://127.0.0.1:2/webtorrent/y/b.mkv', 'video/mp4', r))
    ]);
  });
  lan.teardown();
  await new Promise((r) => setTimeout(r, 250)); // close() lands on the next turn
  // Asked of THIS module's own servers, not of the process — an orphan is one that is still
  // listening after the module was told to shut down.
  const stillUp = created.filter((s) => s.listening);
  assert.equal(stillUp.length, 0, stillUp.length + ' of ' + created.length + ' server(s) still bound after teardown');
});

test('a caller arriving after the server is up does not create another', async () => {
  let lan = null;
  const created = await countingServers(async () => {
    lan = createLanServer({});
    await new Promise((r) => lan.serveDlna('http://127.0.0.1:1/webtorrent/x/a.mkv', 'video/mp4', r));
    await new Promise((r) => lan.serveDlna('http://127.0.0.1:2/webtorrent/y/b.mkv', 'video/mp4', r));
  });
  try {
    assert.equal(created.length, 1, 'the second, sequential caller should have reused the running server');
  } finally {
    try { lan.teardown(); } catch (e) {}
  }
});
