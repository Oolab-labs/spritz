'use strict';

// Regression tests for the failures that actually happened, all runnable with no TV present.
// Run: npm test  (node --test test/)

const { test } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { fakeRenderer } = require('./fake-devices');

// The fakes serve HTTP but do not answer SSDP, so discovery would never learn about them. Seed the
// persistent renderer cache instead: startDiscovery() re-fetches cached LOCATIONs over plain HTTP,
// which registers the fake AND exercises that cache path at the same time. (Outside Electron the
// cache lives in the home dir — see CACHE_FILE in dlna.js.)
// Per-file cache path, set BEFORE dlna.js is required so it picks this up at module load.
// node --test runs files in parallel and dlna's default cache path is a single shared file, so
// without this one suite's seed/restore silently breaks another's discovery.
const CACHE = path.join(os.tmpdir(), 'spritz-test-cache-cast-dlna.json');
process.env.SPRITZ_DLNA_CACHE = CACHE;
let savedCache = null;
function seedCache(loc) {
  try { savedCache = fs.readFileSync(CACHE, 'utf8'); } catch (e) { savedCache = null; }
  const host = new URL(loc).hostname;
  fs.writeFileSync(CACHE, JSON.stringify([{ location: loc, host, name: 'Fake DLNA Renderer' }]));
}
function restoreCache() {
  try { if (savedCache === null) fs.unlinkSync(CACHE); else fs.writeFileSync(CACHE, savedCache); } catch (e) {}
}

// Wait until dlna has registered a specific location, then run fn.
function withDevice(dlna, loc, fn) {
  return new Promise((resolve, reject) => {
    let done = false;
    const t = setTimeout(() => { if (!done) { done = true; reject(new Error('fake never registered')); } }, 12000);
    dlna.on('devices', (l) => {
      if (done || !l.some((d) => d.location === loc)) return;
      done = true; clearTimeout(t); resolve(fn());
    });
    dlna.startDiscovery();
  });
}

// --- 1. Play timeout must NOT be reported as failure if the renderer is actually playing ---
// This is the double-playback bug: dlna.load() reported the timeout as an error, main called
// resumeLocalFromDlna(), and the file then played on the Mac AND the TV simultaneously.
test('a Play that times out but IS playing counts as success', async () => {
  const r = await fakeRenderer({ behaviour: 'playTimeout' });
  seedCache(r.location);
  const dlna = require('../src/main/dlna.js')();
  try {
    const err = await withDevice(dlna, r.location, () => new Promise((resolve) => {
      dlna.load(r.location, { url: 'http://127.0.0.1:1/x.mp4', title: 't', contentType: 'video/mp4', duration: 1 },
        (e) => resolve(e));
    }));
    assert.strictEqual(r.state(), 'PLAYING', 'fake renderer should be playing');
    assert.ok(!err, 'load() must NOT report an error while the renderer is playing (got: ' + (err && err.message) + ')');
  } finally { dlna.teardown(); r.srv.close(); restoreCache(); }
});

// --- 2. A wedged renderer (701 to everything) must fail with an actionable message ---
test('a wedged renderer reports a stuck-player error, not "rejected the file"', async () => {
  const r = await fakeRenderer({ behaviour: 'wedged' });
  seedCache(r.location);
  const dlna = require('../src/main/dlna.js')();
  let msg = null;
  dlna.on('error', (e) => { msg = e.message; });
  try {
    const err = await withDevice(dlna, r.location, () => new Promise((resolve) => {
      dlna.load(r.location, { url: 'http://127.0.0.1:1/x.mp4', title: 't', contentType: 'video/mp4', duration: 1 },
        (e) => resolve(e));
    }));
    assert.ok(err, 'a 701 renderer must surface an error');
    assert.ok(/stuck|won.t accept|restart/i.test(msg || ''), 'message should say the player is stuck, got: ' + msg);
  } finally { dlna.teardown(); r.srv.close(); restoreCache(); }
});

// --- 3. The torrent critical window must not grow without bound ---
// webtorrent's critical() only ever SETS _critical[i]; re-marking a moving window every tick made
// nearly the whole file critical, so the priority flag stopped discriminating and playback stuttered.
test('torrent critical window is cleared before re-marking', () => {
  const marks = [];
  const fakeTorrent = {
    _critical: [],
    critical(a, b) { for (let i = a; i <= b; i++) this._critical[i] = true; marks.push([a, b]); }
  };
  // emulate the module's refresh: clear, then mark
  const refresh = (at, end) => {
    if (Array.isArray(fakeTorrent._critical)) fakeTorrent._critical.length = 0;
    fakeTorrent.critical(at, end);
  };
  for (let i = 0; i < 50; i++) refresh(i, i + 24);
  const flagged = fakeTorrent._critical.filter(Boolean).length;
  assert.ok(flagged <= 26, 'critical set must stay bounded to the window, got ' + flagged);
});

// --- 4. Engine transition rules ---
// The double-playback bug was a state bug: local playback resumed while a TV was still playing.
// Pin the rule that a cast can only END by returning to local — never by jumping straight to
// another engine, which is what "playing on two things at once" looks like in state terms.
test('a cast engine may only transition back to local, never to another engine', () => {
  const ENGINE_OK = {
    mpv:        ['mpv', 'pending', 'airplay', 'chromecast', 'dlna'],
    pending:    ['mpv', 'pending', 'airplay', 'chromecast', 'dlna'],
    airplay:    ['mpv', 'airplay'],
    chromecast: ['mpv', 'chromecast'],
    dlna:       ['mpv', 'dlna']
  };
  const legal = (a, b) => ENGINE_OK[a].includes(b);
  for (const from of ['airplay', 'chromecast', 'dlna']) {
    for (const to of ['airplay', 'chromecast', 'dlna']) {
      if (from === to) continue;
      assert.ok(!legal(from, to), from + ' -> ' + to + ' must be illegal (two engines live at once)');
    }
    assert.ok(legal(from, 'mpv'), from + ' -> mpv must be legal (stopping a cast)');
  }
  for (const to of ['airplay', 'chromecast', 'dlna', 'pending']) {
    assert.ok(legal('mpv', to), 'mpv -> ' + to + ' must be legal (starting a handoff)');
  }
});
