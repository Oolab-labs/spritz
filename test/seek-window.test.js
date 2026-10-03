'use strict';

// Piece arithmetic for a seek into a still-downloading torrent. Pure, so the interesting cases —
// a seek into the last piece, a hole in the middle of the window, a file that does not start on a
// piece boundary — can be tested without a swarm.

const { test } = require('node:test');
const assert = require('assert');
const { seekWindow, seekReadiness, MAX_PIECES, START_PIECES } = require('../src/main/seek-window');

// A 40GB 4K remux inside a torrent that has a small file ahead of it, so file.offset is not 0 and
// the file does not begin on a piece boundary. That misalignment is the case most likely to be got
// wrong, so it is the default fixture.
const PL = 16 * 1024 * 1024;
const BIG = { fileOffset: PL + 1024, fileLength: 40 * 1024 ** 3, pieceLength: PL };

test('a seek maps to the piece containing that byte of the FILE, not of the torrent', () => {
  const w = seekWindow({ ...BIG, byteStart: 0, aheadBytes: PL * 4 });
  // The file starts 1024 bytes into piece 1, so its first byte lives in piece 1 — not piece 0.
  assert.equal(w.at, 1);
  assert.equal(w.firstPiece, 1);
});

test('the window starts where the receiver asked, not where playback was', () => {
  const at20gb = seekWindow({ ...BIG, byteStart: 20 * 1024 ** 3, aheadBytes: PL * 4 });
  assert.equal(at20gb.at, Math.floor((BIG.fileOffset + 20 * 1024 ** 3) / PL));
  assert.equal(at20gb.pieces, 4);
});

test('the urgent window is bounded, so a seek cannot claim the rest of the film', () => {
  // The failure this prevents is recorded in torrent.js: webtorrent never unsets a critical piece,
  // so a window covering most of the file makes the flag meaningless.
  const w = seekWindow({ ...BIG, byteStart: 0, aheadBytes: 40 * 1024 ** 3 });
  assert.equal(w.pieces, MAX_PIECES);
});

test('a tiny request still gets a window big enough to absorb one hole', () => {
  const w = seekWindow({ ...BIG, byteStart: 0, aheadBytes: 1 });
  assert.ok(w.pieces >= 2, 'got ' + w.pieces);
});

test('the window never runs past the end of the file', () => {
  const w = seekWindow({ ...BIG, byteStart: BIG.fileLength - 10, aheadBytes: PL * 32 });
  assert.equal(w.end, w.lastPiece);
  assert.ok(w.at <= w.end);
});

test('a range starting past the end of the file is not a seek', () => {
  assert.equal(seekWindow({ ...BIG, byteStart: BIG.fileLength }), null);
  assert.equal(seekWindow({ ...BIG, byteStart: BIG.fileLength + 1 }), null);
});

test('unusable geometry yields nothing rather than a wrong window', () => {
  assert.equal(seekWindow({ ...BIG, byteStart: -1 }), null);
  assert.equal(seekWindow({ ...BIG, byteStart: NaN }), null);
  assert.equal(seekWindow({ byteStart: 0, fileLength: 0, pieceLength: PL }), null);
  assert.equal(seekWindow({ byteStart: 0, fileLength: 100, pieceLength: 0 }), null);
  assert.equal(seekWindow(), null);
});

// ---- readiness -----------------------------------------------------------------------------

const haveSet = (set) => (p) => set.has(p);

test('a window whose leading pieces are present is ready', () => {
  const r = seekReadiness({ at: 10, end: 20, have: haveSet(new Set([10, 11, 12])) });
  assert.equal(r.contiguous, 3);
  assert.equal(r.ready, true);
});

test('pieces present BEYOND a hole do not count, because the read stops at the hole', () => {
  // 10 is here, 11 is not, 12-20 are. A reader gets one piece and blocks.
  const set = new Set([10, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
  const r = seekReadiness({ at: 10, end: 20, have: haveSet(set) });
  assert.equal(r.contiguous, 1);
  assert.equal(r.ready, false, 'nine present pieces past a hole are worth nothing');
});

test('an empty window is not ready', () => {
  const r = seekReadiness({ at: 10, end: 20, have: () => false });
  assert.equal(r.contiguous, 0);
  assert.equal(r.ready, false);
});

test('a window shorter than the start requirement is satisfied by having all of it', () => {
  // A seek into the final piece of a film can never accumulate START_PIECES; requiring it would
  // make the last few seconds permanently unseekable.
  assert.ok(START_PIECES > 1, 'this test is only meaningful while more than one piece is wanted');
  const r = seekReadiness({ at: 99, end: 99, have: haveSet(new Set([99])) });
  assert.equal(r.total, 1);
  assert.equal(r.ready, true);
});

test('a bitfield that throws counts as absent, not as present', () => {
  const r = seekReadiness({ at: 10, end: 20, have: () => { throw new Error('destroyed'); } });
  assert.equal(r.contiguous, 0);
  assert.equal(r.ready, false);
});

test('nonsense input is not ready', () => {
  assert.equal(seekReadiness({ at: 20, end: 10, have: () => true }).ready, false);
  assert.equal(seekReadiness({ at: 10, end: 20 }).ready, false, 'no bitfield, no evidence');
  assert.equal(seekReadiness().ready, false);
});
