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
  const unschedule = (opts && opts.unschedule) || clearTimeout;
  let retryTimer = null, cancelProbe = null;
  const onAttempt = (opts && opts.onAttempt) || (() => {});
  let i = 0;
  let finished = false;
  const attempt = () => {
    if (finished) return;
    const index = i;
    let answered = false;
    onAttempt(i + 1, timeouts[i]);
    const dispose = probeOnce(timeouts[i], (result) => {
      // Child processes can emit error followed by close. Each attempt owns one
      // answer; an old attempt must not advance a newer attempt's retry counter.
      if (answered || finished) return;
      answered = true;
      cancelProbe = null;
      // A result — even an unhelpful one — is an answer. Only nothing at all is worth retrying.
      if (result || index >= timeouts.length - 1) {
        finished = true;
        return cb(result || null, index + 1);
      }
      i = index + 1;
      retryTimer = schedule(() => { retryTimer = null; attempt(); }, delay);
    });
    // A synchronous completion must not replace a newer attempt's disposer.
    if (!answered && !finished && typeof dispose === 'function') cancelProbe = dispose;
  };
  const cancel = () => {
    if (finished) return;
    finished = true; // guard callbacks before killing a child that may answer synchronously
    if (retryTimer !== null) unschedule(retryTimer);
    retryTimer = null;
    const dispose = cancelProbe;
    cancelProbe = null;
    if (dispose) dispose();
  };
  attempt();
  return cancel;
}

module.exports = { probeWithRetries, ATTEMPT_TIMEOUTS, RETRY_DELAY_MS };
