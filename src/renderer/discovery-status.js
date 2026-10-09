(function (root) {
  'use strict';
  function describe(state, route) {
    var name = route === 'cast' ? 'Google Cast' : 'DLNA';
    if (!state || state.phase === 'idle') return name + ': waiting to search';
    if (state.found) return name + ': ' + state.found + (state.found === 1 ? ' TV found' : ' TVs found');
    if (state.phase === 'searching') return name + ': searching…';
    if (state.errors && (state.errors.EACCES || state.errors.EPERM)) return name + ': network access refused. Check Spritz’s Local Network permission, then retry.';
    if (route === 'dlna' && state.nonRenderers) return name + ': devices replied, but none offered video playback.';
    if (route === 'dlna' && state.cachedFailures) return name + ': saved TV addresses did not respond. Wake the TV and retry.';
    return name + ': no TVs replied. Check the TV is awake and on the same network, then retry.';
  }
  var api = { describe: describe };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SpritzDiscoveryStatus = api;
})(typeof window !== 'undefined' ? window : this);
