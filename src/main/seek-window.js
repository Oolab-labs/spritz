'use strict';

// Serving a byte range the torrent has not downloaded yet.
//
// A finished file on disk is seekable for free: the receiver asks for bytes, /file/ serves them, and
// pausing, seeking and stalling are all just "did not ask for the next range". That is the whole
// argument in send-original.js. A still-downloading torrent is the one source where it does not
// hold, because the bytes may not exist yet — so the DLNA proxy advertises DLNA.ORG_OP=00 and the
// LG is told, truthfully, that it cannot seek (lanserver.js). The television then reads linearly
// and the viewer gets a two-hour film with no scrubber.
//
// Nothing about that is a limit of the swarm. webtorrent will happily stream a read from the middle
// of a file — it selects the pieces and waits. The reason seeking was disabled is TIMING: an
// unprioritised read lands in the piece picker behind the sequential readahead, and the renderer
// gives up long before the bytes arrive.
//
// So the missing piece is not a download mechanism, it is a PRIORITY one, and this project already
// has the shape of it. ensureIndexForCast (torrent.js) selects a piece range, marks it critical,
// polls the bitfield and proceeds when it is in hand. A seek is the same operation aimed at a
// different offset.
//
// This module is that arithmetic, kept pure so it can be tested without a swarm — the same reason
// buffer-plan.js is pure. It answers two questions and nothing else: which pieces must become
// urgent for this seek, and is enough of them here to start writing a body.

// Bounds on the urgent window, in pieces. The upper bound is the important one and the reason is
// recorded in torrent.js: webtorrent's critical set is never unset, and once most of a file is in
// it the flag stops discriminating between "needed now" and "needed eventually" — which stutters
// worse than having no window at all. A seek must claim a beachhead, not the rest of the film.
const MIN_PIECES = 2;
const MAX_PIECES = 64;

// How much of the window has to be in hand before the body starts. Deliberately small: the point is
// to start writing as soon as the read can proceed, and let the rest arrive underneath a receiver
// that is already draining the socket. Waiting for the whole window would reintroduce the delay
// this exists to remove.
const START_PIECES = 2;

// Which pieces cover the read, as ABSOLUTE torrent piece indices.
//
// byteStart  — offset within the FILE, which is what a Range header carries.
// fileOffset — where the file begins inside the torrent's flat byte space (webtorrent's file.offset).
// aheadBytes — how much beyond the seek point to make urgent. Sized by the caller; a whole-file
//              default here would be the degenerate case MAX_PIECES exists to prevent.
//
// Returns { at, end } inclusive, clamped to the file, or null when the geometry is unusable or the
// read starts past the end of the file.
function seekWindow({ byteStart, fileOffset = 0, fileLength, pieceLength, aheadBytes } = {}) {
  const start = Number(byteStart);
  const base = Number(fileOffset) || 0;
  const len = Number(fileLength);
  const pl = Number(pieceLength);
  if (!Number.isFinite(start) || start < 0) return null;
  if (!Number.isFinite(len) || len <= 0) return null;
  if (!Number.isFinite(pl) || pl <= 0) return null;
  if (start >= len) return null;                       // a range past the end is not a seek

  const firstPiece = Math.floor(base / pl);
  const lastPiece = Math.floor((base + len - 1) / pl);
  const at = Math.floor((base + start) / pl);

  const ahead = Number(aheadBytes) > 0 ? Number(aheadBytes) : pl * MIN_PIECES;
  let pieces = Math.ceil(ahead / pl);
  pieces = Math.max(MIN_PIECES, Math.min(MAX_PIECES, pieces));
  const end = Math.min(lastPiece, at + pieces - 1);
  if (end < at) return null;
  return { at, end, firstPiece, lastPiece, pieces: end - at + 1 };
}

// Is enough of the window here to start writing?
//
// CONTIGUOUS from `at`, not a count of present pieces anywhere in the range. A read stops at the
// first hole no matter how much sits beyond it — the same reason bytesAheadOfPlayhead in torrent.js
// measures a contiguous run rather than a total.
//
// have — (pieceIndex) => boolean, normally the torrent's bitfield. Anything it throws on counts as
//        absent, because a bitfield that cannot answer is not evidence that a piece is there.
function seekReadiness({ at, end, have, startPieces } = {}) {
  const need = Number.isFinite(startPieces) && startPieces > 0 ? Math.floor(startPieces) : START_PIECES;
  if (!Number.isFinite(at) || !Number.isFinite(end) || end < at || typeof have !== 'function') {
    return { contiguous: 0, total: 0, need, ready: false };
  }
  const total = end - at + 1;
  let contiguous = 0;
  for (let p = at; p <= end; p++) {
    let ok = false;
    try { ok = !!have(p); } catch (e) { ok = false; }
    if (!ok) break;
    contiguous++;
  }
  // A window shorter than the requirement is satisfied by having all of it — otherwise a seek into
  // the last piece of a film could never become ready.
  return { contiguous, total, need, ready: contiguous >= Math.min(need, total) };
}

module.exports = { seekWindow, seekReadiness, MIN_PIECES, MAX_PIECES, START_PIECES };
