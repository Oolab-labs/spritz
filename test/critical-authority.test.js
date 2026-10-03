'use strict';

// WHO decides where the torrent's critical window points.
//
// There are two positions during torrent-backed playback and they are not the same number. The
// VIEWER PLAYHEAD is what the person is watching. The PRODUCER DEMAND is the source region the
// packager is reading right now, and it necessarily runs AHEAD of the viewer — that is what
// producing upcoming media means. Prioritising the swarm around the viewer alone starves the
// producer trying to generate the next segments, and the viewer then stalls anyway.
//
// Today this decision does not exist. ensureBytes() reaches the same effect by calling
// setPlayhead() — it MOVES THE PLAYHEAD to a byte the viewer is not at, because refreshCritical
// re-aims at playFrac on every progress tick and would otherwise wipe the window it just set. Its
// own comment says so: "the two would fight, and the tick would win." So producer demand currently
// survives only by impersonating the viewer, and the two authorities are indistinguishable
// afterwards — which is exactly what a far seek needs to be able to reason about.
//
// This module makes the choice explicit and testable. It is pure: no torrent, no clock, no io.

const { test } = require('node:test');
const assert = require('assert');
const { criticalAuthority, PRODUCER_FRESH_MS } = require('../src/main/critical-authority');

const FILE = 1000000;             // a round file length, so byte positions read as percentages
const viewerAt = (frac) => ({ frac, fileLength: FILE });

test('the producer wins while it is actively reading', () => {
  const d = criticalAuthority({
    viewer: viewerAt(0.1),
    producer: { byteStart: 500000, at: 1000, active: true },
    now: 1000
  });
  assert.equal(d.source, 'producer');
  assert.equal(d.byteStart, 500000, 'the window follows the packager, not the viewer');
});

test('viewer ticks cannot overwrite a live producer', () => {
  // The failure this prevents: refreshCritical runs every progress tick, and every tick used to be
  // free to re-aim the window at playFrac. A producer reading at 5200s would be erased once a
  // second by a viewer sitting at 10s.
  const producer = { byteStart: 870000, at: 5000, active: true };
  for (const frac of [0.01, 0.02, 0.03]) {
    const d = criticalAuthority({ viewer: viewerAt(frac), producer, now: 5000 });
    assert.equal(d.source, 'producer', 'tick at frac ' + frac + ' must not take authority');
    assert.equal(d.byteStart, 870000);
  }
});

test('stale producer demand falls back to the viewer', () => {
  const d = criticalAuthority({
    viewer: viewerAt(0.25),
    producer: { byteStart: 900000, at: 0, active: true },
    now: PRODUCER_FRESH_MS + 1
  });
  assert.equal(d.source, 'viewer');
  assert.equal(d.byteStart, 250000);
});

test('a producer that has finished is not authoritative, however recent its last read', () => {
  // Freshness alone cannot decide this. A run that has EXITED is done demanding, even though it
  // read a byte a millisecond ago — and the viewer should get the swarm back immediately rather
  // than after a timeout.
  const d = criticalAuthority({
    viewer: viewerAt(0.25),
    producer: { byteStart: 900000, at: 1000, active: false },
    now: 1000
  });
  assert.equal(d.source, 'viewer');
});

test('a BLOCKED producer keeps authority — that is when it needs the swarm most', () => {
  // The case a naive freshness rule gets backwards. A producer waiting on pieces emits no new
  // reads precisely because the bytes have not arrived, so treating silence as staleness would
  // hand the swarm back to the viewer at the exact moment the packager is starving for it.
  // Freshness is therefore generous, and the authoritative "stopped" signal is active:false above.
  const d = criticalAuthority({
    viewer: viewerAt(0.01),
    producer: { byteStart: 900000, at: 0, active: true },
    now: PRODUCER_FRESH_MS - 1
  });
  assert.equal(d.source, 'producer', 'silence while blocked is not staleness');
});

test('the first producer read after a seek takes authority from the provisional window', () => {
  // The seek transition. The viewer's new position provisionally aims the swarm, because nothing
  // else knows anything yet; the moment the packager actually reads, it takes over.
  const seekTo = viewerAt(0.87);
  const provisional = criticalAuthority({ viewer: seekTo, producer: null, now: 1000 });
  assert.equal(provisional.source, 'viewer');
  assert.equal(provisional.byteStart, 870000);

  const armed = criticalAuthority({
    viewer: seekTo,
    producer: { byteStart: 868000, at: 1200, active: true },
    now: 1200
  });
  assert.equal(armed.source, 'producer');
  assert.equal(armed.byteStart, 868000, 'the packager reads slightly BEHIND the seek target — its keyframe lead-in');
});

test('seeks move the provisional window in both directions', () => {
  const fwd = criticalAuthority({ viewer: viewerAt(0.9), producer: null, now: 0 });
  assert.equal(fwd.byteStart, 900000);
  // A backward seek is a legitimate move, not a glitch to be filtered out.
  const back = criticalAuthority({ viewer: viewerAt(0.05), producer: null, now: 0 });
  assert.equal(back.byteStart, 50000);
});

test('a transient or absent viewer position does not snap the window to zero', () => {
  // Byte 0 is a real position — the head of the film — so "no reading" must not arrive as one.
  // A null decision leaves the previous window standing, which is the safe answer.
  for (const viewer of [null, { frac: null, fileLength: FILE }, { frac: NaN, fileLength: FILE },
    { frac: 0.5, fileLength: 0 }]) {
    const d = criticalAuthority({ viewer, producer: null, now: 0 });
    assert.equal(d.source, null, 'no authority rather than a window at byte 0');
    assert.equal(d.byteStart, null);
  }
});

test('a viewer at the very start IS a real position', () => {
  // The other side of the rule above: frac 0 is a reading, not a missing one.
  const d = criticalAuthority({ viewer: viewerAt(0), producer: null, now: 0 });
  assert.equal(d.source, 'viewer');
  assert.equal(d.byteStart, 0);
});

test('a nonsense producer byte is ignored rather than aimed at', () => {
  const d = criticalAuthority({
    viewer: viewerAt(0.4),
    producer: { byteStart: -1, at: 0, active: true },
    now: 0
  });
  assert.equal(d.source, 'viewer');
  assert.equal(d.byteStart, 400000);
});

test('every decision says why, because this is the thing a far-seek log has to explain', () => {
  const d = criticalAuthority({
    viewer: viewerAt(0.1),
    producer: { byteStart: 500000, at: 0, active: true },
    now: 0
  });
  assert.equal(typeof d.why, 'string');
  assert.ok(d.why.length > 0);
});
