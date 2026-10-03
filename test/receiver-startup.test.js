'use strict';

const { test } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const SpritzStartSeek = require('../webos-receiver/start-seek');

const INDEX = path.join(__dirname, '..', 'webos-receiver', 'index.html');
const NO_PTS = -9223372030.8;

test('paused EVENT startup initializes no-PTS clock, confirms arrival and rechecks first resume', () => {
  const { context, video, tick } = receiverHarness();
  let plays = 0; video.play = () => { plays++; video.paused = false; return Promise.resolve(); };
  context.load({ mediaId: 'paused', url: 'http://media/growing.m3u8', startSec: 50, autoplay: false });
  video.observe(NO_PTS); video.readyState = 4; video.delaySeeks();
  video.dispatch('loadeddata'); assert.deepEqual(video.writes, [50]);
  tick(); tick(); assert.equal(context.startAttempts, 1);
  video.completeSeek(50); assert.equal(context.startWanted, null);
  assert.equal(video.paused, true); assert.equal(plays, 0);
  context.requestPlayback(true); assert.equal(context.startWanted, 50);
  video.observe(80); video.seeking = false; video.dispatch('playing');
  assert.equal(video.writes.at(-1), 50); assert.equal(plays, 1);
});
test('paused startup requires loaded data and a valid target range and bounds initialization attempts', () => {
  const { context, video, tick } = receiverHarness();
  context.load({ mediaId: 'paused', url: 'http://media/growing.m3u8', startSec: 50, autoplay: false });
  video.observe(NO_PTS); tick(); assert.deepEqual(video.writes, []);
  video.readyState = 4; video.seekable = { length: 1, start: () => -1, end: () => 60 };
  tick(); assert.deepEqual(video.writes, []);
  video.seekable.start = () => 0; video.completeWritesImmediately = false;
  tick(); video.seeking = false; tick(); video.seeking = false; tick();
  assert.deepEqual(video.writes, [50, 50]); assert.equal(video.paused, true);
  context.stop(); tick(); assert.equal(video.writes.length, 2); assert.equal(context.startResumeCheck, null);
});
test('replacement load discards a paused first-resume correction from the previous source', () => {
  const { context, video } = receiverHarness();
  context.load({ mediaId: 'old', url: 'http://media/old', startSec: 50, autoplay: false });
  video.readyState = 4; video.observe(50); video.dispatch('loadeddata');
  assert.equal(context.startResumeCheck, 50);
  context.load({ mediaId: 'new', url: 'http://media/new', startSec: 10, autoplay: false });
  assert.equal(context.startResumeCheck, null); assert.equal(context.startWanted, 10);
});

class FakeElement {
  constructor() {
    this.className = '';
    this.style = {};
    this.textContent = '';
    this.listeners = new Map();
    this.classList = { add() {}, remove() {} };
  }

  addEventListener(type, fn) {
    const list = this.listeners.get(type) || [];
    list.push(fn);
    this.listeners.set(type, list);
  }

  removeEventListener(type, fn) {
    this.listeners.set(type, (this.listeners.get(type) || []).filter((x) => x !== fn));
  }

  dispatch(type) {
    for (const fn of this.listeners.get(type) || []) fn({ type });
  }
}

class FakeVideo extends FakeElement {
  constructor() {
    super();
    this._currentTime = 0;
    this.writes = [];
    this.completeWritesImmediately = true;
    this.readBackRequestedTimeWhileSeeking = false;
    this.duration = NaN;
    this.paused = true;
    this.ended = false;
    this.seeking = false;
    this.readyState = 0;
    this.error = null;
    this.seekable = { length: 1, start() { return 0; }, end() { return 10000; } };
    this.buffered = { length: 0, start() { return 0; }, end() { return 0; } };
  }

  get currentTime() { return this._currentTime; }
  set currentTime(value) {
    this.writes.push(value);
    if (this.completeWritesImmediately) this._currentTime = value;
    else {
      this.seeking = true;
      if (this.readBackRequestedTimeWhileSeeking) this._currentTime = value;
    }
  }
  observe(value) { this._currentTime = value; }
  delaySeeks({ readBackRequestedTime = false } = {}) {
    this.completeWritesImmediately = false;
    this.readBackRequestedTimeWhileSeeking = readBackRequestedTime;
  }
  completeSeek(value) {
    this._currentTime = value;
    this.seeking = false;
    this.dispatch('seeked');
  }
  play() { this.paused = false; return Promise.resolve(); }
  pause() { this.paused = true; }
  querySelectorAll() { return []; }
  appendChild() {}
  load() {}
  canPlayType() { return 'probably'; }
}

function receiverHarness() {
  const html = fs.readFileSync(INDEX, 'utf8');
  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)];
  const source = scripts.at(-1)[1].replace(/\nconnect\(\);\s*$/, '\n');
  const video = new FakeVideo();
  const elements = new Map([['v', video]]);
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, new FakeElement());
    return elements.get(id);
  };
  const intervals = [];
  const logs = [];
  const storage = new Map();
  const windowListeners = new Map();
  const documentListeners = new Map();
  const context = {
    console: { log(...args) { logs.push(args.join(' ')); } },
    Date,
    JSON,
    Math,
    Object,
    Promise,
    SpritzStartSeek,
    screen: { width: 1920, height: 1080 },
    history: { pushState() {} },
    localStorage: {
      getItem(key) { return storage.get(key) || null; },
      setItem(key, value) { storage.set(key, String(value)); },
      removeItem(key) { storage.delete(key); }
    },
    document: {
      getElementById: element,
      addEventListener(type, fn) { documentListeners.set(type, fn); }
    },
    setInterval(fn) { intervals.push(fn); return intervals.length; },
    clearInterval() {},
    setTimeout() { return 1; },
    clearTimeout() {},
    isFinite,
    URL,
    XMLHttpRequest: function () {}
  };
  context.window = context;
  context.window.addEventListener = (type, fn) => windowListeners.set(type, fn);
  context.window.SpritzHmac = {};
  vm.createContext(context);
  vm.runInContext(source, context, { filename: INDEX });
  return { context, video, tick: intervals[0], logs, key: code => documentListeners.get('keydown')({ keyCode: code, preventDefault() {} }) };
}

test('receiver defers an unusable first clock and corrects on a later recurring check', () => {
  const { context, video, tick } = receiverHarness();

  // Epoch B maps logical 300 to native 2 because its first represented source position is 298.
  context.load({ mediaId: 'film-1', epoch: 'epoch-2', url: 'http://media/epoch-2/media.m3u8', startSec: 2 });
  video.observe(2);
  video.dispatch('seeked');
  assert.equal(context.startWanted, 2, 'a pre-play seek completion can still be overridden by the EVENT live edge');

  video.observe(NO_PTS);
  video.paused = false;
  video.writes.length = 0;
  video.dispatch('playing');

  assert.equal(context.startWanted, 2, 'the requested native offset remains pending');
  assert.equal(context.startAttempts, 0, 'an unusable sample consumes no correction attempt');
  assert.deepEqual(video.writes, [], 'the no-PTS sample does not cause a blind seek');

  for (const unusable of [NO_PTS, -1, NaN]) {
    video.observe(unusable);
    tick();
  }
  assert.equal(context.startWanted, 2, 'several unusable timer samples keep the target pending');
  assert.equal(context.startAttempts, 0, 'unusable timer samples consume no attempts');

  video.observe(900);
  tick();
  assert.deepEqual(video.writes, [2], 'the recurring position check requests the mapped native offset');
  assert.equal(context.startAttempts, 1);

  video.observe(2);
  tick();
  assert.equal(context.startWanted, null, 'valid evidence at the target settles startup');

  video.writes.length = 0;
  video.observe(20);
  tick();
  video.dispatch('pause');
  video.dispatch('playing');
  assert.deepEqual(video.writes, [], 'ordinary playback is not pulled back after startup settles');
});

test('receiver treats a genuine zero start as pending and settles on a valid zero clock', () => {
  const { context, video } = receiverHarness();
  context.load({ mediaId: 'film-1', epoch: 'epoch-1', url: 'http://media/epoch-1/media.m3u8', startSec: 0 });
  video.observe(0);
  video.paused = false;
  video.writes.length = 0;
  video.dispatch('playing');

  assert.equal(context.startWanted, null);
  assert.equal(context.startAttempts, 0);
  assert.deepEqual(video.writes, []);
});

test('receiver does not correct playback that is initially within tolerance', () => {
  const { context, video } = receiverHarness();
  context.load({ mediaId: 'film-1', epoch: 'epoch-2', url: 'http://media/epoch-2/media.m3u8', startSec: 2 });
  video.observe(3.5);
  video.paused = false;
  video.writes.length = 0;
  video.dispatch('playing');

  assert.equal(context.startWanted, null);
  assert.equal(context.startAttempts, 0);
  assert.deepEqual(video.writes, []);
});

test('receiver exhausts bounded correction attempts when the player ignores both writes', () => {
  const { context, video, tick, logs } = receiverHarness();
  context.load({ mediaId: 'film-1', epoch: 'epoch-2', url: 'http://media/epoch-2/media.m3u8', startSec: 2 });
  video.paused = false;
  video.writes.length = 0;

  video.observe(900);
  video.dispatch('playing');
  video.observe(900);
  tick();
  video.observe(900);
  tick();

  assert.deepEqual(video.writes, [2, 2]);
  assert.equal(context.startAttempts, 2);
  assert.equal(context.startWanted, null);
  assert.ok(logs.some((line) => /"action":"exhausted"/.test(line)));

  tick();
  assert.deepEqual(video.writes, [2, 2], 'exhaustion does not become an unbounded seek loop');
});

test('a slow first correction remains pending across timer ticks and settles with one write', () => {
  const { context, video, tick, logs } = receiverHarness();
  context.load({ mediaId: 'film-1', epoch: 'epoch-2', url: 'http://media/epoch-2/media.m3u8', startSec: 2 });
  video.delaySeeks();
  video.paused = false;
  video.observe(NO_PTS);
  video.dispatch('playing');

  video.observe(900);
  tick();
  assert.deepEqual(video.writes, [2]);
  assert.equal(context.startAttempts, 1);
  assert.equal(context.startWanted, 2);

  for (let i = 0; i < 4; i++) tick();
  assert.deepEqual(video.writes, [2], 'polling cannot restart an in-flight correction');
  assert.equal(context.startAttempts, 1);
  assert.equal(context.startWanted, 2);
  assert.equal(logs.some((line) => /"action":"exhausted"/.test(line)), false);

  video.completeSeek(2);
  assert.equal(context.startWanted, null);
  tick();
  assert.deepEqual(video.writes, [2], 'settled startup stays settled');
});

test('requested target readback does not settle while the correction is still seeking', () => {
  const { context, video, tick } = receiverHarness();
  context.load({ mediaId: 'film-1', epoch: 'epoch-2', url: 'http://media/epoch-2/media.m3u8', startSec: 2 });
  video.delaySeeks({ readBackRequestedTime: true });
  video.paused = false;
  video.observe(900);
  video.dispatch('playing');

  assert.equal(video.currentTime, 2, 'the requested value is exposed before seek completion');
  assert.equal(video.seeking, true);
  tick();
  assert.equal(context.startWanted, 2, 'readback alone is not completed-position evidence');
  assert.equal(context.startAttempts, 1);
  assert.deepEqual(video.writes, [2]);

  video.completeSeek(2);
  assert.equal(context.startWanted, null);
});

test('a slow second correction can succeed after the first completed miss', () => {
  const { context, video, tick, logs } = receiverHarness();
  context.load({ mediaId: 'film-1', epoch: 'epoch-2', url: 'http://media/epoch-2/media.m3u8', startSec: 2 });
  video.delaySeeks();
  video.paused = false;
  video.observe(900);
  video.dispatch('playing');

  for (let i = 0; i < 3; i++) tick();
  assert.deepEqual(video.writes, [2]);
  video.completeSeek(900);
  assert.deepEqual(video.writes, [2, 2], 'a completed miss permits the second correction');
  assert.equal(context.startAttempts, 2);

  for (let i = 0; i < 3; i++) tick();
  assert.deepEqual(video.writes, [2, 2]);
  assert.equal(context.startWanted, 2, 'the final attempt remains pending while it runs');
  assert.equal(logs.some((line) => /"action":"exhausted"/.test(line)), false);

  video.completeSeek(2);
  assert.equal(context.startWanted, null, 'a valid final arrival settles before exhaustion');
  assert.equal(logs.some((line) => /"action":"settled"/.test(line)), true);
  assert.equal(logs.some((line) => /"action":"exhausted"/.test(line)), false);
});

test('two completed correction misses exhaust without a third write', () => {
  const { context, video, logs } = receiverHarness();
  context.load({ mediaId: 'film-1', epoch: 'epoch-2', url: 'http://media/epoch-2/media.m3u8', startSec: 2 });
  video.delaySeeks();
  video.paused = false;
  video.observe(900);
  video.dispatch('playing');
  video.completeSeek(900);
  video.completeSeek(900);

  assert.deepEqual(video.writes, [2, 2]);
  assert.equal(context.startAttempts, 2);
  assert.equal(context.startWanted, null);
  assert.equal(logs.some((line) => /"action":"exhausted"/.test(line)), true);
});

test('an in-flight correction is cancelled by stop, error, or explicit seek', () => {
  for (const cancel of ['stop', 'error', 'seek']) {
    const { context, video, tick } = receiverHarness();
    context.load({ mediaId: 'film-1', epoch: 'epoch-2', url: 'http://media/epoch-2/media.m3u8', startSec: 2 });
    video.delaySeeks();
    video.paused = false;
    video.observe(900);
    video.dispatch('playing');
    assert.deepEqual(video.writes, [2]);

    if (cancel === 'stop') context.stop();
    else if (cancel === 'error') video.dispatch('error');
    else context.seekTo(40);
    assert.equal(context.startWanted, null, cancel + ' cancels pending startup');

    video.completeSeek(2);
    tick();
    assert.equal(context.startWanted, null, cancel + ' cannot be revived by old completion');
    assert.equal(video.writes.length, cancel === 'seek' ? 2 : 1);
  }
});

test('replacement load is independent of an old in-flight correction and completion event', () => {
  const { context, video, tick } = receiverHarness();
  context.load({ mediaId: 'film-1', epoch: 'epoch-1', url: 'http://media/a', startSec: 2 });
  video.delaySeeks();
  video.paused = false;
  video.observe(900);
  video.dispatch('playing');
  assert.deepEqual(video.writes, [2]);

  context.load({ mediaId: 'film-1', epoch: 'epoch-2', url: 'http://media/b', startSec: 7 });
  assert.equal(context.startWanted, 7);
  assert.equal(context.startAttempts, 0);
  video.completeSeek(2);
  assert.equal(context.startWanted, 7, 'the old completion event cannot settle the replacement');
  assert.equal(context.startAttempts, 0);

  video.observe(900);
  video.dispatch('playing');
  assert.deepEqual(video.writes, [2, 7]);
  video.completeSeek(7);
  assert.equal(context.startWanted, null);
  tick();
  assert.deepEqual(video.writes, [2, 7]);
});

test('stop, explicit seek, and replacement load supersede pending startup work', () => {
  {
    const { context, video, tick } = receiverHarness();
    context.load({ mediaId: 'film-1', epoch: 'epoch-1', url: 'http://media/a', startSec: 2 });
    context.stop();
    video.observe(900);
    video.paused = false;
    video.writes.length = 0;
    tick();
    assert.equal(context.startWanted, null);
    assert.deepEqual(video.writes, []);
  }

  {
    const { context, video, tick } = receiverHarness();
    context.load({ mediaId: 'film-1', epoch: 'epoch-1', url: 'http://media/a', startSec: 2 });
    video.writes.length = 0;
    context.seekTo(40);
    assert.equal(context.startWanted, null);
    assert.deepEqual(video.writes, [40]);
    video.observe(900);
    video.paused = false;
    tick();
    assert.deepEqual(video.writes, [40]);
  }

  {
    const { context, video } = receiverHarness();
    context.load({ mediaId: 'film-1', epoch: 'epoch-1', url: 'http://media/a', startSec: 2 });
    context.load({ mediaId: 'film-1', epoch: 'epoch-2', url: 'http://media/b', startSec: 7 });
    assert.equal(context.startWanted, 7);
    assert.equal(context.startAttempts, 0);
    video.observe(900);
    video.paused = false;
    video.writes.length = 0;
    video.dispatch('playing');
    assert.deepEqual(video.writes, [7], 'only the replacement epoch target can act');
  }
});


test('retired metadata callback cannot seek or play a newer load', () => {
  const { context, video } = receiverHarness();
  let plays = 0; video.play = () => { plays++; return Promise.resolve(); };
  context.load({ mediaId: 'A', url: 'http://media/a', startSec: 50 });
  const old = context.pendingMetadataLoad;
  context.load({ mediaId: 'B', url: 'http://media/b', startSec: 7 });
  video.writes.length = 0; old();
  assert.deepEqual(video.writes, []); assert.equal(plays, 0);
  video.dispatch('loadedmetadata');
  assert.deepEqual(video.writes, [7]); assert.equal(plays, 1);
  assert.equal(context.pendingMetadataLoad, null);
});

test('retired autoplay rejection cannot pause or report an error for newer media', async () => {
  for (const replacement of ['load', 'stop']) {
    const { context, video } = receiverHarness();
    let reject; const reports = [], errors = [];
    video.play = () => new Promise((_, fail) => { reject = fail; });
    context.report = state => reports.push(state);
    context.send = (type, fields) => { if (type === 'error') errors.push(fields); };
    context.load({ mediaId: 'A', url: 'http://media/a' }); video.dispatch('loadedmetadata');
    if (replacement === 'load') context.load({ mediaId: 'B', url: 'http://media/b' });
    else context.stop();
    reports.length = 0;
    reject(new Error('late autoplay failure')); await Promise.resolve();
    assert.deepEqual(reports, []); assert.deepEqual(errors, []);
    if (replacement === 'stop') assert.equal(context.pendingMetadataLoad, null);
  }
});


test('fatal media error retires pending metadata startup work immediately', () => {
  const { context, video } = receiverHarness();
  const errors = []; context.send = (type, fields) => { if (type === 'error') errors.push(fields); };
  let plays = 0; video.play = () => { plays++; return Promise.resolve(); };
  context.load({ mediaId: 'A', epoch: 'epoch-1', url: 'http://media/a', startSec: 50 });
  const retired = context.pendingMetadataLoad;
  assert.ok(retired);
  video.error = { code: 3, message: 'decode failed' }; video.dispatch('error');
  assert.equal(context.pendingMetadataLoad, null);
  assert.equal(context.startWanted, null); assert.equal(context.media.id, null);
  assert.equal(errors.length, 1); assert.equal(errors[0].mediaId, 'A'); assert.equal(errors[0].epoch, 'epoch-1');
  assert.ok(!(video.listeners.get('loadedmetadata') || []).includes(retired));
  video.writes.length = 0; retired();
  assert.deepEqual(video.writes, []); assert.equal(plays, 0);
});


test('explicit seek and pause before metadata supersede initial LOAD intent', () => {
  const { context, video } = receiverHarness();
  let plays = 0; video.play = () => { plays++; return Promise.resolve(); };
  context.load({ mediaId: 'A', url: 'http://media/a', startSec: 50, autoplay: true });
  context.onMessage({ type: 'pause' });
  context.seekTo(7); video.writes.length = 0;
  video.dispatch('loadedmetadata');
  assert.deepEqual(video.writes, [7]); assert.equal(plays, 0);
  assert.equal(context.startWanted, null);
});


test('remote pause and toggle preserve pending startup intent before metadata', () => {
  for (const name of ['PAUSE', 'PLAYPAUSE', 'OK']) {
    const { context, video, key } = receiverHarness();
    let plays = 0; video.play = () => { plays++; return Promise.resolve(); };
    context.load({ mediaId: 'A', url: 'http://media/a', autoplay: true });
    key(context.KEY[name]); video.dispatch('loadedmetadata');
    assert.equal(context.media.autoplay, false, name);
    assert.equal(plays, 0, name);
  }
});


test('remote relative seek before metadata follows pending intent despite unusable clock', () => {
  const { context, video, key } = receiverHarness();
  context.load({ mediaId: 'A', url: 'http://media/a', startSec: 50, autoplay: false });
  video.observe(NO_PTS);
  key(context.KEY.RIGHT); assert.equal(context.media.startSec, 80);
  video.observe(NO_PTS);
  key(context.KEY.LEFT); assert.equal(context.media.startSec, 50);
  video.writes.length = 0; video.dispatch('loadedmetadata');
  assert.deepEqual(video.writes, [50]);
  assert.equal(context.media.startSec, 50);
});

test('invalid explicit seek does not consume pending startup intent', () => {
  const { context, video } = receiverHarness();
  context.load({ mediaId: 'A', url: 'http://media/a', startSec: 50 });
  for (const value of [NaN, Infinity, -Infinity, '20']) context.seekTo(value);
  assert.equal(context.startWanted, 50); assert.equal(context.media.startSec, 50);
  assert.deepEqual(video.writes, []);
});


test('explicit seek to zero is reapplied when delayed metadata makes the clock writable', () => {
  const { context, video } = receiverHarness();
  context.load({ mediaId: 'A', url: 'http://media/a', startSec: 50, autoplay: false });
  context.seekTo(0);
  video.observe(40); video.writes.length = 0;
  video.dispatch('loadedmetadata');
  assert.deepEqual(video.writes, [0]); assert.equal(video.currentTime, 0);
  assert.equal(context.startWanted, null);
});

test('receiver preserves correction budget until LG exposes the requested seekable range', () => {
  const { context, video, tick } = receiverHarness();
  context.load({ mediaId: 'growing', url: 'http://media/growing.m3u8', startSec: 24.3 });
  video.paused = false; video.observe(0.6); video.writes.length = 0;
  video.seekable = { length: 1, start() { return -9223372036; }, end() { return -9223372034; } };
  video.dispatch('playing'); tick();
  assert.equal(context.startAttempts, 0);
  assert.deepEqual(video.writes, []);
  video.seekable = { length: 1, start() { return 0; }, end() { return 15.955; } };
  tick(); assert.equal(context.startAttempts, 0);
  video.seekable.end = () => 30;
  tick(); assert.deepEqual(video.writes, [24.3]);
  tick(); assert.equal(context.startWanted, null);
});

test('offset transport keeps film time on the wire and native time in the media element', () => {
  const { context, video } = receiverHarness();
  context.load({ mediaId: 'offset', url: 'http://media/offset.m3u8', timelineOrigin: 98.098, sourceDuration: 3122, startSec: 120, autoplay: false });
  video.observe(0); video.dispatch('loadedmetadata');
  assert.ok(Math.abs(video.currentTime - 21.902) < 0.001);
  assert.equal(context.media.startSec, 120);
  assert.equal(context.filmTime(21.902), 120);
  assert.equal(context.filmDuration(), 3122);
  context.seekTo(140);
  assert.ok(Math.abs(video.currentTime - 41.902) < 0.001);
  assert.equal(context.relativeSeekBase(), 140);
  context.seekTo(10);
  assert.ok(Math.abs(video.currentTime - 41.902) < 0.001, 'out-of-transport seek does not silently clamp');
  context.load({ mediaId: 'original', url: 'http://media/original.m3u8', startSec: 140 });
  assert.equal(context.filmTime(140), 140, 'replacement/rollback clears prior origin');
});

test('subtitle cues shift once and cues before the transport are discarded', () => {
  const { context } = receiverHarness();
  const cues = [{ startTime: 80, endTime: 90 }, { startTime: 95, endTime: 101 }, { startTime: 120, endTime: 125 }];
  const node = { track: { cues, removeCue(cue) { cues.splice(cues.indexOf(cue), 1); } } };
  context.shiftSubtitleCues(node, 98);
  assert.deepEqual(cues, [{ startTime: 0, endTime: 3 }, { startTime: 22, endTime: 27 }]);
  context.shiftSubtitleCues(node, 98);
  assert.equal(cues[1].startTime, 22);
});

test('ordinary negative relative seek still clamps to the beginning', () => {
  const { context, video } = receiverHarness();
  context.load({ mediaId: 'normal', url: 'http://media/normal.m3u8', startSec: 5 });
  context.seekTo(-25);
  assert.equal(video.currentTime, 0);
});

test('mapped forward seek beyond published range requests replacement without clamping', () => {
  const { context, video } = receiverHarness();
  context.load({ mediaId: 'mapped', url: 'http://media/x', timelineOrigin: 100, sourceDuration: 3000, startSec: 120 });
  video.observe(20);
  video.seekable = { length: 1, start() { return 0; }, end() { return 60; } };
  const messages = []; context.send = (type, body) => messages.push({ type, ...body });
  context.seekTo(600);
  assert.equal(video.currentTime, 20);
  assert.equal(messages[0].code, 'seek-outside-transport');
  assert.equal(messages[0].requestedTime, 600);
});

test('mapped seek past film end requests the bounded film destination', () => {
  const { context, video } = receiverHarness();
  context.load({ mediaId: 'mapped', url: 'http://media/x', timelineOrigin: 20, sourceDuration: 60, startSec: 30 });
  video.seekable = { length: 1, start() { return 0; }, end() { return 20; } };
  const sent = []; context.send = (_, data) => sent.push(data);
  context.seekTo(600);
  assert.equal(sent[0].requestedTime, 59);
});


test('subtitle conversion handles a live cue list that reorders on timestamp edits', () => {
  const { context } = receiverHarness();
  const cues = [];
  function add(start, end) {
    let value = start;
    const cue = { endTime: end };
    Object.defineProperty(cue, 'startTime', { enumerable: true, get() { return value; }, set(next) {
      value = next; cues.sort((a, b) => a.startTime - b.startTime);
    } });
    cues.push(cue); return cue;
  }
  add(80, 90); const crossing = add(95, 101); const first = add(120, 125); const second = add(130, 135);
  const node = { track: { cues, removeCue(cue) { cues.splice(cues.indexOf(cue), 1); } } };
  context.shiftSubtitleCues(node, 98);
  assert.deepEqual(cues.map(c => [c.startTime, c.endTime]), [[0, 3], [22, 27], [32, 37]]);
  assert.deepEqual(cues, [crossing, first, second]);
  context.shiftSubtitleCues(node, 98);
  assert.equal(second.startTime, 32);
});

test('zero-origin growing stream uses film duration and requests unavailable seek destination', () => {
  const { context, video } = receiverHarness();
  context.load({ mediaId: 'origin', url: 'http://media/x', timelineOrigin: 0, sourceDuration: 5785, startSec: 10 });
  video.duration = 71.737; video.observe(10);
  video.seekable = { length: 1, start() { return 0; }, end() { return 70.737; } };
  const sent = []; context.send = (_, body) => sent.push(body);
  context.seekTo(75);
  assert.equal(video.currentTime, 10);
  assert.equal(context.filmDuration(), 5785);
  assert.equal(sent[0].requestedTime, 75);
});

// Found on hardware: typing the Mac's address while the background search was still running made the
// TV open TWO sockets, so the Mac showed two pairing prompts for one television. Only the newest
// connection attempt may proceed; an older one that finishes late must do nothing.
test('a superseded connection attempt cannot open a second socket', () => {
  const { context } = receiverHarness();
  const sockets = [];
  context.WebSocket = function (url) { sockets.push(url); this.close = () => {}; };
  const pending = [];
  context.host = (done) => { pending.push(done); };
  context.connect();
  context.connect();                       // e.g. the person typed an address mid-search
  assert.equal(pending.length, 2);
  pending[0]('192.168.1.9', 52132);        // the older attempt finishes late
  assert.equal(sockets.length, 0, 'a stale attempt opened a socket');
  pending[1]('192.168.1.9', 52132);
  assert.equal(sockets.length, 1);
});

// Found on hardware: a TV reconnecting to a remembered Mac connected before appinfo.json had loaded, so its
// greeting carried version null and the Mac showed "unknown". The connection must wait for the version.
test('connect waits for the version to load, then greets with it', () => {
  const { context } = receiverHarness();
  const sockets = [];
  context.WebSocket = function (url) { sockets.push(url); this.close = () => {}; };
  const hosted = [];
  context.host = (done) => { hosted.push(done); };
  context.versionReady = false;               // appinfo.json has not loaded yet
  context.connect();
  assert.equal(hosted.length, 0, 'searched for the Mac before the version was known');
  context.applyVersion({ version: '0.3.2' }); // ...now it has
  assert.equal(context.RECEIVER_VERSION, '0.3.2');
  assert.equal(hosted.length, 1, 'did not connect once the version loaded');
});

test('a version that never loads cannot block the TV from connecting', () => {
  const { context } = receiverHarness();
  const hosted = [];
  context.host = (done) => { hosted.push(done); };
  context.versionReady = false;
  context.applyVersion(null);                 // unreadable appinfo.json
  context.connect();
  assert.equal(hosted.length, 1);
  assert.equal(context.RECEIVER_VERSION, null);
});
