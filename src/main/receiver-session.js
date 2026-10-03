'use strict';

// Should a reconnecting receiver be sent a fresh LOAD, or does it already hold the film?
//
// This exists because of a measured failure. On hardware, dropping the control socket mid-film, the
// television reconnected in 1.4s and re-announced itself correctly — capabilities, LOADED with the
// right duration, STATE playing, at film 5905.4s. The controller sent LOAD on every greeting, and
// the film restarted from zero: 5905.4s -> 7.8s. The receiver did exactly what it was designed to
// do and the Mac discarded the answer.
//
// The rule is a pure function rather than a branch inside a socket handler for two reasons: a socket
// handler cannot be tested at the boundaries that matter (paused, ended, unusable clock), and the
// next controller — production wiring, a second receiver platform — would otherwise reimplement it
// slightly differently.
//
// The bias is deliberate: when in doubt, DO NOT reload. A needless reload destroys a viewer's place
// in a film, which is loud and unrecoverable; a needless skip leaves a receiver showing what it was
// already showing, which the next command corrects.

// A receiver in one of these states is still holding its film, and must not be interrupted.
// `ended` is deliberately absent: there is nothing left to resume, and treating it as "holding"
// would strand a viewer on a finished film with a controller that believes all is well.
const HOLDING = ['playing', 'paused', 'buffering', 'loading'];

function shouldLoad({ hello, desired } = {}) {
  const h = hello || {};
  if (h.role !== 'receiver') return { load: false, why: 'not a receiver hello' };
  if (!desired || !desired.mediaId) return { load: false, why: 'nothing to play' };

  const cur = h.playing || null;
  if (!cur || !cur.mediaId) return { load: true, why: 'receiver has nothing loaded' };
  if (String(cur.mediaId) !== String(desired.mediaId)) {
    return { load: true, why: 'receiver holds a different media (' + cur.mediaId + ')' };
  }
  if (!HOLDING.includes(String(cur.state))) {
    return { load: true, why: 'receiver holds the film but is ' + cur.state };
  }
  // The same film can have more than one TRANSPORT: a far seek replaces the HLS representation
  // with a new ffmpeg-owned run at that position — a new epoch, a new URL — while the film stays
  // the film (see transport-epoch.js). A receiver still holding the previous epoch must be moved
  // to the new one, and that is a LOAD, decided here and nowhere else. Judged only when BOTH sides
  // name an epoch: a receiver build that cannot report one is judged by the film alone, so the
  // hardware-proven reconnect keeps adopting.
  if (desired.epoch != null && cur.epoch != null && String(cur.epoch) !== String(desired.epoch)) {
    return { load: true, why: 'receiver holds an older transport epoch (' + cur.epoch + ', want ' + desired.epoch + ')' };
  }

  // Adopt what the receiver reported rather than reconstructing it. The television's clock is
  // authoritative — it is the only one that knows where the picture actually is — and a value it
  // could not supply is passed through as unknown rather than invented, so a caller cannot mistake
  // a guess for a reading.
  // `Number(null)` is 0, not NaN — so a receiver that could not supply a clock would arrive here as
  // a confident "position zero". That is the exact trap receiver-playhead.js documents: a receiver
  // reports 0 while loading far more often than a viewer sits at exactly 0.000s.
  const t = (cur.currentTime == null || cur.currentTime === '') ? NaN : Number(cur.currentTime);
  return {
    load: false,
    why: 'receiver already holds this film',
    adopt: {
      mediaId: String(cur.mediaId),
      epoch: cur.epoch == null ? null : String(cur.epoch),
      currentTime: Number.isFinite(t) ? t : null,
      state: String(cur.state)
    }
  };
}

module.exports = { shouldLoad, HOLDING };
