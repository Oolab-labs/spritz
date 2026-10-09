'use strict';
// One bounded summary per route. Ordinary closed ports in a subnet are not permission failures.
function createDiscoveryHealth(route, emit, timers = { setTimeout, clearTimeout }) {
  let state = { route, attempt: 0, phase: 'idle', found: 0, replies: 0, nonRenderers: 0, cachedFailures: 0, errors: {} }, timer;
  const snapshot = () => ({ ...state, errors: { ...state.errors } });
  const publish = () => emit(snapshot());
  const stop = () => { timers.clearTimeout(timer); timer = null; };
  const finish = () => {
    stop(); state.phase = state.found ? 'ready' : state.errors.EACCES || state.errors.EPERM ? 'error' : 'empty'; publish();
  };
  return {
    snapshot, stop,
    start() { stop(); state = { route, attempt: state.attempt + 1, phase: 'searching', found: 0, replies: 0, nonRenderers: 0, cachedFailures: 0, errors: {} }; publish(); timer = timers.setTimeout(finish, 20000); },
    found(count) { state.found = count; if (count) state.phase = 'ready'; publish(); },
    reply(nonRenderer = false) { state.replies++; if (nonRenderer) state.nonRenderers++; },
    error(error, cached = false) { const code = String(error && error.code || 'FAILED').slice(0, 32); if (Object.keys(state.errors).length < 16 || state.errors[code]) state.errors[code] = (state.errors[code] || 0) + 1; if (cached) state.cachedFailures++; if (code === 'EACCES' || code === 'EPERM') { state.phase = 'error'; publish(); } }
  };
}
module.exports = { createDiscoveryHealth };
