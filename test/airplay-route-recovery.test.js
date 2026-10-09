'use strict';
/* Route-loss recovery must be decided by the external route, not by any AVPlayer clock.
 * Reproduced (2026-10-08): after an inactive-route or failed-item event, the prepared AVPlayer's
 * periodic time observer keeps ticking locally (externalPlaybackActive=NO). Each tick cleared
 * avItemFailed and cancelled the drop, so the app stayed engine=airplay indefinitely with nothing
 * on the TV and no local playback. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), vm = require('vm');
const src = fs.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8');
const timerCode = src.slice(src.indexOf('  let dropTimer = null;'), src.indexOf('  // ---- "open with Spritz"'));
const listenerStart = src.indexOf('        apAddon.setEventListener((ev) => {');
const listener = src.slice(listenerStart, src.indexOf('        // Start route detection', listenerStart));

function harness({ external = true } = {}) {
  let now = 0, next = 0, cb; const timers = new Map(); const events = []; const resumes = [];
  const c = vm.createContext({ castEngine: 'airplay', apExternalActive: external, apTimeSeen: 0, apLastLoggedTime: 0,
    lastAvTime: 40, avItemFailed: false, castUrl: 'http://fixture/master.m3u8',
    console: { log() {}, error() {} },
    setTimeout(fn, delay) { const id = ++next; timers.set(id, { at: now + delay, fn }); return id; },
    clearTimeout(id) { timers.delete(id); },
    resumeLocalFromAirplay(skip) { resumes.push({ at: c.lastAvTime, skip }); c.castEngine = 'mpv'; },
    send(_ch, ev) { events.push(ev); }, lan: { noteAirplayPosition() {} },
    apAddon: { setEventListener(fn) { cb = fn; }, stopAirplay() {}, prepare() {}, seek() {}, play() {} },
    mpvPos: () => 0, handOffToAirplay() {} });
  vm.runInContext(timerCode + listener, c);
  const advance = (ms) => { now += ms; for (const [id, t] of [...timers]) if (t.at <= now) { timers.delete(id); t.fn(); } };
  return { c, emit: (ev) => cb(ev), advance, events, resumes };
}

test('a local AVPlayer tick after the route went inactive does not cancel recovery', () => {
  const h = harness();
  h.emit({ type: 'external', active: false });
  h.emit({ type: 'time', cur: 40.5, dur: 100 }); h.emit({ type: 'time', cur: 41, dur: 100 });
  h.advance(6000);
  assert.equal(h.c.castEngine, 'mpv', 'must return to local playback');
  assert.equal(h.resumes.length, 1);
});

test('a failed item still recovers locally when the inactive player keeps ticking', () => {
  const h = harness({ external: false });
  h.emit({ type: 'status', value: 2, message: 'boom' });
  h.emit({ type: 'time', cur: 40, dur: 100 });
  assert.equal(h.c.avItemFailed, true, 'a local tick is not evidence the item recovered');
  h.advance(6000);
  assert.equal(h.c.castEngine, 'mpv');
  assert.equal(h.resumes[0].skip, true, 'no re-arm with the URL that just failed');
  assert.equal(JSON.stringify(h.events.at(-1)), JSON.stringify({ type: 'error', message: 'boom' }));
});

test('advancing playback on an active external route cancels a transient handshake error', () => {
  const h = harness({ external: true });
  h.emit({ type: 'error', message: 'transient' });
  h.emit({ type: 'time', cur: 41, dur: 100 }); h.emit({ type: 'time', cur: 41.5, dur: 100 });
  h.advance(6000);
  assert.equal(h.c.castEngine, 'airplay');
  assert.equal(h.c.avItemFailed, false);
  assert.equal(h.resumes.length, 0);
});

test('a frozen clock on an active route does not count as healthy', () => {
  const h = harness({ external: true });
  h.emit({ type: 'error', message: 'stalled' });
  h.emit({ type: 'time', cur: 40, dur: 100 }); h.emit({ type: 'time', cur: 40, dur: 100 });
  h.advance(6000);
  assert.equal(h.c.castEngine, 'mpv');
});

test('recovery resumes local playback at the last remote playhead, not a later local tick', () => {
  const h = harness({ external: true });
  h.emit({ type: 'time', cur: 52, dur: 100 });                 // healthy remote progress
  h.emit({ type: 'external', active: false });
  h.emit({ type: 'time', cur: 0, dur: 100 });                  // e.g. a stale/reset local clock
  h.advance(6000);
  assert.equal(h.resumes[0].at, 52);
});
