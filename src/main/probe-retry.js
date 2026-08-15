'use strict';

// Retrying a probe that came back with nothing.
//
// A probe failure is not neutral information. When ffprobe returns nothing the planner has no codec,
// no resolution and no audio, so it does the safe thing and re-encodes everything — which is correct
// given what it knows, and catastrophic when what it knows is wrong. Observed in a real session: an
// auto-advance to the next episode probed the new file while the swarm happened to be delivering
// nothing, ffprobe hit its 5-second limit, and a 1080p HEVC file that would have been copied
// untouched was instead re-encoded to H.264 for 46 minutes. Nothing errored. Nothing was logged
// beyond the probe failure itself, and the cast simply cost a hundred times more than it should
// have. On a 4K source the same path produces a 4K H.264 re-encode, which is a far worse outcome
// than a slow start.
//
// The first attempt stays short, because it is on the path to the cast button and almost always
// succeeds. Only a failure pays for a retry, so nothing that works today gets slower.

const ATTEMPT_TIMEOUTS = [5000, 12000, 20000];  // escalating: a stalled swarm may just need longer
const RETRY_DELAY_MS = 1500;                     // give the torrent a moment to actually receive data

// probeOnce(timeoutMs, cb) → cb(result | null)
// schedule(fn, ms) is injectable so the retry timing is testable without waiting for it.
function probeWithRetries(probeOnce, cb, opts) {
  const timeouts = (opts && opts.timeouts) || ATTEMPT_TIMEOUTS;
  const delay = (opts && typeof opts.delayMs === 'number') ? opts.delayMs : RETRY_DELAY_MS;
  const schedule = (opts && opts.schedule) || setTimeout;
  const onAttempt = (opts && opts.onAttempt) || (() => {});
  let i = 0;
  const attempt = () => {
    onAttempt(i + 1, timeouts[i]);
    probeOnce(timeouts[i], (result) => {
      // A result — even an unhelpful one — is an answer. Only nothing at all is worth retrying.
      if (result || i >= timeouts.length - 1) return cb(result || null, i + 1);
      i++;
      schedule(attempt, delay);
    });
  };
  attempt();
}

module.exports = { probeWithRetries, ATTEMPT_TIMEOUTS, RETRY_DELAY_MS };
