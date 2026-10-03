'use strict';

// A standalone <track> cannot be given an empty placeholder: it may never refetch that URL.
function waitForSubtitle({ response, state, finish, timeoutMs = 30000, pollMs = 100 }) {
  let timer = null, done = false;
  const deadline = Date.now() + timeoutMs;
  function cancel() {
    if (done) return;
    done = true; clearTimeout(timer); response.removeListener('close', cancel);
  }
  function tick() {
    if (done) return;
    if (response.destroyed || response.writableEnded) return cancel();
    const status = state();
    if (status !== 'pending' || Date.now() >= deadline) {
      cancel(); finish(status === 'pending' ? 'timeout' : status); return;
    }
    timer = setTimeout(tick, pollMs);
  }
  response.once('close', cancel); tick();
  return cancel;
}
module.exports = { waitForSubtitle };
