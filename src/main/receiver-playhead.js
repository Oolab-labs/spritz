'use strict';

// Where the torrent's download urgency should be aimed while a RECEIVER is playing.
//
// torrent.js keeps a CRITICAL piece window travelling just ahead of the play head, so a marginal
// swarm spends its request slots on the bytes about to be needed rather than on plain sequential
// order (see buffer-plan.js for why that window is measured in seconds, not pieces).
//
// That window only ever moved for LOCAL playback. `setPlayhead` had exactly one caller — mpv's
// time-pos property — so the moment a film was handed to a Chromecast, an AirPlay item or the LG
// over DLNA, the play head froze wherever mpv had last left it, usually 0. For the whole of a cast,
// the pieces the television was actually about to read were no more urgent than any other. The
// prebuffer carries the opening minutes; after that the swarm is downloading the front of the film
// while the TV reads the middle of it.
//
// Receivers do report where they are. Chromecast pushes status frames (guarded by
// resume-point.js's trustPosition, because it also reports 0 while IDLE and BUFFERING), and the
// DLNA poll reads RelTime/TrackDuration every tick. Both are already parsed and already thrown at
// the resume clock; neither ever reached the torrent engine.
//
// This module is the gate between the two. It answers one question — is this reading worth aiming
// the download window at? — and nothing else, because getting it wrong is not neutral: a bogus
// reading does not merely fail to help, it drags the critical window somewhere the viewer is not.

// The localhost URL webtorrent serves a streamed file from. Casting rewrites the host to the LAN
// address before handing it to a television, so this is matched against the source Spritz loaded,
// not against whatever the receiver was ultimately given.
const TORRENT_URL = /^http:\/\/(?:localhost|127\.0\.0\.1):\d+\/webtorrent\//i;

function isTorrentSource(url) {
  return TORRENT_URL.test(String(url || ''));
}

// cur — the receiver's reported position, in seconds of the SOURCE timeline. Both transports
//       satisfy that: the DLNA proxy serves the original file, and the Chromecast MKV stream is cut
//       with -copyts so its timestamps stay absolute.
// dur — the source's duration. Required, not optional: the window is sized in seconds of playback,
//       so without a length there is no fraction to aim and no readahead to compute.
//
// Returns a 0..1 fraction, or null when the reading must not move the window. Null is the safe
// answer everywhere, because leaving the window where it is costs one stale window while acting on
// a bad reading costs a correct one.
function playheadFraction({ cur, dur } = {}) {
  const t = Number(cur);
  const d = Number(dur);
  // Zero is rejected along with the impossible values, deliberately. A receiver reports 0 while it
  // is still loading far more often than a viewer sits at exactly 0.000s, and the cost of refusing
  // the genuine case is nil — the window already starts at the head of the file.
  if (!Number.isFinite(t) || !(t > 0)) return null;
  if (!Number.isFinite(d) || !(d > 0)) return null;
  // Past the end is a stale or nonsense reading. resume-point.js rejects the same shape for the
  // same reason.
  if (t > d) return null;
  return t / d;
}

// The whole decision in one call, for the two status handlers in main.js.
//
// source — the URL Spritz loaded. A cast of a local file while a torrent happens to be active must
//          NOT aim that torrent's window at the local file's play head; they are unrelated
//          timelines, and there is only one active torrent.
//
// Returns { frac, durationSec } ready to spread into setPlayhead, or null to do nothing.
function playheadUpdate({ source, cur, dur } = {}) {
  if (!isTorrentSource(source)) return null;
  const frac = playheadFraction({ cur, dur });
  if (frac == null) return null;
  return { frac, durationSec: Number(dur) };
}

module.exports = { isTorrentSource, playheadFraction, playheadUpdate, TORRENT_URL };
