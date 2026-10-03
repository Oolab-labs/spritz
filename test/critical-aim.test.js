'use strict';

// WHERE the torrent's critical window is aimed, and by WHOM — the scheduler side of
// critical-authority.js, driven against a fake torrent.
//
// torrent.js cannot be instantiated outside Electron (it asks `app` for a temp dir at construction)
// and has no seam for injecting a torrent, so the aiming state lives in critical-aim.js and
// torrent.js delegates to it. This is the same scheduler in one place, not a second one: torrent.js
// keeps the swarm, the file, the progress tick and the seek wait; this module keeps the two
// positions and decides which one the tick aims at.
//
// The rule these tests hold: producer LIFECYCLE belongs to the packaging run, never to HTTP
// requests. A real ffmpeg was measured making several Range requests per run — header, container
// index at the tail, the seek target, then one long read — and closing each before the next. A
// Range closing therefore says nothing about whether the producer stopped; only setProducerActive
// does.

const { test } = require('node:test');
const assert = require('assert');
const { createCriticalAim } = require('../src/main/critical-aim');
const { PRODUCER_FRESH_MS } = require('../src/main/critical-authority');

const PIECE = 1024 * 1024;
const FILE_BYTES = 200 * PIECE; // 200 pieces of a 1 MiB piece length

// A torrent the way refreshCritical sees one: piece geometry, the private critical list webtorrent
// keeps, and critical()/select(). Every critical() call is recorded WITH the state of the list at
// the moment it was made, because "clear before mark" is one of the things under test.
function fakeTorrent() {
  const t = { pieceLength: PIECE, _critical: [], marks: [], selects: [] };
  t.critical = (at, end) => { t.marks.push({ at, end, listWasEmpty: t._critical.length === 0 }); for (let i = at; i <= end; i++) t._critical[i] = true; };
  t.select = (at, end, prio) => t.selects.push({ at, end, prio });
  return t;
}
const fakeFile = () => ({ _startPiece: 0, _endPiece: 199, length: FILE_BYTES, offset: 0 });

function rig({ now = 0 } = {}) {
  const clock = { now };
  const aim = createCriticalAim({ now: () => clock.now });
  const t = fakeTorrent(), f = fakeFile();
  aim.setPlayhead(0, 6000); // 6000s film, so the window is sized in time
  return { aim, t, f, clock, last: () => t.marks[t.marks.length - 1], refresh: () => aim.refresh(t, f) };
}

test('the viewer alone aims the window', () => {
  const r = rig();
  r.aim.setPlayhead(0.5, 6000); r.refresh();
  assert.ok(r.last(), 'a window was marked');
  assert.ok(r.last().at >= 96 && r.last().at <= 100, 'around the middle of the file (at=' + r.last().at + ')');
});

test('producer demand alone does NOT win unless the producer is active', () => {
  const r = rig();
  r.aim.setPlayhead(0.1, 6000);
  r.aim.noteSourceRead({ reader: 'producer', event: 'open', byteStart: 150 * PIECE, position: 150 * PIECE });
  r.refresh();
  assert.ok(r.last().at < 30, 'still the viewer (at=' + r.last().at + ')');
});

test('an active producer wins over the viewer', () => {
  const r = rig();
  r.aim.setPlayhead(0.1, 6000);
  r.aim.setProducerActive(true);
  r.aim.noteSourceRead({ reader: 'producer', event: 'open', byteStart: 150 * PIECE, position: 150 * PIECE });
  r.refresh();
  assert.ok(r.last().at >= 146 && r.last().at <= 150, 'the producer (at=' + r.last().at + ')');
});

test('viewer progress ticks cannot erase active producer authority', () => {
  const r = rig();
  r.aim.setProducerActive(true);
  r.aim.noteSourceRead({ reader: 'producer', event: 'open', byteStart: 150 * PIECE, position: 150 * PIECE });
  for (const frac of [0.10, 0.11, 0.12, 0.13]) { r.aim.setPlayhead(frac, 6000); r.refresh(); }
  assert.ok(r.last().at >= 146, 'four ticks later the window is still at the producer (at=' + r.last().at + ')');
});

test('advancing producer reads move the window forward', () => {
  const r = rig();
  r.aim.setProducerActive(true);
  r.aim.noteSourceRead({ reader: 'producer', event: 'open', byteStart: 100 * PIECE, position: 100 * PIECE }); r.refresh();
  const a = r.last().at;
  r.aim.noteSourceRead({ reader: 'producer', event: 'progress', byteStart: 100 * PIECE, position: 120 * PIECE }); r.refresh();
  assert.ok(r.last().at > a, 'moved forward (' + a + ' → ' + r.last().at + ')');
});

test('backward producer movement is legitimate', () => {
  const r = rig();
  r.aim.setProducerActive(true);
  r.aim.noteSourceRead({ reader: 'producer', event: 'open', byteStart: 150 * PIECE, position: 150 * PIECE }); r.refresh();
  const a = r.last().at;
  // A new Range further back — the container index is behind you, or the viewer sought backwards.
  r.aim.noteSourceRead({ reader: 'producer', event: 'open', byteStart: 40 * PIECE, position: 40 * PIECE }); r.refresh();
  assert.ok(r.last().at < a, 'moved back (' + a + ' → ' + r.last().at + ')');
});

test('the producer stopping returns authority to the viewer immediately', () => {
  const r = rig();
  r.aim.setPlayhead(0.1, 6000);
  r.aim.setProducerActive(true);
  r.aim.noteSourceRead({ reader: 'producer', event: 'open', byteStart: 150 * PIECE, position: 150 * PIECE }); r.refresh();
  assert.ok(r.last().at >= 146);
  r.aim.setProducerActive(false); r.refresh();
  assert.ok(r.last().at < 30, 'back with the viewer at once, no timeout (at=' + r.last().at + ')');
});

test('a stale producer falls back to the viewer', () => {
  const r = rig({ now: 1000 });
  r.aim.setPlayhead(0.1, 6000);
  r.aim.setProducerActive(true);
  r.aim.noteSourceRead({ reader: 'producer', event: 'open', byteStart: 150 * PIECE, position: 150 * PIECE });
  r.clock.now = 1000 + PRODUCER_FRESH_MS + 1; r.refresh();
  assert.ok(r.last().at < 30, 'the viewer (at=' + r.last().at + ')');
});

test('null or transient positions do not snap the window to piece zero', () => {
  const r = rig();
  r.aim.setPlayhead(0.5, 6000); r.refresh();
  const settled = r.last();
  // A bad viewer reading arrives; setPlayhead already refuses it, but the refresh that follows must
  // not fall through to zero either.
  r.aim.setPlayhead(null, 6000); r.aim.setPlayhead(NaN, 6000); r.refresh();
  assert.deepEqual({ at: r.last().at, end: r.last().end }, { at: settled.at, end: settled.end }, 'the window did not move');
  // A bad PRODUCER reading is refused the same way, and does not dislodge an active producer's
  // last good position either.
  r.aim.setProducerActive(true);
  r.aim.noteSourceRead({ reader: 'producer', event: 'open', byteStart: 150 * PIECE, position: 150 * PIECE }); r.refresh();
  const held = r.last();
  r.aim.noteSourceRead({ reader: 'producer', event: 'progress', byteStart: 150 * PIECE, position: NaN });
  r.aim.noteSourceRead({ reader: 'producer', event: 'progress', byteStart: -1, position: -1 }); r.refresh();
  assert.deepEqual({ at: r.last().at, end: r.last().end }, { at: held.at, end: held.end }, 'the producer window did not move');
  // Frac 0 IS a real position — the head of the film, where every new file starts — so a fresh
  // aim legitimately marks the head. The no-position case is a file whose geometry is not known:
  // nothing is marked, rather than a window invented at piece zero.
  const fresh = createCriticalAim({ now: () => 0 });
  const t = fakeTorrent();
  fresh.refresh(t, { _startPiece: 0, _endPiece: 199, length: 0, offset: 0 });
  assert.equal(t.marks.length, 0, 'no window from a file with no length');
});

test('the old window is cleared before the new bounded one is marked', () => {
  const r = rig();
  r.aim.setPlayhead(0.2, 6000); r.refresh();
  r.aim.setPlayhead(0.7, 6000); r.refresh();
  assert.equal(r.t.marks.length, 2);
  assert.equal(r.t.marks[1].listWasEmpty, true, 'the critical list was empty when the second window was marked');
  const flagged = r.t._critical.filter(Boolean).length;
  assert.equal(flagged, r.last().end - r.last().at + 1, 'only the current window is flagged, not the union of every window ever marked');
});

test('several producer Range closes do not deactivate the producer', () => {
  // The measured ffmpeg shape: header read closes, index read closes, then the real read.
  const r = rig();
  r.aim.setPlayhead(0.1, 6000);
  r.aim.setProducerActive(true);
  r.aim.noteSourceRead({ reader: 'producer', event: 'open', byteStart: 0, position: 0 });
  r.aim.noteSourceRead({ reader: 'producer', event: 'close', byteStart: 0, position: 2 * PIECE, complete: false });
  r.aim.noteSourceRead({ reader: 'producer', event: 'open', byteStart: 199 * PIECE, position: 199 * PIECE });
  r.aim.noteSourceRead({ reader: 'producer', event: 'close', byteStart: 199 * PIECE, position: FILE_BYTES, complete: true });
  r.aim.noteSourceRead({ reader: 'producer', event: 'open', byteStart: 150 * PIECE, position: 150 * PIECE });
  r.refresh();
  assert.ok(r.last().at >= 146, 'still the producer after two closes (at=' + r.last().at + ')');
  assert.equal(r.aim.state().producer.active, true);
});

test('a viewer seek still moves the window (the DLNA path)', () => {
  const r = rig();
  r.aim.setPlayhead(0.1, 6000); r.refresh();
  const a = r.last().at;
  r.aim.setPlayhead(0.8, 6000); r.refresh();
  assert.ok(r.last().at > a + 100, 'a viewer seek is a legitimate move (' + a + ' → ' + r.last().at + ')');
});

test('producer observations never mutate the viewer playhead', () => {
  const r = rig();
  r.aim.setPlayhead(0.1, 6000);
  r.aim.setProducerActive(true);
  r.aim.noteSourceRead({ reader: 'producer', event: 'open', byteStart: 150 * PIECE, position: 150 * PIECE });
  r.aim.noteSourceRead({ reader: 'producer', event: 'progress', byteStart: 150 * PIECE, position: 160 * PIECE });
  assert.equal(r.aim.state().viewer.frac, 0.1, 'the viewer is where the viewer was');
});

test('viewer reads on the DLNA route are not producer demand', () => {
  const r = rig();
  r.aim.setPlayhead(0.1, 6000);
  r.aim.setProducerActive(true);
  r.aim.noteSourceRead({ reader: 'viewer', event: 'open', byteStart: 150 * PIECE, position: 150 * PIECE });
  r.refresh();
  assert.ok(r.last().at < 30, 'a television reading through the proxy is the viewer, not the packager (at=' + r.last().at + ')');
  assert.equal(r.aim.state().producer.byteStart, null);
});

test('ordinary non-torrent behaviour is unchanged: no torrent, no marks, no throw', () => {
  const aim = createCriticalAim({ now: () => 0 });
  aim.setPlayhead(0.5, 100);
  aim.setProducerActive(true);
  aim.noteSourceRead({ reader: 'producer', event: 'open', byteStart: 5, position: 5 });
  assert.doesNotThrow(() => aim.refresh(null, null));
  assert.doesNotThrow(() => aim.refresh(fakeTorrent(), null));
});

test('the state is inspectable, because a far-seek log has to show who is in charge and why', () => {
  const r = rig();
  r.aim.setPlayhead(0.1, 6000);
  r.aim.setProducerActive(true);
  r.aim.noteSourceRead({ reader: 'producer', event: 'open', byteStart: 150 * PIECE, position: 150 * PIECE });
  r.refresh();
  const s = r.aim.state();
  assert.equal(s.decision.source, 'producer');
  assert.equal(typeof s.decision.why, 'string');
  assert.deepEqual({ at: s.window.at, end: s.window.end }, { at: r.last().at, end: r.last().end });
});
