(function (root) {
  'use strict';

  /* Pure helpers for the screens a person sees BEFORE a film is playing: typing the Mac's address,
   * the pairing-code countdown, and the receiver/app version check. No DOM, no network — so the
   * rules are unit-testable in node and the page only wires them to buttons. ES5 on purpose: this
   * runs on whatever web engine the television ships. */

  /* The Mac's address, typed with a remote. Forgiving about whitespace and one trailing dot (both
   * easy to produce on an on-screen keyboard); strict about everything else, and PRIVATE ranges
   * only: the TV will go and probe whatever it is given, and a mistyped public address should be
   * an error the person can read, not a silent request to the internet. */
  function parseHost(text) {
    var s = String(text == null ? '' : text).replace(/^\s+|\s+$/g, '');
    if (s.charAt(s.length - 1) === '.') s = s.slice(0, -1);
    if (!s) return { error: 'Enter your Mac’s address, like 192.168.1.20' };
    var m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
    if (!m) return { error: 'That is not an address. Use four numbers, like 192.168.1.20' };
    var p = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
    for (var i = 0; i < 4; i++) if (p[i] > 255) return { error: 'Each number must be 0–255' };
    var priv = p[0] === 10 || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168);
    if (!priv) return { error: 'That is not a home-network address (it should start 192.168, 10. or 172.16–31)' };
    return { host: p.join('.') };
  }

  /* The Mac expires a pairing code after five minutes. `expiresAt` is the Mac's wall-clock; the two
   * clocks can disagree by seconds, which only moves the refresh a little earlier or later. */
  function secondsLeft(expiresAt, now) {
    var left = Math.ceil((Number(expiresAt) - Number(now)) / 1000);
    return isFinite(left) && left > 0 ? left : 0;
  }
  function refreshDue(expiresAt, now) {
    return Number(expiresAt) > 0 && Number(now) >= Number(expiresAt);
  }
  function formatCountdown(sec) {
    var s = Math.max(0, Math.floor(sec));
    var r = s % 60;
    return Math.floor(s / 60) + ':' + (r < 10 ? '0' : '') + r;
  }
  /* A Mac that answered with an already-expired code would otherwise be asked again every tick. */
  var CODE_REQUEST_MIN_MS = 5000;
  function canRequestCode(lastRequestAt, now) {
    return Number(now) - Number(lastRequestAt) >= CODE_REQUEST_MIN_MS;
  }

  var api = { parseHost: parseHost, secondsLeft: secondsLeft, refreshDue: refreshDue,
    formatCountdown: formatCountdown, canRequestCode: canRequestCode };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SpritzHomeFlow = api;
})(typeof window !== 'undefined' ? window : this);
