'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('vm');
const fs = require('fs');
const path = require('path');
const source = fs.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8');
function fixture() {
  const calls = [], events = [], preparations = [];
  let prepare;
  const transport = { serveHls(src, cb, opts) { prepare = cb; preparations.push(cb); calls.push({ src, opts }); }, teardown() { calls.push('teardown'); } };
  const owner = { receiverId: 'tv', mediaId: 'old', epoch: null, src: '/movie.mkv', url: 'old-url', position: 42,
    autoplay: false, selectedAudio: 0, audioCatalog: [{ id: 'source-audio-0' }, { id: 'source-audio-1' }] };
  const svc = { targets: () => [{ id: 'tv', playback: { currentTime: 42, tracks: { subtitles: [{ id: '1', selected: true }] } } }],
    profile: () => ({ hevc4k: true }), play: (_, plan) => { calls.push(plan); return { ok: true }; } };
  const ctx = { process: { env: {} }, receiverPlan: owner, mpvLastUrl: '/movie.mkv', receiverIntent: 0, loadGen: 0,
    pendingReceiverOperation: null, externalSubs: [], lan: { retireReceiverHls() { calls.push('retire-old'); } },
    startReceivers: () => svc, send: (_, e) => events.push(e), setTimeout, clearTimeout,
    require: name => name === './lanserver' ? () => transport : require(name.startsWith('./') ? path.join(__dirname, '../src/main', name) : name) };
  owner.transport = ctx.lan;
  ctx.retireReceiverIntent = () => { ctx.receiverIntent++; if (ctx.pendingReceiverOperation) ctx.pendingReceiverOperation(); return ctx.receiverIntent; };
  vm.createContext(ctx);
  vm.runInContext(source.slice(source.indexOf('  function switchReceiverAudio('), source.indexOf('  // A seek on a receiver, in LOGICAL film time.')) + '\nthis.switchAudio = switchReceiverAudio;', ctx);
  return { ctx, calls, events, owner, preparations, request: () => ctx.switchAudio('tv', { mediaId: 'old', epoch: null, kind: 'audio', trackId: 'source-audio-1' }),
    complete: (url = 'new-url', metadata = {}) => prepare(url, [], { audio: [{ id: 'source-audio-1', selected: true }], ...metadata }) };
}
test('audio preparation preserves active stream; commit carries latest clock and pause intent', async () => {
  const f = fixture(), pending = f.request();
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].opts.audioTrack, 1);
  assert.equal(f.ctx.receiverPlan, f.owner);
  f.owner.position = 48;
  f.ctx.pendingReceiverOperation.autoplay = false;
  f.complete();
  assert.equal((await pending).ok, true);
  const load = f.calls[1];
  assert.equal(load.startSec, 48);
  assert.equal(load.autoplay, false);
  assert.equal(load.subtitleTrackId, '1');
  assert.notEqual(load.mediaId, 'old');
  assert.equal(f.calls.includes('retire-old'), false);
  clearTimeout(f.ctx.receiverPlan.pendingClockTimer);
  f.ctx.receiverPlan.retirePrevious();
  assert.equal(f.calls.includes('retire-old'), true);
});
test('failed preparation disposes replacement and keeps old plan', async () => {
  const f = fixture(), pending = f.request(); f.complete(null);
  assert.equal((await pending).ok, false);
  assert.equal(f.ctx.receiverPlan, f.owner);
  assert.equal(f.calls.includes('teardown'), true);
});
test('source change cancels pending audio; late preparation cannot send a load', async () => {
  const f = fixture(), pending = f.request(); f.ctx.mpvLastUrl = '/different.mkv'; f.ctx.retireReceiverIntent(); f.complete();
  assert.equal((await pending).ok, false);
  assert.equal(f.calls.filter(c => c && c.mediaId).length, 0);
});
test('stale owner, epoch and unavailable source IDs do not start preparation', async () => {
  for (const arg of [{ mediaId: 'stale', trackId: 'source-audio-1' }, { mediaId: 'old', epoch: 'old-epoch', trackId: 'source-audio-1' }, { mediaId: 'old', trackId: 'source-audio-9' }]) {
    const f = fixture(); assert.equal((await f.ctx.switchAudio('tv', arg)).ok, false); assert.equal(f.calls.length, 0);
  }
});

test('audio commit retains subtitle changed during preparation, including Off', async () => {
  for (const latest of ['source-subtitle-35', 'off']) {
    const f = fixture(), svc = f.ctx.startReceivers();
    let selected = 'source-subtitle-2';
    svc.subtitleSelection = () => selected;
    const pending = f.request();
    selected = latest;
    f.complete();
    assert.equal((await pending).ok, true);
    const load = f.calls.find(c => c && c.mediaId);
    assert.equal(load.subtitleTrackId, latest);
    assert.equal(f.ctx.receiverPlan.previous.subtitleTrackId, latest);
    assert.equal(f.calls[0].opts.receiverSubtitles, true);
    clearTimeout(f.ctx.receiverPlan.pendingClockTimer);
  }
});

test('startup-position errors roll back the matching audio replacement even when nonfatal', () => {
  let error, restored;
  const ctx = { receivers: { on: (_, cb) => { error = cb; } },
    receiverPlan: { receiverId: 'tv', mediaId: 'new', epoch: null, previous: {} },
    rollbackReceiverAudio: plan => { restored = plan; }, send() {} };
  vm.runInNewContext(source.slice(source.indexOf("    receivers.on('playback-error'"), source.indexOf('    receivers.start();')), ctx);
  error({ receiverId: 'tv', mediaId: 'old', code: 'startup-position', fatal: false });
  assert.equal(restored, undefined);
  error({ receiverId: 'tv', mediaId: 'new', code: 'startup-position', fatal: false });
  assert.equal(restored, ctx.receiverPlan);
});
test('audio rollback preserves pause/resume and subtitle intent changed during startup', () => {
  let load;
  const previous = { receiverId: 'tv', mediaId: 'old', position: 23.3, autoplay: false, subtitleTrackId: 's1' };
  const failed = { receiverId: 'tv', mediaId: 'new', previous, transport: { teardown() {} } };
  const ctx = { receiverPlan: failed, clearTimeout() {}, send() {},
    startReceivers: () => ({ targets: () => [{id: 'tv', playback: {state: 'playing'}}],
      subtitleSelection: () => 'off', play: (_, p) => { load = p; return {ok:true}; } }) };
  vm.runInNewContext(source.slice(source.indexOf('  function rollbackReceiverAudio('), source.indexOf('  // Experimental until')), ctx);
  ctx.rollbackReceiverAudio(failed, 'test');
  assert.equal(load.startSec, 23.3); assert.equal(load.autoplay, true); assert.equal(load.subtitleTrackId, 'off');
  assert.equal(ctx.receiverPlan, previous);
});

test('near preparation requires opt-in and receiver support, and commits measured origin', async () => {
  const f = fixture();
  f.ctx.process.env.SPRITZ_RECEIVER_NEAR_AUDIO = '1';
  f.ctx.startReceivers().supportsLogicalTimeline = () => true;
  f.owner.position = 120;
  const pending = f.request();
  assert.equal(f.calls[0].opts.receiverInputStartSec, 100);
  f.complete('mapped', { timelineOrigin: 98.098, sourceDuration: 3122 });
  assert.equal((await pending).ok, true);
  assert.equal(f.ctx.receiverPlan.timelineOrigin, 98.098);
  assert.equal(f.calls[1].startSec, 120);
  clearTimeout(f.ctx.receiverPlan.pendingClockTimer);
});
test('same-audio range replacement holds requested seek despite old stream advancing', async () => {
  const f = fixture(); f.owner.timelineOrigin = 100;
  const pending = f.ctx.switchAudio('tv', { mediaId: 'old', trackId: 'source-audio-0', seekSec: 10 });
  f.owner.position = 140;
  assert.equal(f.calls[0].opts.receiverStartSec(), 10);
  f.complete();
  assert.equal((await pending).ok, true);
  assert.equal(f.calls[1].startSec, 10);
  assert.equal(f.ctx.receiverPlan.timelineOrigin, undefined);
  clearTimeout(f.ctx.receiverPlan.pendingClockTimer);
});

test('out-of-range recovery accepts only the current media owner', async () => {
  let error; const requests = [];
  const ctx = { receivers: { on: (_, cb) => { error = cb; } }, receiverPlan: { receiverId: 'tv', mediaId: 'mapped', epoch: null, selectedAudio: 1 },
    switchReceiverAudio: (id, arg) => { requests.push({ id, arg }); return Promise.resolve({ ok: true }); }, send() {} };
  vm.runInNewContext(source.slice(source.indexOf("    receivers.on('playback-error'"), source.indexOf('    receivers.start();')), ctx);
  error({ receiverId: 'tv', mediaId: 'old', code: 'seek-outside-transport', requestedTime: 10 });
  assert.equal(requests.length, 0);
  error({ receiverId: 'tv', mediaId: 'mapped', code: 'seek-outside-transport', requestedTime: 10 });
  await Promise.resolve();
  assert.equal(requests[0].arg.seekSec, 10);
  assert.equal(requests[0].arg.trackId, 'source-audio-1');
});

function nearFixture() {
  const f = fixture(); f.ctx.process.env.SPRITZ_RECEIVER_NEAR_AUDIO = '1';
  f.ctx.startReceivers().supportsLogicalTimeline = () => true; f.owner.position = 75;
  return f;
}
test('timestamp failure retries once from origin with latest subtitle and pause intent', async () => {
  const f = nearFixture(), pending = f.request();
  assert.equal(f.calls[0].opts.receiverInputStartSec, 55);
  f.complete(null, { retryFromOrigin: true });
  assert.equal(f.calls[1].opts.receiverInputStartSec, 0);
  assert.equal(f.ctx.receiverPlan, f.owner);
  f.owner.position = 80; f.ctx.pendingReceiverOperation.autoplay = false;
  f.ctx.startReceivers().subtitleSelection = () => 'off';
  f.complete(); assert.equal((await pending).ok, true);
  const load = f.calls.find(c => c && c.mediaId);
  assert.equal(load.startSec, 80); assert.equal(load.autoplay, false); assert.equal(load.subtitleTrackId, 'off');
  assert.equal(load.timelineOrigin, undefined);
  clearTimeout(f.ctx.receiverPlan.pendingClockTimer);
});
test('late callback from failed near candidate cannot commit over origin retry', async () => {
  const f = nearFixture(), pending = f.request(); f.complete(null, { retryFromOrigin: true });
  f.preparations[0]('stale', [], { audio: [], timelineOrigin: 55 });
  assert.equal(f.calls.some(c => c && c.mediaId), false);
  f.complete('origin'); assert.equal((await pending).ok, true);
  assert.equal(f.ctx.receiverPlan.url, 'origin'); clearTimeout(f.ctx.receiverPlan.pendingClockTimer);
});
test('cancelled origin retry rejects late success and retains previous plan', async () => {
  const f = nearFixture(), pending = f.request(); f.complete(null, { retryFromOrigin: true });
  f.ctx.retireReceiverIntent(); f.complete(); assert.equal((await pending).ok, false);
  assert.equal(f.ctx.receiverPlan, f.owner); assert.equal(f.calls.some(c => c && c.mediaId), false);
});
test('origin failure never repeats the fallback or extends the deadline', async () => {
  const f = nearFixture(), deadlines = [];
  f.ctx.setTimeout = (fn, ms) => { deadlines.push(ms); return setTimeout(fn, ms); };
  const pending = f.request(); f.complete(null, { retryFromOrigin: true }); f.complete(null, { retryFromOrigin: true });
  assert.equal((await pending).ok, false); assert.equal(f.preparations.length, 2);
  assert.deepEqual(deadlines, [60000]); assert.equal(f.ctx.receiverPlan, f.owner);
});
test('ordinary preparation failure does not trigger an origin retry', async () => {
  const f = nearFixture(), pending = f.request(); f.complete(null);
  assert.equal((await pending).ok, false); assert.equal(f.preparations.length, 1);
});
test('audio and seek replacement use the receiver producer-aware transport factory', async () => {
  const f = fixture(); let created = 0;
  f.ctx.receiverTransportFor = () => { created++; return { serveHls: (_src, cb) => cb(null), teardown() {} }; };
  assert.equal((await f.request()).ok, false); assert.equal(created, 1);
});
