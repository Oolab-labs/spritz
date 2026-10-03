(function (root) {
  'use strict';

  /* What the cast menu shows for each TV, and what to tell the person when a route does not connect.
   * Pure (no DOM): the renderer sets every string with textContent, and the logic is unit-tested.
   *
   * The same television often appears twice — as a DLNA renderer and as a Google Cast device. The two do
   * different things (DLNA sends the original file untouched; Cast has the Mac convert it), so each row
   * says which it is. A Cast route that failed to connect recently is marked and listed last: offering it
   * first, silently, was how someone ended up staring at a spinner for 45 seconds. */

  // The row wording lives in route-hints.js, shared with the track menus, so the two cannot disagree.
  var H = (typeof module !== 'undefined' && module.exports) ? require('./route-hints') : root.SpritzRouteHints;

  var FAILURE_MEMORY_MS = 30 * 60 * 1000; // a TV that was asleep an hour ago should not stay blacklisted

  function describeRoutes(input) {
    var casts = (input && input.casts) || [], dlnas = (input && input.dlnas) || [];
    var failures = (input && input.failures) || {}, now = (input && input.now) || Date.now();
    var castHosts = {};
    casts.forEach(function (c) { if (c.host) castHosts[c.host] = true; });

    var dlnaRows = dlnas.map(function (d) {
      var host = '';
      try { host = new URL(d.location).hostname; } catch (e) {}
      var dual = !!(host && castHosts[host]);
      return { kind: 'dlna', name: d.name, ref: d.location, host: host, dual: dual, failed: false,
        detail: H.routeDetail('dlna', dual), tooltip: H.routeTooltip('dlna', dual) };
    });
    var castRows = casts.map(function (c) {
      var failedAt = failures[c.host];
      var failed = typeof failedAt === 'number' && now - failedAt < FAILURE_MEMORY_MS;
      return { kind: 'chromecast', name: c.name, ref: c.host, host: c.host, dual: false, failed: failed,
        detail: failed ? 'Google Cast · didn’t connect last time' : H.routeDetail('chromecast'), tooltip: H.routeTooltip('chromecast') };
    });

    // Best first: dual-capable DLNA, then working Cast, then single-protocol DLNA, then Cast that just failed.
    return dlnaRows.filter(function (r) { return r.dual; })
      .concat(castRows.filter(function (r) { return !r.failed; }))
      .concat(dlnaRows.filter(function (r) { return !r.dual; }))
      .concat(castRows.filter(function (r) { return r.failed; }));
  }

  function isConnectFailure(message) {
    return /connect(ion)?\s+time(d)?\s*out/i.test(String(message == null ? '' : message));
  }

  /* The toast for a Cast error. A connect failure gets a next step; everything else is passed through. */
  function failureNote(message, ctx) {
    var name = (ctx && ctx.name) || 'The TV';
    if (!isConnectFailure(message)) return 'Cast: ' + message;
    if (ctx && ctx.hasDlna) {
      return name + ' didn’t answer on Google Cast. Try the “' + name + '” DLNA entry instead: it plays the original file.';
    }
    return name + ' didn’t answer on Google Cast. Check it is turned on and awake, then try again.';
  }

  var api = { describeRoutes: describeRoutes, isConnectFailure: isConnectFailure, failureNote: failureNote, FAILURE_MEMORY_MS: FAILURE_MEMORY_MS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SpritzCastRoutes = api;
})(typeof window !== 'undefined' ? window : this);
