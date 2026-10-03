'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { create } = require('../webos-receiver/subtitle-loader');
function fixture() {
  let clock = 0, position = 20;
  const tasks = new Map(), requests = [], loads = [], states = [], canceled = [], carried = [];
  let seq = 0;
  const loader = create({ now: () => clock, position: () => position,
    schedule: (fn, delay) => { tasks.set(++seq, { fn, at: clock + delay }); return seq; }, clear: id => tasks.delete(id),
    prepare: (b, p, owner, cb) => { const r = { b, p, owner, cb, aborted: false }; requests.push(r); return () => { r.aborted = true; }; },
    cancel: (b, owner) => canceled.push(owner),
    load: (b, url, cb) => { const r = { b, url, cb, aborted: false }; loads.push(r); return () => { r.aborted = true; }; },
    preserve: (old, next) => carried.push({ old, next }),
    commit: b => { b.node.showing = true; }, remove: node => { node.removed = true; }, state: (b, s) => states.push(s)
  });
  return { loader, requests, loads, states, canceled, carried, setPosition: p => { position = p; }, advance: ms => { clock += ms; for (const [id, task] of [...tasks]) if (task.at <= clock) { tasks.delete(id); task.fn(); } } };
}
const ready = (revision = '1', extra = {}) => ({ status: 'ready', revision, url: 'http://mac/sub-' + revision, rangeStart: 0, rangeEnd: 80, complete: false, ...extra });
test('selected captions prepare once; repeated ready selection and dialogue gaps do not reload', () => {
  const f = fixture(), b = { id: 's', node: null }; f.loader.select(b, 20); f.loader.select(b, 20);
  assert.equal(f.requests.length, 1); f.requests[0].cb(null, ready()); const node = {}; f.loads[0].cb(null, node);
  f.loader.select(b, 21); f.loader.tick(30); assert.equal(f.requests.length, 1); assert.equal(b.node, node);
});
test('renewal retains previous cues until hidden replacement loads', () => {
  const f = fixture(), old = {}, b = { id: 's', node: old, revision: '1', coverage: ready() };
  f.loader.select(b, 20); f.requests[0].cb(null, ready('1')); f.advance(31000); f.loader.tick(77);
  assert.equal(b.node, old); f.requests[1].cb(null, ready('2')); assert.equal(b.node, old);
  const next = {}; f.loads[0].cb(null, next); assert.equal(b.node, next); assert.equal(old.removed, true); assert.deepEqual(f.carried, [{ old, next }]);
});
test('Off cancels polling and rejects stale prepare callbacks', () => {
  const f = fixture(), b = { id: 's' }; f.loader.select(b, 20); const request = f.requests[0]; f.loader.select(null, 20);
  request.cb(null, ready()); f.advance(100000); assert.equal(f.loads.length, 0); assert.equal(request.aborted, true); assert.equal(f.canceled.length, 1);
});
test('rapid seeks debounce to final position and ignore previous native node callbacks', () => {
  const f = fixture(), b = { id: 's' }; f.loader.select(b, 20); f.requests[0].cb(null, ready());
  f.setPosition(100); f.loader.tick(100, true); f.setPosition(200); f.loader.tick(200, true); f.advance(300);
  assert.equal(f.requests.length, 2); assert.equal(f.requests[1].p, 200);
  const stale = {}; f.loads[0].cb(null, stale); assert.equal(stale.removed, true); assert.equal(b.node, undefined);
});
test('bounded failures require manual retry; no timeupdate fetch storm', () => {
  const f = fixture(), b = { id: 's' }; f.loader.select(b, 20);
  for (const delay of [2000, 5000, 10000]) { f.requests.at(-1).cb(new Error('cold')); f.advance(delay); }
  f.requests.at(-1).cb(new Error('cold')); f.advance(40000); for (let i = 0; i < 100; i++) f.loader.tick(20);
  assert.equal(f.requests.length, 4); assert.equal(f.states.at(-1), 'unavailable'); f.loader.select(b, 20); assert.equal(f.requests.length, 5);
});
test('complete EOF from late start still refreshes after seeking before range start', () => {
  const f = fixture(), b = { id: 's' }; f.loader.select(b, 200); f.requests[0].cb(null, ready('1', { complete: true, rangeStart: 180 })); f.loads[0].cb(null, {});
  f.advance(10000); f.loader.tick(1000); assert.equal(f.requests.length, 1);
  f.setPosition(30); f.loader.tick(30, true); f.advance(300); assert.equal(f.requests.length, 2); assert.equal(f.requests[1].p, 30);
});
test('pending polling and failed retries clear timer before later renewal', () => {
  for (const failed of [false, true]) {
    const f = fixture(), b = { id: 's' }; f.loader.select(b, 20);
    if (failed) f.requests[0].cb(new Error('cold')); else f.requests[0].cb(null, { status: 'pending', retryAfterMs: 1000 });
    f.advance(failed ? 2000 : 1000); f.requests[1].cb(null, ready()); f.loads[0].cb(null, {});
    f.advance(10000); f.loader.tick(77); assert.equal(f.requests.length, 3); assert.equal(f.requests[2].p, 81);
  }
});
test('switching back to a cached ready subtitle commits without refetch', () => {
  const f = fixture(), a = { id: 'a' }, b = { id: 'b' };
  f.loader.select(a, 20); f.requests[0].cb(null, ready()); f.loads[0].cb(null, {});
  f.loader.select(b, 20); f.loader.select(a, 20);
  assert.equal(f.requests.length, 2); assert.equal(a.node.showing, true);
});
test('inventory reconciliation keeps replacement hidden/loading while previous cues show', () => {
  const tracks = require('../webos-receiver/media-tracks');
  const old = { kind: 'subtitles', mode: 'showing' }, next = { kind: 'subtitles', mode: 'hidden' };
  const b = { id: 's', node: { track: old }, loadingNode: { track: next }, selected: true };
  tracks.selectBoundSubtitle({ textTracks: [old, next] }, [b], 's');
  assert.equal(old.mode, 'showing'); assert.equal(next.mode, 'hidden');
  tracks.selectBoundSubtitle({ textTracks: [old, next] }, [b], 'off');
  assert.equal(old.mode, 'disabled'); assert.equal(next.mode, 'disabled');
});
test('native inventory keeps audio wire cap32 and supports subtitle cap128', () => {
  const tracks = require('../webos-receiver/media-tracks');
  const inventory = tracks.snapshot({ audioTracks: Array.from({ length: 40 }, () => ({ enabled: false })), textTracks: Array.from({ length: 140 }, () => ({ kind: 'subtitles', mode: 'disabled' })) });
  assert.equal(inventory.audio.length, 32); assert.equal(inventory.subtitles.length, 128);
});
test('long active cue survives same-track renewal with settings; expired and duplicate cues do not copy', () => {
  const tracks = require('../webos-receiver/media-tracks');
  class Cue { constructor(startTime, endTime, text) { Object.assign(this, { startTime, endTime, text }); } }
  const active = Object.assign(new Cue(1, 50, 'long line'), { align: 'start', line: 80, position: 25, size: 60, vertical: 'rl' });
  const expired = new Cue(0, 40, 'old line');
  const next = { cues: [new Cue(60, 70, 'future')], addCue(cue) { this.cues.push(cue); } };
  const old = { track: { activeCues: [active, expired] } };
  assert.equal(tracks.carryActiveCues({ currentTime: 43 }, old, { track: next }, Cue), 1);
  const copy = next.cues[1]; assert.notEqual(copy, active); assert.equal(copy.text, 'long line');
  assert.equal(copy.line, 80); assert.equal(copy.position, 25); assert.equal(copy.vertical, 'rl');
  assert.equal(tracks.carryActiveCues({ currentTime: 43 }, old, { track: next }, Cue), 0);
  assert.equal(tracks.carryActiveCues({ currentTime: 51 }, old, { track: next }, Cue), 0);
});

test('returning to cached captions resets another track failure budget and renewal delay', () => {
  const f = fixture(), a = { id: 'a' }, b = { id: 'b' };
  f.loader.select(a, 20); f.requests[0].cb(null, ready()); f.loads[0].cb(null, {});
  f.loader.select(b, 20);
  for (const delay of [2000, 5000, 10000]) { f.requests.at(-1).cb(new Error('unavailable B')); f.advance(delay); }
  f.requests.at(-1).cb(new Error('unavailable B'));
  f.loader.select(a, 77);
  const before = f.requests.length;
  f.loader.tick(77);
  assert.equal(f.requests.length, before + 1, 'cached A must renew immediately near its coverage boundary');
  assert.equal(f.requests.at(-1).b, a);
  assert.equal(f.requests.at(-1).p, 81);
});
