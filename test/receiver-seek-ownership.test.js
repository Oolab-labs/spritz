'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const source = fs.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8');
function fixture() {
  const callbacks = [], preparations = [], commands = [], loads = [], handlers = {};
  const timers = new Map(); let timerId = 0;
  const localPauses = [];
  const ctx = { loadGen: 1, cancelResolvers() {}, applyStreamCache() {}, castEngine: 'mpv',
    mpvAddon: { setProperty: (...args) => localPauses.push(args) }, recordErr() {},
    setTimeout: (fn, delay) => { timers.set(++timerId, { fn, delay }); return timerId; },
    clearTimeout: (id) => timers.delete(id), mpvLastUrl: '/A.mp4', mpvPos: () => 10, lastAvTime: 0, require, path,
    resolveCastable: (src, callback) => preparations.push(callback), console: { log() {} },
    ipcMain: { handle: (name, handler) => { handlers[name] = handler; } },
    startReceivers: () => ({ revoke: () => ({ ok: true }), command: (...args) => { commands.push(args); return { ok: true }; },
      play: (...args) => { loads.push(args); return { ok: true }; } }),
    lan: { retireReceiverHls() {}, vodEpoch: () => ({ current: { id: 'e1' } }), vodSeek: (target, callback) => callbacks.push(callback) } };
  vm.createContext(ctx);
  vm.runInContext(source.slice(source.indexOf('  let receiverIntent ='), source.indexOf('  let castResolveRetry =')) +
    source.slice(source.indexOf('  let castResolveRetry ='), source.indexOf('  // Default receiver profile')) +
    'let receiverPlan = { receiverId: "lg", mediaId: "A", title: "A", epoch: "e1" };' +
    source.slice(source.indexOf('  function retireReceiverRequest('), source.indexOf('  function playToReceiver(')) +
    source.slice(source.indexOf("  ipcMain.handle('receiver:forget'"), source.indexOf("  ipcMain.handle('receiver:play'")) +
    source.slice(source.indexOf('  function playToReceiver('), source.indexOf('  // A seek on a receiver')) +
    source.slice(source.indexOf('  function seekReceiver('), source.indexOf('  // The Spritz Receiver.')) +
    source.slice(source.indexOf("  ipcMain.handle('receiver:command'"), source.indexOf("  ipcMain.on('dlna:discover'")) +
    '\nthis.invalidate = invalidateLoad; this.retire = retireReceiverIntent; this.play = playToReceiver; this.seek = seekReceiver; this.replace = () => { receiverPlan = { receiverId: "lg", mediaId: "B" }; };', ctx);
  return { ctx, callbacks, preparations, commands, loads, handlers, timers, localPauses };
}
const epoch = { kind: 'new-epoch', epoch: 'e2', url: 'http://media/e2', startSec: 0 };
for (const change of ['stop', 'source', 'plan', 'newer seek']) {
  test('pending receiver seek is rejected after ' + change, async () => {
    const f = fixture(), pending = f.ctx.seek('lg', 100);
    if (change === 'stop') f.handlers['receiver:command'](null, { receiverId: 'lg', command: 'stop' });
    if (change === 'source') f.ctx.loadGen++;
    if (change === 'plan') f.ctx.replace();
    if (change === 'newer seek') { const newer = f.ctx.seek('lg', 200); f.callbacks[1](epoch); await newer; }
    const before = f.loads.length;
    f.callbacks[0](epoch);
    assert.equal((await pending).ok, false);
    assert.equal(f.loads.length, before);
  });
}
test('fresh in-epoch and new-epoch seeks still issue the owning command', async () => {
  const f = fixture(), first = f.ctx.seek('lg', 10);
  f.callbacks[0]({ kind: 'in-epoch', localSec: 2 }); assert.equal((await first).ok, true);
  assert.deepEqual(f.commands, [['lg', 'seek', 2]]);
  const next = f.ctx.seek('lg', 100); f.callbacks[1](epoch); assert.equal((await next).ok, true);
  assert.equal(f.loads[0][1].mediaId, 'A'); assert.equal(f.loads[0][1].epoch, 'e2');
});
test('IPC rejects malformed seek arguments before preparation', () => {
  const f = fixture();
  for (const arg of [undefined, null, '10', NaN, Infinity, -1]) {
    assert.equal(f.handlers['receiver:command'](null, { receiverId: 'lg', command: 'seek', arg }).ok, false);
  }
  assert.equal(f.callbacks.length, 0); assert.equal(f.commands.length, 0);
});
for (const stage of ['resolve', 'epoch']) {
  for (const change of ['stop', 'source', 'newer play']) {
    test('pending playback at ' + stage + ' rejects ' + change, async () => {
      const f = fixture(), pending = f.ctx.play('lg');
      if (stage === 'epoch') f.preparations[0]('http://media/A');
      if (change === 'stop') f.handlers['receiver:command'](null, { receiverId: 'lg', command: 'stop' });
      if (change === 'source') { f.ctx.loadGen++; f.ctx.mpvLastUrl = '/B.mp4'; }
      if (change === 'newer play') {
        const newer = f.ctx.play('other'); f.preparations[1]('http://media/new'); f.callbacks.at(-1)(epoch); await newer;
      }
      const before = f.loads.length;
      if (stage === 'resolve') f.preparations[0]('http://media/old'); else f.callbacks[0](epoch);
      assert.equal((await pending).ok, false); assert.equal(f.loads.length, before);
    });
  }
}
test('duplicate preparation and seek callbacks dispatch playback once', async () => {
  const f = fixture(), pending = f.ctx.play('lg');
  f.preparations[0]('http://media/A'); f.preparations[0]('http://media/A');
  assert.equal(f.callbacks.length, 1);
  f.callbacks[0](epoch); f.callbacks[0](epoch); await pending;
  assert.equal(f.loads.length, 1);
});
test('in-epoch preparation uses the captured epoch identity', async () => {
  const f = fixture(), ep = { current: { id: 'original' } };
  f.ctx.lan.vodEpoch = () => ep;
  const pending = f.ctx.play('lg'); f.preparations[0]('http://media/A');
  ep.current = { id: 'replacement' };
  f.callbacks[0]({ kind: 'in-epoch', localSec: 3 }); await pending;
  assert.equal(f.loads[0][1].epoch, 'original');
});
test('Stop settles pending playback without a preparation callback', async () => {
  const f = fixture(), pending = f.ctx.play('lg');
  f.handlers['receiver:command'](null, { receiverId: 'lg', command: 'stop' });
  assert.equal((await pending).ok, false);
  f.preparations[0]('http://media/late');
  assert.equal(f.callbacks.length, 0); assert.equal(f.loads.length, 0);
});
test('newer playback settles its predecessor without a callback', async () => {
  const f = fixture(), old = f.ctx.play('lg'), next = f.ctx.play('other');
  assert.equal((await old).ok, false);
  f.preparations[1]('http://media/current'); f.callbacks[0](epoch);
  assert.equal((await next).ok, true); assert.equal(f.loads.length, 1);
});
test('source invalidation settles playback waiting for epoch preparation', async () => {
  const f = fixture(), pending = f.ctx.play('lg');
  f.preparations[0]('http://media/A'); f.ctx.invalidate();
  assert.equal((await pending).ok, false);
  f.callbacks[0](epoch); assert.equal(f.loads.length, 0);
});
for (const stage of ['resolve', 'epoch']) {
  test('preparation deadline at ' + stage + ' settles and rejects late LOAD', async () => {
    const f = fixture(), pending = f.ctx.play('lg');
    if (stage === 'epoch') f.preparations[0]('http://media/A');
    const timer = [...f.timers.values()][0]; assert.equal(timer.delay, 60000);
    timer.fn(); assert.match((await pending).why, /timed out/);
    assert.equal(f.timers.size, 0);
    if (stage === 'resolve') f.preparations[0]('http://late'); else f.callbacks[0](epoch);
    assert.equal(f.loads.length, 0);
  });
}
test('preparation drains deadline on success, cancellation and synchronous failure', async () => {
  for (const outcome of ['success', 'cancel', 'throw']) {
    const f = fixture();
    if (outcome === 'throw') f.ctx.resolveCastable = () => { throw new Error('spawn failed'); };
    const pending = f.ctx.play('lg');
    if (outcome === 'success') { f.preparations[0]('http://media/A'); f.callbacks[0](epoch); }
    if (outcome === 'cancel') f.ctx.retire();
    assert.equal((await pending).ok, outcome === 'success'); assert.equal(f.timers.size, 0);
  }
});
test('asynchronous epoch preparation exception settles and drains deadline', async () => {
  const f = fixture(), pending = f.ctx.play('lg');
  f.ctx.lan.vodSeek = () => { throw new Error('epoch failed'); };
  f.preparations[0]('http://media/A');
  assert.match((await pending).why, /epoch failed/); assert.equal(f.timers.size, 0);
});
for (const change of ['stop', 'source', 'newer play']) {
  test('seek settles without callback after ' + change, async () => {
    const f = fixture(), pending = f.ctx.seek('lg', 100);
    let next;
    if (change === 'stop') f.handlers['receiver:command'](null, { receiverId: 'lg', command: 'stop' });
    if (change === 'source') f.ctx.invalidate();
    if (change === 'newer play') next = f.ctx.play('other');
    assert.match((await pending).why, /superseded/);
    f.callbacks[0](epoch); assert.equal(f.loads.length, 0);
    if (next) { f.ctx.retire(); await next; }
    assert.equal(f.timers.size, 0);
  });
}
test('seek deadline settles once and blocks late transport dispatch', async () => {
  const f = fixture(), pending = f.ctx.seek('lg', 100);
  [...f.timers.values()][0].fn();
  assert.match((await pending).why, /timed out/); assert.equal(f.timers.size, 0);
  f.callbacks[0](epoch); f.callbacks[0](epoch); assert.equal(f.loads.length, 0);
});
test('in-epoch duplicate completion sends one command and drains deadline', async () => {
  const f = fixture(), pending = f.ctx.seek('lg', 10);
  f.callbacks[0]({ kind: 'in-epoch', localSec: 2 });
  f.callbacks[0]({ kind: 'in-epoch', localSec: 2 });
  assert.equal((await pending).ok, true); assert.equal(f.commands.length, 1); assert.equal(f.timers.size, 0);
});
test('seek planner exception settles and clears its timer', async () => {
  const f = fixture(); f.ctx.lan.vodSeek = () => { throw new Error('planner failed'); };
  assert.match((await f.ctx.seek('lg', 100)).why, /planner failed/); assert.equal(f.timers.size, 0);
});
for (const reason of ['stop', 'timeout', 'replacement']) {
  test('seek ' + reason + ' disposes only its owned preparation', async () => {
    const f = fixture(), retired = [];
    f.ctx.lan.vodSeek = (target, cb) => {
      f.callbacks.push(cb); return () => { retired.push(target); cb(null); };
    };
    const old = f.ctx.seek('lg', 100); let newer;
    if (reason === 'stop') f.handlers['receiver:command'](null, { receiverId: 'lg', command: 'stop' });
    if (reason === 'timeout') [...f.timers.values()][0].fn();
    if (reason === 'replacement') newer = f.ctx.seek('lg', 200);
    assert.equal((await old).ok, false); assert.deepEqual(retired, [100]);
    f.callbacks[0](epoch); assert.deepEqual(retired, [100]); assert.equal(f.loads.length, 0);
    if (newer) { f.callbacks[1](epoch); assert.equal((await newer).ok, true); assert.deepEqual(retired, [100]); }
  });
}
test('synchronous failed preparation disposes its late-returned handle once', async () => {
  const f = fixture(); let retired = 0;
  f.ctx.lan.vodSeek = (_, cb) => { cb(null); return () => retired++; };
  assert.equal((await f.ctx.seek('lg', 100)).ok, false); assert.equal(retired, 1);
});
for (const result of [null, { kind: 'unsupported' }]) {
  test('failed startup seek does not silently LOAD at zero: ' + JSON.stringify(result), async () => {
    const f = fixture(), pending = f.ctx.play('lg');
    f.preparations[0]('http://media/A'); f.callbacks[0](result);
    assert.equal((await pending).ok, false); assert.equal(f.loads.length, 0); assert.equal(f.timers.size, 0);
  });
}
test('unsupported seek plan sends no LOAD and disposes preparation', async () => {
  const f = fixture(); let disposed = 0;
  f.ctx.lan.vodSeek = (_, cb) => { f.callbacks.push(cb); return () => disposed++; };
  const pending = f.ctx.seek('lg', 100); f.callbacks[0]({ kind: 'unsupported' });
  assert.equal((await pending).ok, false); assert.equal(f.loads.length, 0); assert.equal(disposed, 1);
});
for (const reason of ['stop', 'timeout', 'source', 'replacement']) {
  test('startup epoch ' + reason + ' disposes its owned pending transport', async () => {
    const f = fixture(), disposed = [];
    f.ctx.lan.vodSeek = (_, cb) => {
      const index = f.callbacks.length; f.callbacks.push(cb);
      return () => { disposed.push(index); cb(null); };
    };
    const old = f.ctx.play('lg'); f.preparations[0]('http://old'); let next;
    if (reason === 'stop') f.handlers['receiver:command'](null, { receiverId: 'lg', command: 'stop' });
    if (reason === 'timeout') [...f.timers.values()][0].fn();
    if (reason === 'source') f.ctx.invalidate();
    if (reason === 'replacement') { next = f.ctx.play('other'); f.preparations[1]('http://new'); }
    assert.equal((await old).ok, false); assert.deepEqual(disposed, [0]);
    f.callbacks[0](epoch); assert.equal(f.loads.length, 0);
    if (next) { f.callbacks[1](epoch); assert.equal((await next).ok, true); }
    assert.deepEqual(disposed, [0]); assert.equal(f.timers.size, 0);
  });
}
test('synchronous startup failure disposes the handle returned after completion', async () => {
  const f = fixture(); let disposed = 0;
  f.ctx.lan.vodSeek = (_, cb) => { cb(null); return () => disposed++; };
  const pending = f.ctx.play('lg'); f.preparations[0]('http://media');
  assert.equal((await pending).ok, false); assert.equal(disposed, 1);
});
test('forget retires matching preparation before revocation and rejects late LOAD', async () => {
  const f = fixture(), pending = f.ctx.play('lg');
  f.handlers['receiver:forget'](null, { receiverId: 'lg' });
  assert.equal((await pending).ok, false); assert.equal(f.timers.size, 0);
  f.preparations[0]('http://late'); assert.equal(f.loads.length, 0);
});
for (const command of ['receiver:forget', 'receiver:command']) {
  test(command + ' for an unrelated receiver preserves current preparation', async () => {
    const f = fixture(), pending = f.ctx.play('lg');
    f.handlers[command](null, { receiverId: 'other', command: 'stop' });
    f.preparations[0]('http://media'); f.callbacks[0](epoch);
    assert.equal((await pending).ok, true); assert.equal(f.loads.length, 1);
  });
  test(command + ' for the old receiver preserves a newer target preparation', async () => {
    const f = fixture(), pending = f.ctx.play('other');
    f.handlers[command](null, { receiverId: 'lg', command: 'stop' });
    f.preparations[0]('http://new'); f.callbacks[0](epoch);
    assert.equal((await pending).ok, true); assert.equal(f.loads[0][0], 'other');
  });
}
for (const stage of ['resolve', 'epoch', 'direct']) {
  test('latest pause/play intent survives LOAD preparation at ' + stage, async () => {
    for (const autoplay of [false, true]) {
      const f = fixture();
      if (stage === 'direct') f.ctx.lan.vodEpoch = () => null;
      const pending = f.ctx.play('lg');
      if (stage === 'epoch') f.preparations[0]('http://media');
      f.handlers['receiver:command'](null, { receiverId: 'lg', command: 'pause' });
      if (autoplay) f.handlers['receiver:command'](null, { receiverId: 'lg', command: 'play' });
      if (stage !== 'epoch') f.preparations[0]('http://media');
      if (stage !== 'direct') f.callbacks[0](epoch);
      assert.equal((await pending).ok, true); assert.equal(f.loads[0][1].autoplay, autoplay);
    }
  });
}
test('unrelated pause does not change pending LOAD autoplay', async () => {
  const f = fixture(), pending = f.ctx.play('lg');
  f.handlers['receiver:command'](null, { receiverId: 'other', command: 'pause' });
  f.preparations[0]('http://media'); f.callbacks[0](epoch); await pending;
  assert.equal(f.loads[0][1].autoplay, true);
});
test('malformed prepared transport results send no LOAD or seek command', async () => {
  const invalid = [
    { ...epoch, epoch: '' }, { ...epoch, epoch: null }, { ...epoch, url: '' },
    { ...epoch, startSec: -1 }, { ...epoch, startSec: NaN }, { ...epoch, startSec: '0' },
    { kind: 'in-epoch', localSec: -1 }, { kind: 'in-epoch', localSec: undefined },
    { kind: 'in-epoch', localSec: Infinity }
  ];
  for (const result of invalid) {
    for (const startup of [true, false]) {
      const f = fixture(), pending = startup ? f.ctx.play('lg') : f.ctx.seek('lg', 100);
      const heldPlan = vm.runInContext('receiverPlan', f.ctx);
      if (startup) f.preparations[0]('http://media');
      f.callbacks[0](result);
      assert.equal((await pending).ok, false); assert.equal(f.loads.length, 0);
      assert.equal(f.commands.length, 0); assert.equal(f.timers.size, 0);
      assert.equal(vm.runInContext('receiverPlan', f.ctx), heldPlan);
    }
  }
});
for (const reason of ['stop', 'timeout', 'source', 'replacement']) {
  test('receiver LOAD ' + reason + ' disposes its owned source admission', async () => {
    const f = fixture(), disposed = [];
    f.ctx.resolveCastable = (_, cb) => {
      const index = f.preparations.length; f.preparations.push(cb);
      return () => { disposed.push(index); cb(null); };
    };
    const old = f.ctx.play('lg'); let newer;
    if (reason === 'stop') f.handlers['receiver:command'](null, { receiverId: 'lg', command: 'stop' });
    if (reason === 'timeout') [...f.timers.values()][0].fn();
    if (reason === 'source') f.ctx.invalidate();
    if (reason === 'replacement') newer = f.ctx.play('other');
    assert.equal((await old).ok, false); assert.deepEqual(disposed, [0]);
    f.preparations[0]('http://late'); assert.equal(f.loads.length, 0);
    if (newer) { f.preparations[1]('http://new'); f.callbacks[0](epoch); await newer; }
    assert.deepEqual(disposed, [0]);
  });
}
for (const during of [false, true]) {
test('epoch-replacing seek preserves latest paused intent, during=' + during, async () => {
    for (const autoplay of [false, true]) {
      const f = fixture();
      f.handlers['receiver:command'](null, { receiverId: 'lg', command: 'pause' });
      let pending;
      if (during) pending = f.ctx.seek('lg', 100);
      if (autoplay) f.handlers['receiver:command'](null, { receiverId: 'lg', command: 'play' });
      if (!during) pending = f.ctx.seek('lg', 100);
      f.callbacks[0](epoch); assert.equal((await pending).ok, true);
      assert.equal(f.loads[0][1].autoplay, autoplay);
      const next = f.ctx.seek('lg', 200); f.callbacks[1](epoch); await next;
      assert.equal(f.loads[1][1].autoplay, autoplay);
    }
  });
}

test('successful receiver handoff pauses local playback, failed or superseded handoff does not', async () => {
  const f = fixture(), pending = f.ctx.play('lg');
  assert.equal(f.localPauses.length, 0);
  f.preparations[0]('http://media/A'); f.callbacks[0](epoch);
  assert.equal((await pending).ok, true);
  assert.deepEqual(f.localPauses, [['pause', true], ['demuxer-max-bytes', 33554432], ['demuxer-max-back-bytes', 8388608]]);
  const failed = fixture(), rejected = failed.ctx.play('lg');
  failed.preparations[0](null);
  assert.equal((await rejected).ok, false);
  assert.equal(failed.localPauses.length, 0);
  const stale = fixture(), cancelled = stale.ctx.play('lg');
  stale.ctx.loadGen++;
  stale.preparations[0]('http://media/A');
  assert.equal((await cancelled).ok, false);
  assert.equal(stale.localPauses.length, 0);
});

test('initial receiver preparation uses its assigned media server and cancellation retires it', async () => {
  const f = fixture(); let retired = 0, captured;
  const isolated = { vodEpoch: () => null, teardown: () => retired++ };
  f.ctx.receiverTransportFor = () => isolated;
  f.ctx.resolveCastable = (_, callback, caps, forCast, extra) => { captured = extra.transport; f.preparations.push(callback); };
  const pending = f.ctx.play('lg');
  assert.equal(captured, isolated);
  f.ctx.invalidate();
  assert.equal((await pending).ok, false); assert.equal(retired, 1);
  f.preparations[0]('http://late'); assert.equal(f.loads.length, 0);
});
test('initial receiver LOAD reads epoch facts from its own server, not the AirPlay server', async () => {
  const f = fixture(); let baseTouched = false;
  f.ctx.lan.vodEpoch = () => { baseTouched = true; return { current: { id: 'AirPlay' } }; };
  f.ctx.receiverTransportFor = () => ({ vodEpoch: () => null, teardown() {} });
  const pending = f.ctx.play('lg'); f.preparations[0]('http://receiver/media');
  assert.equal((await pending).ok, true);
  assert.equal(baseTouched, false); assert.equal(f.callbacks.length, 0);
  assert.equal(f.loads[0][1].url, 'http://receiver/media');
});

test('same-source receiver handoff reads the latest subtitle intent at LOAD', async () => {
  for (const latest of ['source-subtitle-35', 'off']) {
    const f = fixture(); let selection = 'source-subtitle-2', prepare, preparationOptions;
    f.ctx.lan.vodEpoch = () => null;
    vm.runInContext('receiverPlan = { receiverId: "lg", mediaId: "old", epoch: null, src: "/A.mp4" };', f.ctx);
    f.ctx.resolveCastable = (_src, cb, _caps, _cast, extra) => { prepare = cb; preparationOptions = extra; };
    f.ctx.startReceivers = () => ({ subtitleSelection: () => selection, play: (...args) => { f.loads.push(args); return { ok: true }; } });
    const pending = f.ctx.play('lg'); selection = latest;
    prepare('http://media/new', []);
    assert.equal((await pending).ok, true);
    assert.equal(f.loads[0][1].subtitleTrackId, latest);
    assert.equal(preparationOptions.receiverSubtitles, true);
  }
});


test('dedicated receiver handoff retires unused AirPlay HLS only on success', async () => {
  for (const succeeds of [true, false]) {
    const f = fixture(); let retired = 0;
    f.ctx.lan.retireReceiverHls = () => retired++;
    const mediaLan = { vodEpoch: () => null, teardown() {} };
    f.ctx.receiverTransportFor = () => mediaLan;
    const pending = f.ctx.play('lg'); f.preparations[0](succeeds ? 'http://media/receiver' : null);
    assert.equal((await pending).ok, succeeds); assert.equal(retired, succeeds ? 1 : 0);
  }
});

test('initial source-audio LOAD carries the full film duration even for zero origin', async () => {
  const f = fixture(); f.ctx.lan.vodEpoch = () => null;
  const pending = f.ctx.play('lg');
  f.preparations[0]('http://media/receiver', [], { timelineOrigin: 0, sourceDuration: 5785, audio: [] });
  assert.equal((await pending).ok, true);
  assert.equal(f.loads[0][1].timelineOrigin, 0); assert.equal(f.loads[0][1].sourceDuration, 5785);
});

test('receiver handoff releases its AirPlay hold and polling on all settlement paths', async () => {
  for (const outcome of ['success', 'failure', 'timeout', 'cancel']) {
    const f = fixture(), releases = []; let holds = 0;
    f.ctx.receiverTransportFor = () => ({ vodEpoch: () => null, teardown() {} });
    f.ctx.lan.holdReadyAirplayPrep = () => { holds++; return resume => releases.push(resume); };
    const pending = f.ctx.play('lg');
    assert.equal(holds, 1);
    if (outcome === 'timeout') [...f.timers.values()].find(t => t.delay === 60000).fn();
    else if (outcome === 'cancel') f.ctx.retire();
    else f.preparations[0](outcome === 'success' ? 'http://media/new' : null);
    await pending;
    assert.deepEqual(releases, [true]); assert.equal(f.timers.size, 0);
  }
});
test('handoff waits for ready AirPlay preparation and cancels later polling', async () => {
  const f = fixture(); let ready = false, held = 0, released = 0;
  f.ctx.receiverTransportFor = () => ({ vodEpoch: () => null, teardown() {} });
  f.ctx.lan.holdReadyAirplayPrep = () => ready ? (held++, () => released++) : null;
  const pending = f.ctx.play('lg');
  const entry = [...f.timers.entries()].find(([, t]) => t.delay === 500);
  f.timers.delete(entry[0]); ready = true; entry[1].fn();
  assert.equal(held, 1); f.ctx.retire(); await pending;
  assert.equal(released, 1); assert.equal(f.timers.size, 0);
});
test('AirPlay playback and rollback transports are never held for receiver preparation', async () => {
  for (const mode of ['airplay', 'rollback']) {
    const f = fixture(); let holds = 0;
    f.ctx.receiverTransportFor = () => ({ vodEpoch: () => null, teardown() {} });
    f.ctx.lan.holdReadyAirplayPrep = () => { holds++; return () => {}; };
    if (mode === 'airplay') f.ctx.castEngine = 'airplay';
    else vm.runInContext('receiverPlan.transport = lan;', f.ctx);
    const pending = f.ctx.play('lg'); f.ctx.retire(); await pending;
    assert.equal(holds, 0); assert.equal(f.timers.size, 0);
  }
});
