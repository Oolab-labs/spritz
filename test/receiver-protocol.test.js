'use strict';

const { test } = require('node:test');
const assert = require('assert');
const p = require('../src/main/receiver-protocol');

test('every message carries version, type and session', () => {
  const m = p.load('sess-1', { url: 'http://x/media.m3u8', mediaId: 'm1', now: 1000 });
  assert.equal(m.v, p.PROTOCOL_VERSION);
  assert.equal(m.type, 'load');
  assert.equal(m.sid, 'sess-1');
  assert.equal(m.t, 1000);
});

test('parse rejects what it cannot act on, and never throws', () => {
  assert.equal(p.parse('{oops').ok, false);
  assert.equal(p.parse('[]').ok, false);
  assert.equal(p.parse('null').ok, false);
  assert.equal(p.parse(JSON.stringify({ v: 999, type: 'play' })).ok, false);
  assert.equal(p.parse(JSON.stringify({ v: 1 })).ok, false);
  assert.equal(p.parse(JSON.stringify({ v: 1, type: 'launch_missiles' })).ok, false);
  assert.equal(p.parse(JSON.stringify(p.play('s'))).ok, true);
});

test('a parse failure explains itself', () => {
  // The `why` is what a human reads when a receiver stops working, so it has to name the problem.
  assert.match(p.parse(JSON.stringify({ v: 7, type: 'play' })).why, /version/);
  assert.match(p.parse(JSON.stringify({ v: 1, type: 'nope' })).why, /unknown type/);
});

test('round-trips through serialize/parse', () => {
  const sent = p.position('s1', { mediaId: 'm', currentTime: 12.5, durationSec: 100, paused: false, bufferedUntil: 30 });
  const got = p.parse(p.serialize(sent));
  assert.equal(got.ok, true);
  assert.deepEqual(got.msg, sent);
});

// The Mac must be able to tell a starved receiver from a wedged one. That distinction cost the VOD
// investigation days, and it is only possible if the position report carries the buffer.
test('position carries the buffer as well as the clock', () => {
  const m = p.position('s', { currentTime: 132.2, bufferedUntil: 132.0, durationSec: 5981 });
  assert.equal(m.currentTime, 132.2);
  assert.equal(m.bufferedUntil, 132.0);
});

test('position nulls a non-numeric clock rather than passing NaN on', () => {
  const m = p.position('s', { currentTime: undefined, durationSec: NaN });
  assert.equal(m.currentTime, null);
  assert.equal(m.durationSec, null);
});

// `stalled` fires at every segment boundary on this hardware while the clock keeps moving. If it
// were a state, the Mac would read healthy playback as a fault.
test('stalled is not a playback state', () => {
  assert.ok(!p.STATES.includes('stalled'), 'stalled must not be a state — it is measured noise');
  const m = p.state('s', { state: 'playing', flags: ['stalled'] });
  assert.equal(m.state, 'playing');
  assert.deepEqual(m.flags, ['stalled']);
});

test('seek is absolute, never a delta', () => {
  const m = p.seek('s', { toSec: 5520 });
  assert.equal(m.toSec, 5520);
  assert.ok(!('deltaSec' in m), 'a delta would have to be resolved against a position the Mac only knows second-hand');
});

test('load states autoplay explicitly and defaults it on', () => {
  assert.equal(p.load('s', { url: 'u' }).autoplay, true);
  assert.equal(p.load('s', { url: 'u', autoplay: false }).autoplay, false);
});

// device-profile.js ranks 'reported' below 'observed'. The protocol must not let a receiver's own
// claim arrive already labelled as an observation.
test('capabilities are labelled reported, not observed', () => {
  const m = p.capabilities('s', { reported: { hevc: true } });
  assert.deepEqual(m.reported, { hevc: true });
  assert.ok(!('observed' in m), 'a receiver claim is REPORTED; only playback writes an observation');
});

test('errors are carried verbatim and marked fatal or not', () => {
  const m = p.error('s', { code: '-12927', message: 'no', fatal: true });
  assert.equal(m.code, '-12927');
  assert.equal(m.fatal, true);
});

test('a load names the transport epoch, or null when the url is not epoch-backed', () => {
  assert.equal(p.load('s', { url: 'u', mediaId: 'm', epoch: 'epoch-2' }).epoch, 'epoch-2');
  assert.equal(p.load('s', { url: 'u', mediaId: 'm' }).epoch, null);
});

test('report times reject malformed numbers while preserving partial and unknown reports', () => {
  for (const field of ['currentTime', 'durationSec', 'bufferedUntil']) {
    for (const value of [-1, '20', {}, false]) {
      assert.equal(p.parse(p.serialize(p.envelope('position', 'session', { [field]: value }))).ok, false);
    }
    assert.equal(p.parse(p.serialize(p.envelope('position', 'session', { [field]: null }))).ok, true);
    assert.equal(p.parse(p.serialize(p.envelope('position', 'session', { [field]: 0 }))).ok, true);
  }
  assert.equal(p.parse('{"v":1,"type":"position","currentTime":1e999}').ok, false);
  assert.equal(p.parse(p.serialize(p.envelope('position', 'session', {}))).ok, true);
  assert.equal(p.parse(p.serialize(p.envelope('position', 'session', { paused: 'false' }))).ok, false);
});


test('reconnect playback snapshots require valid shape, identity, state and timing', () => {
  for (const playing of [[], 'playing', { mediaId: {} }, { epoch: 1 }, { currentTime: -1 }, { currentTime: '20' }, { state: 'invented' }, { paused: 'false' }]) {
    assert.equal(p.parse(p.serialize(p.envelope('hello', 's', { playing }))).ok, false);
  }
  for (const playing of [null, {}, { mediaId: 'film', epoch: null, currentTime: null, state: 'paused', paused: true }]) {
    assert.equal(p.parse(p.serialize(p.envelope('hello', 's', { playing }))).ok, true);
  }
});


test('ordinary playback identities and state flags reject malformed types', () => {
  for (const fields of [{ mediaId: {} }, { epoch: 42 }]) {
    assert.equal(p.parse(p.serialize(p.envelope('position', 's', fields))).ok, false);
  }
  for (const fields of [{ state: 'invented' }, { state: 'playing', flags: 'waiting' }, { state: 'playing', flags: [3] }]) {
    assert.equal(p.parse(p.serialize(p.envelope('state', 's', fields))).ok, false);
  }
});


test('error reports carry optional transport identity', () => {
  assert.equal(p.error('s', { mediaId: 'film', epoch: 'epoch-2', fatal: true }).epoch, 'epoch-2');
  assert.equal(p.error('s', { mediaId: 'film' }).epoch, null);
});

test('logical timeline validates origin, source duration and clock contract', () => {
  const base = { mediaId: 'mapped', url: 'http://media/a.m3u8', startSec: 120, timelineOrigin: 98.098, sourceDuration: 3122 };
  const valid = p.load('sess', base);
  assert.equal(p.parse(p.serialize(valid)).ok, true);
  assert.equal(valid.timelineOrigin, 98.098);
  for (const override of [{ timelineOrigin: -1 }, { timelineOrigin: 121 }, { sourceDuration: 50 }, { sourceDuration: null }, { epoch: 'other-clock' }]) {
    assert.equal(p.parse(p.serialize(p.load('sess', { ...base, ...override }))).ok, false);
  }
});
