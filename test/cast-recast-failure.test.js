'use strict';

// What a failed re-cast does. A seek on the live pipe re-casts the film (recastMkv). Measured on the LG
// with rc.17's candidate: that LOAD failed, recastMkv only told the window, and the window went back to
// playing on the Mac from where the cast had started (603 s, not the 897 s the TV was at) while this
// process still believed it was casting — the next seek re-cast to the TV from a window that said Mac.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8');
const start = source.indexOf('  function recastMkv(');
const code = source.slice(start, source.indexOf('  // Re-establish a cast whose stream died', start));

function run(err) {
  const calls = { resumed: 0, sent: [], guardEnds: 0 };
  const ctx = {
    castMkv: { host: 'tv', input: '/film.mkv', audioTrack: 0, caps: {} }, castEngine: 'chromecast', loadGen: 1,
    externalSubs: [], lastCastTitle: 'Film', lastIdleReason: null,
    subGuard: { begin() {}, end() { calls.guardEnds++; } },
    lan: { serveMkv: (_i, _o, cb) => cb('http://mac/mkv/b', [], [], 0, 5981, []), castMime: () => 'video/mp4' },
    cast: { connectedHost: () => 'tv', load: (_h, _m, cb) => cb(err) },
    send: (_ch, ev) => calls.sent.push(ev.type),
    resumeLocalFromChromecast: () => { calls.resumed++; ctx.castEngine = 'mpv'; ctx.castMkv = null; }
  };
  vm.createContext(ctx); vm.runInContext(code, ctx);
  ctx.recastMkv(900, 0);
  return calls;
}

test('a re-cast whose LOAD fails hands playback back to the Mac', () => {
  const c = run(new Error('load timeout'));
  assert.equal(c.resumed, 1, 'the cast ends here, at the TV position, not only in the window');
  assert.deepEqual(c.sent, ['error']);
  assert.equal(c.guardEnds, 1);
});

test('a re-cast that is reconnecting is left to the reconnect', () => {
  const e = new Error('the TV closed the Cast connection; reconnecting'); e.reconnecting = true;
  const c = run(e);
  assert.equal(c.resumed, 0);
  assert.deepEqual(c.sent, []);
  assert.equal(c.guardEnds, 1, 'the subtitle guard is not left open');
});
