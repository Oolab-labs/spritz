'use strict';
// How many times may a cast be put back before we conclude it is hopeless?
//
// The shipped answer was "three, ever" — a lifetime budget per cast, reset only when a NEW cast
// started. Measured on a 63-minute episode: the receiver dropped the connection five times, every
// recovery WORKED (the playhead advanced 104s → 117s → 217s → 248s → 288s), and the session was
// nonetheless declared unrecoverable four minutes in because the counter had run out. Three drops
// spread across an hour of successful viewing killed the film exactly as surely as three drops in
// ten seconds.
//
// The thing the budget is actually there to prevent is a LOOP — a source that cannot be streamed
// retrying forever. A loop is dense in time; intermittent drops across a long film are not. So the
// budget is a rate limit over a sliding window rather than a lifetime count: survive the window and
// the attempts are forgiven, because surviving IS the evidence that recovery worked.
//
// Pure so the arithmetic can be tested without a TV.

const MAX_IN_WINDOW = 3;
const WINDOW_MS = 60000; // survive this long since the last attempt and the budget refills

// state: { used, lastAt } — `used` attempts so far, `lastAt` epoch ms of the most recent one (0 = none).
// Returns { allow, state, reason }. Never mutates the input.
function allowRecovery(state, now, opts) {
  const max = (opts && opts.max) || MAX_IN_WINDOW;
  const windowMs = (opts && opts.windowMs) || WINDOW_MS;
  const used = (state && state.used) || 0;
  const lastAt = (state && state.lastAt) || 0;

  // Quiet for a whole window → the last recovery held, so start counting again.
  const refilled = lastAt > 0 && (now - lastAt) >= windowMs;
  const spent = refilled ? 0 : used;

  if (spent >= max) {
    return {
      allow: false,
      state: { used: spent, lastAt },
      reason: 'already retried ' + spent + ' times in the last ' + Math.round(windowMs / 1000) + 's',
    };
  }
  return {
    allow: true,
    state: { used: spent + 1, lastAt: now },
    reason: 'attempt ' + (spent + 1) + (refilled ? ' (budget refilled after a good run)' : ''),
  };
}

// A recovery that turned out to be unnecessary — the receiver re-requested the stream itself — is
// refunded, so self-healing never counts against a source.
function refund(state) {
  const used = (state && state.used) || 0;
  return { used: Math.max(0, used - 1), lastAt: (state && state.lastAt) || 0 };
}

const fresh = () => ({ used: 0, lastAt: 0 });

module.exports = { allowRecovery, refund, fresh, MAX_IN_WINDOW, WINDOW_MS };
