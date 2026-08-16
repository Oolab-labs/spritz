'use strict';

// Where a re-requested cast stream should start.
//
// The cast stream is a live pipe: ffmpeg seeks once, then writes until something stops it. When the
// receiver re-requests the URL — which it does on any stall, and which we do not control — the
// server relaunches ffmpeg. It relaunched from the position the cast originally started at, and that
// turns one hiccup into a loop.
//
// Observed on a live cast, resumed at 3032s of a 6941s film:
//
//   14:43:52  launch -ss 3032   PLAYING at 3032s
//   14:46:28  stream killed
//   14:46:43  re-GET -> launch -ss 3032      receiver is at 3212s
//   14:47:03  BUFFERING at 3212s ............ for 53 seconds
//   14:48:14  re-GET -> launch -ss 3032      receiver is at 3262s
//   14:48:46  BUFFERING at 3262s
//
// Each restart feeds the receiver video from three minutes behind where it is sitting. Because
// timestamps are absolute (-copyts), the receiver holds its clock and waits for content at its own
// position, which only arrives once ffmpeg has streamed the intervening minutes. Long enough for it
// to give up and re-request again. The film appears to "only cast for a few minutes, around the
// middle" — the middle being the resume point it keeps getting dragged back to.
//
// So a restart resumes from where the receiver actually is. A few seconds of rewind, because the
// receiver has already buffered slightly past what it last reported and a small overlap is
// imperceptible where a gap is not.

const REWIND_SEC = 4;

// first      — is this the first time this stream has been served? The first GET must honour the
//              position the user actually asked for.
// startSec   — where the cast was told to start.
// livePos    — the receiver's most recently reported position, or 0 if it has never said.
// durationSec— the media length, used only to reject nonsense.
//
// Returns the seconds to seek to. Never goes backwards past startSec, and never trusts a reported
// position that cannot be true.
function resumePosition({ first, startSec, livePos, durationSec, rewind } = {}) {
  const start = Number.isFinite(startSec) && startSec > 0 ? startSec : 0;
  if (first) return start;
  const pos = Number(livePos);
  if (!Number.isFinite(pos) || pos <= 0) return start;          // the receiver never reported
  // A position beyond the end is a stale or bogus reading; a position behind where we already
  // started means the receiver has not caught up yet, and restarting earlier would only lengthen
  // the catch-up it is already waiting through.
  if (Number.isFinite(durationSec) && durationSec > 0 && pos > durationSec) return start;
  if (pos <= start) return start;
  const back = Number.isFinite(rewind) ? rewind : REWIND_SEC;
  return Math.max(start, Math.floor(pos - back));
}

// Is a position the receiver just reported worth believing?
//
// It reports currentTime 0 while IDLE and while BUFFERING, and taking those at face value wipes the
// resume clock. Measured consequence: a recast triggered while the film was paused at 3876s
// relaunched at 3391s, minutes behind, because a transitional zero had overwritten the position it
// read.
function trustPosition(playerState, currentTime) {
  if (typeof currentTime !== 'number' || !(currentTime > 0)) return false;
  return playerState === 'PLAYING' || playerState === 'PAUSED';
}

// What state is the receiver actually in, given a status frame that may not say?
//
// It emits frequent frames carrying only a timestamp, with no playerState and no media block — a
// quirk this codebase had already documented elsewhere and which the position rule above then
// discarded, because a frame with no state fails the PLAYING/PAUSED test. The consequence was that
// the position only ever updated on a state CHANGE: measured over a 7m14s cast, the last recorded
// position was 1s, and the recovery duly restarted the film from the beginning.
//
// A frame that does not mention the state is not a state change. It means "still whatever I said".
function effectiveState(frameState, lastKnownState) {
  return frameState || lastKnownState || null;
}

module.exports = { resumePosition, trustPosition, effectiveState, REWIND_SEC };
