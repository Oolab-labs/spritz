'use strict';

// How far ahead of the play head to prioritise, expressed in SECONDS OF PLAYBACK.
//
// The readahead window used to be a fixed count of pieces (24). A piece count is the wrong unit
// because a piece is not a fixed amount of video. Torrent piece length scales with total size, so
// on a 40GB 4K release with 16MB pieces, 24 pieces is ~384MB — several minutes, far more than
// needed, and every one of those pieces is marked as urgent as the one mpv is about to read. On a
// 350MB episode with 256KB pieces the same 24 is ~6MB, which at 3 Mbps is about fifteen seconds and
// evaporates on the first slow patch. One constant cannot be right for both.
//
// What actually matters is time: keep roughly N seconds of playback urgent, whatever that is in
// bytes for this particular file. Everything here is pure arithmetic so it can be tested without a
// swarm — which matters, because the failure mode (stuttering on a marginal swarm) is otherwise
// only reproducible by finding a marginal swarm.

// Fallback when duration is unknown (metadata not parsed yet, or a stream with no duration).
// Deliberately the old constant: no worse than the behaviour this replaces.
const FALLBACK_PIECES = 24;

// Bounds on the computed window. The lower bound keeps a tiny-bitrate file from producing a
// one-piece window that cannot absorb any jitter. The upper bound is the important one: marking
// too much as critical is not free — webtorrent treats critical pieces as a set to fetch urgently,
// and once most of the file is in it the flag stops discriminating between "needed now" and
// "needed eventually", which stutters worse than no window at all.
const MIN_PIECES = 4;
const MAX_PIECES = 160;

// Average bytes per second of playback for this file. Approximate on VBR content — the whole
// mapping from time to bytes is — but the error is a scaling factor on a heuristic window, not a
// seek target, so approximate is fine.
function bytesPerSecond(fileBytes, durationSec) {
  if (!(fileBytes > 0) || !(durationSec > 0)) return null;
  return fileBytes / durationSec;
}

// The piece window to mark critical, as [at, end] inclusive.
//
// `targetSeconds` is how much playback to keep urgent. It starts a couple of pieces BEHIND the
// estimate on purpose: playFrac is a time fraction mapped onto bytes, and clearing the previous
// critical set also drops webtorrent's own reactive mark for the read it is currently serving, so
// a small overlap is cheap insurance against prioritising just past the real read head.
function criticalWindow(opts) {
  const {
    startPiece, endPiece, pieceLength, fileBytes, durationSec,
    playFrac = 0, targetSeconds = 30, lookBehindPieces = 2
  } = opts || {};

  if (!Number.isFinite(startPiece) || !Number.isFinite(endPiece) || endPiece < startPiece) return null;
  const span = endPiece - startPiece + 1;
  if (span <= 1) return null;

  const bps = bytesPerSecond(fileBytes, durationSec);
  let pieces;
  if (bps && pieceLength > 0 && targetSeconds > 0) {
    pieces = Math.ceil((bps * targetSeconds) / pieceLength);
  } else {
    pieces = FALLBACK_PIECES;
  }
  pieces = Math.max(MIN_PIECES, Math.min(MAX_PIECES, pieces));
  // Never mark the entire file: that is the degenerate case the bound above exists to prevent, and
  // a short file can reach it even within MAX_PIECES.
  pieces = Math.min(pieces, Math.max(1, Math.floor(span / 2)));

  const frac = Math.min(1, Math.max(0, playFrac));
  const est = startPiece + Math.floor(frac * span);
  const at = Math.max(startPiece, est - lookBehindPieces);
  // pieces - 1: the window is inclusive of both ends, so `at + pieces` would span one MORE than
  // the count just clamped, quietly exceeding MAX_PIECES by one.
  const end = Math.min(endPiece, at + pieces - 1);
  if (end < at) return null;

  return {
    at,
    end,
    pieces: end - at + 1,
    // What the window is actually worth in playback time — the number the unit is supposed to be.
    secondsCovered: bps ? ((end - at + 1) * pieceLength) / bps : null
  };
}

// Can the swarm sustain playback, and how much runway is there?
//
// Reported rather than acted upon: the useful thing is telling the user "this will stall in ~20s"
// instead of showing a spinner with no explanation once it already has. Deliberately does NOT feed
// back into the window size — reacting to a dip by widening the urgent set makes contention worse,
// which is the opposite of what a starving player needs.
function bufferHealth(opts) {
  const { bufferedBytesAhead, downloadBps, fileBytes, durationSec } = opts || {};
  const bps = bytesPerSecond(fileBytes, durationSec);
  if (!bps || !Number.isFinite(bufferedBytesAhead) || bufferedBytesAhead < 0) {
    return { known: false, risk: 'unknown', secondsBuffered: null, sustainable: null, secondsToEmpty: null };
  }
  const secondsBuffered = bufferedBytesAhead / bps;
  const sustainable = Number.isFinite(downloadBps) ? downloadBps >= bps : null;

  // How long the buffer lasts if the current rate holds. Playback drains at `bps`; download refills
  // at `downloadBps`. Only meaningful while the deficit is real.
  let secondsToEmpty = null;
  if (Number.isFinite(downloadBps) && downloadBps < bps) {
    secondsToEmpty = bufferedBytesAhead / (bps - downloadBps);
  }

  let risk;
  if (sustainable === true) risk = secondsBuffered >= 10 ? 'low' : 'building';
  // Under a minute of runway is the point where telling the user is worth doing — at 30s the
  // warning and the stall arrive together, which is no warning at all.
  else if (sustainable === false) risk = secondsToEmpty != null && secondsToEmpty < 60 ? 'high' : 'medium';
  else risk = secondsBuffered >= 30 ? 'low' : 'unknown';

  return { known: true, risk, secondsBuffered, sustainable, secondsToEmpty };
}

module.exports = { criticalWindow, bufferHealth, bytesPerSecond, FALLBACK_PIECES, MIN_PIECES, MAX_PIECES };
