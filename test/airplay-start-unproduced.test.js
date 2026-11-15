'use strict';
/* An AirPlay handoff to a position the HLS remux has not produced yet.
 * Reproduced on the LG 55NANO80T6A, 2026-11-14/15, on origin/main and on the audit build alike: a local
 * MKV was seeked to 10:00 and then AirPlayed. The AirPlay remux starts from 0:00 when the file loads and
 * runs at ~9x real time, so the open EVENT playlist only reached ~302s (and ~476s on the second run).
 * The handoff seeked the TV to ~631s; AVPlayer clamped to the end of the playlist, the two "seeking
 * again" retries asked for the same unproduced position, and the TV played on from 302s / 476s:
 *   [airplay] TV at 41.7s, expected ~649.7s: seeking again
 *   [airplay] time 647.2s ... time 476.0s ...
 *   [airplay] TV at 476.0s, expected ~652.2s: seeking again   (then it stays at 476s)
 * The real handOffToAirplay is run here, unchanged, against a fake player that clamps exactly that way. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), vm = require('vm');
const SRC = path.join(__dirname, '../src/main');
const src = fs.readFileSync(path.join(SRC, 'main.js'), 'utf8');
const begin = src.indexOf('  function handOffToAirplay(why) {');
const end = src.indexOf('  // The second file of a session never played');
const handoff = src.slice(begin, end);

// A remux that started at virtual time 0 and produces `rate` media-seconds per second, in 2s segments.
function harness({ macPos, rate = 9, ended = false }) {
  let now = 0, next = 0; const timers = new Map(); const sent = [];
  const produced = () => Math.floor((now / 1000) * rate / 2) * 2;
  const playlist = () => '#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:2\n#EXT-X-PLAYLIST-TYPE:' + (ended ? 'VOD' : 'EVENT') + '\n' +
    '#EXT-X-MAP:URI="init.mp4"\n' + Array.from({ length: produced() / 2 }, (_, i) => `#EXTINF:2.000,\nseg${i}.m4s`).join('\n') + '\n' +
    (ended ? '#EXT-X-ENDLIST\n' : '');
  // AVPlayer on an open EVENT playlist: a seek past the produced end lands at the end; playback
  // never passes the end either.
  const tv = { cur: 0, playing: false, plays: [], seeks: [],
    edge() { return ended ? Infinity : Math.max(0, produced() - 2); },
    seek(t) { this.seeks.push(t); this.cur = Math.min(t, this.edge()); },
    play() { this.playing = true; this.plays.push(this.cur); },
    pause() { this.playing = false; },
    stat() { return { cur: this.cur }; } };
  const c = vm.createContext({
    castEngine: 'mpv', apStartWait: null, lastAvTime: 0,
    console: { log() {}, error() {} },
    Date: { now: () => now },
    setTimeout(fn, delay) { const id = ++next; timers.set(id, { at: now + (delay || 0), fn }); return id; },
    clearTimeout(id) { timers.delete(id); },
    require: (m) => require(path.join(SRC, m)),
    setEngine(e) { c.castEngine = e; if (e !== 'airplay') c.apStartWait = null; },
    mpvPos: () => macPos, captureTracks() {}, mpvAddon: { command() {} },
    apAddon: tv, send(ch, ev) { sent.push(ev); },
    lan: { airplayMediaPlaylist: playlist, noteAirplayPosition() {} },
  });
  vm.runInContext(handoff, c);
  const advance = (ms) => {
    for (let t = 0; t < ms; t += 100) {
      now += 100;
      if (tv.playing) tv.cur = Math.min(tv.cur + 0.1, tv.edge());
      for (const [id, x] of [...timers].sort((a, b) => a[1].at - b[1].at)) if (x.at <= now) { timers.delete(id); x.fn(); }
    }
  };
  return { c, tv, sent, advance, setNow: (ms) => { now = ms; } };
}

test('a handoff past the produced end waits, then starts the TV at the Mac position', () => {
  const h = harness({ macPos: 631 });
  h.setNow(33600);                           // ~302s produced, as measured
  h.c.handOffToAirplay('route engaged');
  h.advance(90000);
  assert.ok(h.tv.plays.length >= 1, 'the TV must eventually be started');
  const start = h.tv.plays[h.tv.plays.length - 1];
  assert.ok(start >= 627 && start <= 632, `TV started at ${start}s, the Mac was at 631s`);
  assert.ok(h.tv.cur > 631, `TV is playing on from the Mac position (now ${h.tv.cur.toFixed(1)}s)`);
  assert.equal(h.c.apStartWait, null, 'the wait is over');
});

test('while waiting the TV is held, not played from the produced end, and the renderer is told', () => {
  const h = harness({ macPos: 631 });
  h.setNow(33600);
  h.c.handOffToAirplay('route engaged');
  h.advance(5000);
  assert.equal(h.tv.playing, false, 'the TV must not play from the end of what is produced');
  assert.equal(h.tv.plays.length, 0);
  assert.ok(h.sent.some((e) => e.type === 'preparing' && e.active === true), 'renderer told the TV is getting ready');
  assert.equal(h.c.lastAvTime, 631, 'a Stop during the wait resumes the Mac where it was');
  h.advance(90000);
  assert.ok(h.sent.some((e) => e.type === 'preparing' && e.active === false), 'renderer told the wait is over');
});

test('a handoff inside the produced range starts at once, as before', () => {
  const h = harness({ macPos: 120 });
  h.setNow(60000);                           // 540s produced
  h.c.handOffToAirplay('route engaged');
  assert.deepEqual(h.tv.plays, [120]);
  assert.equal(h.c.apStartWait, null);
  assert.ok(!h.sent.some((e) => e.type === 'preparing'), 'no "getting ready" flash for a ready start');
});

test('a finished (VOD) playlist never waits', () => {
  const h = harness({ macPos: 3000, ended: true });
  h.setNow(1000);
  h.c.handOffToAirplay('route engaged');
  assert.deepEqual(h.tv.plays, [3000]);
});

test('Stop during the wait cancels it: nothing seeks or plays the TV afterwards', () => {
  const h = harness({ macPos: 631 });
  h.setNow(33600);
  h.c.handOffToAirplay('route engaged');
  h.advance(3000);
  h.c.setEngine('mpv');                       // resumeLocalFromAirplay / airplay:stop
  const seeks = h.tv.seeks.length;
  h.advance(120000);
  assert.equal(h.tv.plays.length, 0);
  assert.equal(h.tv.seeks.length, seeks);
});

test('a remux too slow to catch up starts the TV at the furthest produced point after the cap, and says so', () => {
  const h = harness({ macPos: 3000, rate: 1 });
  h.setNow(100000);                           // 100s produced, gaining 1s/s: 3000s is ~48 min away
  h.c.handOffToAirplay('route engaged');
  h.advance(179000);
  assert.equal(h.tv.plays.length, 0, 'still waiting before the cap');
  h.advance(3000);
  assert.equal(h.tv.plays.length, 1, 'started once the cap is reached');
  assert.ok(h.tv.plays[0] > 200 && h.tv.plays[0] < 300, `started near the produced end (${h.tv.plays[0]}s)`);
  const done = h.sent.find((e) => e.type === 'preparing' && e.active === false);
  assert.ok(done && /wasn.t ready/i.test(done.message || ''), 'the viewer is told why it started early');
});

test('coverage: no playlist and a finished playlist never wait; an open one must reach pos + lookahead', () => {
  const { startIsProduced, producedEnd, LOOKAHEAD } = require('../src/main/airplay-start-snap');
  const open = '#EXTM3U\n#EXT-X-PLAYLIST-TYPE:EVENT\n' + Array.from({ length: 50 }, (_, i) => `#EXTINF:2.000,\nseg${i}.m4s`).join('\n') + '\n';
  assert.equal(producedEnd(open), 100);
  assert.equal(startIsProduced(500, null), true);
  assert.equal(startIsProduced(500, open + '#EXT-X-ENDLIST\n'), true);
  assert.equal(startIsProduced(100 - LOOKAHEAD, open), true);
  assert.equal(startIsProduced(100 - LOOKAHEAD + 0.1, open), false);
});

test('while held, AVPlayer time ticks neither move the resume point nor reach the renderer', () => {
  const timerCode = src.slice(src.indexOf('  let dropTimer = null;'), src.indexOf('  // ---- "open with Spritz"'));
  const ls = src.indexOf('        apAddon.setEventListener((ev) => {');
  const listener = src.slice(ls, src.indexOf('        // Start route detection', ls));
  let cb; const sent = [];
  const c = vm.createContext({ castEngine: 'airplay', apExternalActive: true, apTimeSeen: 0, apLastLoggedTime: 0,
    lastAvTime: 631, avItemFailed: false, castUrl: 'http://fixture/master.m3u8', apStartWait: { at: 631, play: true },
    console: { log() {}, error() {} }, setTimeout() { return 0; }, clearTimeout() {},
    resumeLocalFromAirplay() {}, send(_ch, ev) { sent.push(ev); }, lan: { noteAirplayPosition() {} },
    apAddon: { setEventListener(fn) { cb = fn; }, stopAirplay() {}, prepare() {}, seek() {}, play() {} },
    mpvPos: () => 0, handOffToAirplay() {} });
  vm.runInContext(timerCode + listener, c);
  cb({ type: 'time', cur: 41.7, dur: 5981 });
  assert.equal(c.lastAvTime, 631);
  assert.equal(sent.length, 0);
  c.apStartWait = null;
  cb({ type: 'time', cur: 632, dur: 5981 });
  assert.equal(c.lastAvTime, 632, 'normal ticks still count once the TV has started');
  assert.equal(sent.length, 1);
});

test('play, pause and seek during the wait change what the TV does when it starts', () => {
  const lines = src.split('\n');
  const from = lines.findIndex((l) => l.startsWith("  ipcMain.on('airplay:play'"));
  const to = lines.findIndex((l, i) => i > from && l.startsWith("  ipcMain.on('airplay:setVolume'"));
  const handlers = {}; const calls = [];
  const c = vm.createContext({ apStartWait: { at: 631, play: true }, lastAvTime: 631,
    ipcMain: { on(ch, fn) { handlers[ch] = fn; } }, lan: { noteAirplayPosition() {} },
    apAddon: { play() { calls.push('play'); }, pause() { calls.push('pause'); }, seek(t) { calls.push('seek ' + t); } } });
  vm.runInContext(lines.slice(from, to).join('\n'), c);
  handlers['airplay:pause']();
  assert.equal(c.apStartWait.play, false);
  handlers['airplay:seek'](null, { t: 900 });
  assert.equal(c.apStartWait.at, 900); assert.equal(c.lastAvTime, 900);
  handlers['airplay:play']();
  assert.equal(c.apStartWait.play, true);
  assert.deepEqual(calls, [], 'the TV is not driven while held');
  c.apStartWait = null;
  handlers['airplay:seek'](null, { t: 950 }); handlers['airplay:pause']();
  assert.deepEqual(calls, ['seek 950', 'pause'], 'normal control once started');
});

test('the held start is paused from the TV, and plays only if the viewer did not pause it', () => {
  const h = harness({ macPos: 631 });
  h.setNow(33600);
  h.c.handOffToAirplay('route engaged');
  h.c.apStartWait.play = false;               // viewer pressed pause while waiting
  h.advance(90000);
  assert.equal(h.tv.plays.length, 0, 'not played');
  assert.ok(h.tv.cur >= 627 && h.tv.cur <= 632, `but parked at the Mac position (${h.tv.cur}s)`);
});
