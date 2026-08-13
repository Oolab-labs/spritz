'use strict';

// Readahead sizing. The point of this module is that a piece count is the wrong unit — piece
// length scales with torrent size, so one constant cannot suit both a 40GB 4K release and a
// 350MB episode. These tests are mostly about that: the same target in seconds must produce very
// different piece counts for the two, and similar coverage in time.

const { test } = require('node:test');
const assert = require('assert');
const { criticalWindow, bufferHealth, bytesPerSecond, MAX_PIECES, FALLBACK_PIECES } = require('../src/main/buffer-plan');

// A 40GB 4K remux: 16MB pieces, ~2h. Roughly 47 Mbps.
const BIG = { fileBytes: 40 * 1024 ** 3, durationSec: 7200, pieceLength: 16 * 1024 * 1024,
  startPiece: 0, endPiece: 2559 };
// A 350MB episode: 256KB pieces, ~22min. Roughly 2.2 Mbps.
const SMALL = { fileBytes: 350 * 1024 ** 2, durationSec: 1320, pieceLength: 256 * 1024,
  startPiece: 0, endPiece: 1399 };

test('the same target in seconds yields very different piece counts per torrent', () => {
  const big = criticalWindow({ ...BIG, playFrac: 0.25, targetSeconds: 30 });
  const small = criticalWindow({ ...SMALL, playFrac: 0.25, targetSeconds: 30 });
  // This is the whole argument for the change. A fixed 24 was minutes of video for one and
  // seconds for the other.
  assert.notStrictEqual(big.pieces, small.pieces);
  assert.ok(small.pieces > big.pieces, 'smaller pieces need more of them for the same 30s');
});

test('coverage in seconds lands near the target for both', () => {
  for (const [label, f] of [['4K remux', BIG], ['episode', SMALL]]) {
    const w = criticalWindow({ ...f, playFrac: 0.25, targetSeconds: 30 });
    // Piece granularity means it cannot be exact — one piece of a 4K remux is ~2.7s on its own.
    assert.ok(w.secondsCovered >= 25 && w.secondsCovered <= 60,
      label + ' covered ' + Math.round(w.secondsCovered) + 's, expected roughly 30');
  }
});

test('the window travels with the play head', () => {
  const a = criticalWindow({ ...SMALL, playFrac: 0.1, targetSeconds: 30 });
  const b = criticalWindow({ ...SMALL, playFrac: 0.6, targetSeconds: 30 });
  assert.ok(b.at > a.at, 'window must move forward with playback');
  assert.ok(a.end < b.at, 'a jump forward should leave the old window entirely behind');
});

test('the window starts slightly behind the estimate', () => {
  // playFrac is a TIME fraction mapped onto BYTES, and clearing the critical set drops
  // webtorrent's own reactive mark for the read in flight. Overlap is deliberate insurance.
  const w = criticalWindow({ ...SMALL, playFrac: 0.5, targetSeconds: 30, lookBehindPieces: 2 });
  const est = SMALL.startPiece + Math.floor(0.5 * (SMALL.endPiece - SMALL.startPiece + 1));
  assert.strictEqual(w.at, est - 2);
});

test('the window is bounded, and never swallows the whole file', () => {
  // Marking most of the file critical is worse than marking none: the flag stops discriminating.
  const greedy = criticalWindow({ ...SMALL, playFrac: 0, targetSeconds: 100000 });
  assert.ok(greedy.pieces <= MAX_PIECES, 'must respect the hard cap');
  const span = SMALL.endPiece - SMALL.startPiece + 1;
  assert.ok(greedy.pieces <= span / 2, 'must never cover more than half the file');

  // A short file can hit the half-file rule well inside MAX_PIECES.
  const tiny = criticalWindow({ fileBytes: 5 * 1024 ** 2, durationSec: 30,
    pieceLength: 256 * 1024, startPiece: 0, endPiece: 19, playFrac: 0, targetSeconds: 30 });
  assert.ok(tiny.pieces <= 10, 'half of a 20-piece file at most, got ' + tiny.pieces);
});

test('unknown duration falls back to the previous behaviour rather than guessing', () => {
  const w = criticalWindow({ ...SMALL, durationSec: 0, playFrac: 0.25, targetSeconds: 30 });
  assert.strictEqual(w.pieces, FALLBACK_PIECES, 'falls back to the old constant exactly');
  assert.strictEqual(w.secondsCovered, null, 'cannot claim a duration it does not know');
});

test('degenerate inputs produce no window instead of a bad one', () => {
  assert.strictEqual(criticalWindow(null), null);
  assert.strictEqual(criticalWindow({ startPiece: 5, endPiece: 5, pieceLength: 1024 }), null,
    'a single-piece file has nothing to prioritise');
  assert.strictEqual(criticalWindow({ startPiece: 10, endPiece: 2, pieceLength: 1024 }), null);
  assert.strictEqual(criticalWindow({ startPiece: NaN, endPiece: 10, pieceLength: 1024 }), null);
});

test('the window stays inside the file at the very end', () => {
  const w = criticalWindow({ ...SMALL, playFrac: 1, targetSeconds: 30 });
  assert.ok(w.end <= SMALL.endPiece, 'must not run past the last piece');
  assert.ok(w.at >= SMALL.startPiece);
});

// --- bufferHealth ---

test('bufferHealth reports runway in seconds, not bytes', () => {
  const bps = bytesPerSecond(SMALL.fileBytes, SMALL.durationSec);
  const h = bufferHealth({ bufferedBytesAhead: bps * 45, downloadBps: bps * 2,
    fileBytes: SMALL.fileBytes, durationSec: SMALL.durationSec });
  assert.ok(h.known);
  assert.ok(Math.abs(h.secondsBuffered - 45) < 0.5);
  assert.strictEqual(h.sustainable, true);
  assert.strictEqual(h.risk, 'low');
});

test('bufferHealth predicts a stall before it happens', () => {
  // The useful case: downloading at half the rate playback consumes, 20s in hand.
  const bps = bytesPerSecond(SMALL.fileBytes, SMALL.durationSec);
  const h = bufferHealth({ bufferedBytesAhead: bps * 20, downloadBps: bps * 0.5,
    fileBytes: SMALL.fileBytes, durationSec: SMALL.durationSec });
  assert.strictEqual(h.sustainable, false);
  assert.strictEqual(h.risk, 'high');
  assert.ok(Math.abs(h.secondsToEmpty - 40) < 1, 'a 20s buffer draining at half rate lasts ~40s');
});

test('bufferHealth says it does not know rather than inventing a number', () => {
  const h = bufferHealth({ bufferedBytesAhead: 1000, downloadBps: 1000, fileBytes: 0, durationSec: 0 });
  assert.strictEqual(h.known, false);
  assert.strictEqual(h.risk, 'unknown');
  assert.strictEqual(h.secondsBuffered, null);
});
