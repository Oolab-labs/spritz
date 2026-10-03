/* Should the receiver (re)assert the start position it was asked for? Plain ES5.
 *
 * Measured on the LG (2026-09-03): an epoch's HLS playlist is EVENT-typed, and when the television
 * fetched it there was no ENDLIST yet, so webOS treated the stream as LIVE and began at the live
 * edge — epoch-local 816.98s and 530.4s on two runs — overriding the `video.currentTime = startSec`
 * the app had set on loadedmetadata. The coordinate mapping was right; the start point was wrong.
 *
 * So the first `playing` position is checked against the request. Far from it means the player chose
 * its own start and is corrected; within a keyframe snap means the media landed where it could and is
 * left alone. Bounded, because a player that refuses twice is not going to be argued into it, and a
 * receiver stuck in a seek loop is worse than one a few hundred seconds off.
 *
 * Loadable both as a browser script (window.SpritzStartSeek) and as a Node module (for the test).
 */
(function (root) {
  'use strict';

  /* LG growing-playlist comparison (2026-09-28): the former eight-second window
   * accepted 20.1s for a 24.3s request. Limit arrival to one two-second segment;
   * the existing bounded corrections/rollback handle a larger mismatch. */
  var START_TOLERANCE_SEC = 2;
  /* Once to fix the live start, once more in case the first seek was itself swallowed. */
  var START_MAX_ATTEMPTS = 2;

  function finite(n) { return typeof n === 'number' && isFinite(n); }

  /* requested — the epoch-local start the Mac asked for (LOAD startSec).
   * current   — the player's reported currentTime at its first `playing` (or after a correction).
   * attempts  — how many corrections have already been made for this load.
   * Returns { action, seek, to, why }; action distinguishes waiting, arrival and exhaustion. */
  function result(action, seek, to, why) {
    return { action: action, seek: seek, to: to, why: why };
  }

  function startSeekPlan(o) {
    o = o || {};
    var req = o.requested, cur = o.current, n = o.attempts || 0;
    /* Null means no pending request. Zero is a real start target and must not be erased by a
     * truthiness check: a growing EVENT presentation can choose its live edge for a zero-origin
     * load just as it can for a nonzero epoch. */
    if (!finite(req) || req < 0) return result('none', false, null, 'no start requested');
    /* A position the player cannot report yet is not a position. The LG's first report was
     * INT64_MIN over 1e9 — "no PTS yet" — and a seek issued on that fires before there is a
     * timeline to seek in. */
    if (!finite(cur) || cur < 0) {
      /* LG EVENT HLS can expose no PTS indefinitely while paused, despite
       * loaded data and a valid seek range. A seek initializes that clock. */
      var pausedRange = o.pausedStartup && o.readyState >= 2 && o.seekable && o.seekable.some(function (range) {
        return range && finite(range[0]) && finite(range[1]) && range[0] >= 0 && range[1] > range[0] && req >= range[0] && req <= range[1];
      });
      if (pausedRange && n < START_MAX_ATTEMPTS) return result('seek', true, req, 'initialize paused clock after data loaded');
      return result('wait', false, null, 'no usable position yet');
    }
    if (Math.abs(cur - req) < START_TOLERANCE_SEC) {
      return result('settled', false, null, 'within a keyframe snap of the request');
    }
    if (o.seekable && !o.seekable.some(function (range) {
      return range && finite(range[0]) && finite(range[1]) && range[0] >= 0 &&
        range[1] > range[0] && req >= range[0] && req <= range[1];
    })) {
      return o.waitedMs >= 30000
        ? result('exhausted', false, null, 'requested position did not become seekable')
        : result('wait', false, null, 'requested position is not seekable yet');
    }
    /* A completed final correction can arrive with the budget fully spent. Recognize that arrival
     * before deciding that the same completed observation missed and exhausted the budget. */
    if (n >= START_MAX_ATTEMPTS) return result('exhausted', false, null, 'gave up after ' + n + ' attempts');
    return result('seek', true, req, 'player started ' + Math.round(cur - req) + 's from the request — far from it');
  }

  var api = { startSeekPlan: startSeekPlan, START_TOLERANCE_SEC: START_TOLERANCE_SEC, START_MAX_ATTEMPTS: START_MAX_ATTEMPTS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SpritzStartSeek = api;
})(typeof window !== 'undefined' ? window : this);
