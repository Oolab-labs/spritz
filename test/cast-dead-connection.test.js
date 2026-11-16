'use strict';

// A Cast control connection the TV closed without an error.
//
// Measured on an LG webOS TV: mid-cast, the TV closed Spritz's Cast socket cleanly. castv2 nulls its
// socket and castv2-client's PlatformSender drops its inner client (senders/platform.js onclose →
// Sender.prototype.close), but neither emits anything on the object Spritz holds — only 'error' was
// ever listened for, and a clean close is not one. Spritz kept the dead client and player, and the
// next seek on the live pipe took the fast path over them: p.load threw
//   TypeError: Cannot read properties of null (reading 'send')
// as an uncaughtException, the LOAD never left, the old stream had already been ended for the new
// one, and the TV sat frozen until the 30 s load timeout bounced the film back to the Mac.
//
// The stand-in below has castv2-client's shape where it matters: the PlatformSender keeps its castv2
// Client at `.client`, a clean close nulls it and emits 'close' only on that inner client, and a
// player whose connection is gone throws from load() exactly as the real one does.

const { test } = require('node:test');
const assert = require('assert');
const { EventEmitter } = require('events');

function fakeCastLib() {
  const made = { clients: [], players: [], loads: [] };
  class Player extends EventEmitter {
    constructor(owner) { super(); this.owner = owner; this.media = new EventEmitter(); this.media.send = () => {}; made.players.push(this); }
    load(info, opts, cb) {
      if (!this.owner.client) throw new TypeError("Cannot read properties of null (reading 'send')");
      made.loads.push({ client: this.owner, url: info.contentId, currentTime: opts.currentTime });
      setImmediate(() => cb(null, { playerState: 'PLAYING', currentTime: opts.currentTime || 0, media: { contentId: info.contentId } }));
    }
    stop(cb) { if (cb) cb(); }
  }
  class Client extends EventEmitter {
    constructor() { super(); this.client = null; made.clients.push(this); }
    connect(_host, cb) {
      const inner = new EventEmitter(); inner.socket = {};
      this.client = inner;
      setImmediate(cb);
    }
    launch(_app, cb) { setImmediate(() => cb(null, new Player(this))); }
    // What the TV closing the socket does inside castv2 / castv2-client: nothing reaches this object.
    tvClosesSocket() { const inner = this.client; inner.socket = null; this.client = null; inner.emit('close'); }
    close() { const inner = this.client; if (inner) { inner.socket = null; this.client = null; inner.emit('close'); } }
    setVolume(_v, cb) { if (cb) cb(); }
  }
  return { lib: { Client, DefaultMediaReceiver: function DefaultMediaReceiver() {} }, made };
}

async function withFakeCast(fn) {
  const { lib, made } = fakeCastLib();
  const resolved = require.resolve('castv2-client');
  const prior = require.cache[resolved];
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: lib };
  const castPath = require.resolve('../src/main/cast');
  delete require.cache[castPath];
  const cast = require('../src/main/cast')();
  const uncaught = [];
  const onUncaught = (e) => uncaught.push(e);
  process.on('uncaughtException', onUncaught);
  try { await fn(cast, made, uncaught); }
  finally {
    process.removeListener('uncaughtException', onUncaught);
    try { cast.teardown(); } catch (e) {}
    delete require.cache[castPath];
    if (prior) require.cache[resolved] = prior; else delete require.cache[resolved];
  }
}

const HOST = '192.168.1.6';
const pipe = (url, at) => ({ url, contentType: 'video/mp4', title: 'Film', livePipe: true, currentTime: at });
const load = (cast, media) => new Promise((resolve) => {
  let r; try { cast.load(HOST, media, (e) => resolve(e || null)); } catch (e) { r = e; }
  if (r) resolve(r);
});

test('a seek after the TV silently closed the Cast socket reaches the TV over a fresh connection', () => withFakeCast(async (cast, made, uncaught) => {
  assert.equal(await load(cast, pipe('http://mac/mkv/a', 600)), null);
  made.clients.at(-1).tvClosesSocket();
  const err = await Promise.race([load(cast, pipe('http://mac/mkv/b', 900)), new Promise((r) => setTimeout(() => r('no answer within 2 s'), 2000))]);
  assert.deepEqual(uncaught.map(String), [], 'nothing escaped as an uncaught exception');
  assert.equal(err, null, 'the seek load completed');
  const last = made.loads.at(-1);
  assert.equal(last.url, 'http://mac/mkv/b', 'the new stream was sent');
  assert.notEqual(last.client, made.clients[0], 'over a new connection, not the dead one');
}));

test('a LOAD that throws on a connection that looked alive falls back to a fresh connection', () => withFakeCast(async (cast, made, uncaught) => {
  assert.equal(await load(cast, pipe('http://mac/mkv/a', 600)), null);
  // Alive as far as anything can tell, but the send fails: the fast path must not let that escape.
  made.players.at(-1).load = () => { throw new TypeError("Cannot read properties of null (reading 'send')"); };
  const err = await Promise.race([load(cast, pipe('http://mac/mkv/b', 900)), new Promise((r) => setTimeout(() => r('no answer within 2 s'), 2000))]);
  assert.deepEqual(uncaught.map(String), []);
  assert.equal(err, null);
  assert.equal(made.loads.at(-1).url, 'http://mac/mkv/b');
  assert.equal(made.clients.length, 2, 'one reconnect');
}));

test('the TV closing the socket mid-cast is treated as a dropped connection and recovered', () => withFakeCast(async (cast, made) => {
  const reconnects = [];
  cast.on('reconnect', (e) => reconnects.push(e));
  assert.equal(await load(cast, pipe('http://mac/mkv/a', 600)), null);
  made.players.at(-1).emit('status', { playerState: 'PLAYING', currentTime: 42, media: { contentId: 'http://mac/mkv/a' } });
  made.clients.at(-1).tvClosesSocket();
  assert.equal(reconnects.length, 1, 'a live pipe asks the app for a fresh stream from the live position');
  assert.equal(reconnects[0].at, 42);
}));

test('closing the connection ourselves is not a drop', () => withFakeCast(async (cast, made) => {
  const reconnects = [], errors = [];
  cast.on('reconnect', (e) => reconnects.push(e));
  cast.on('error', (e) => errors.push(e));
  assert.equal(await load(cast, pipe('http://mac/mkv/a', 600)), null);
  cast.stop();
  assert.deepEqual(reconnects, []);
  assert.deepEqual(errors, []);
  assert.equal(made.clients.length, 1);
}));

// Measured on the LG with rc.17's candidate: the TV closed the connection after a seek, Spritz reconnected,
// the TV fetched the new stream — and closed the connection again before answering the LOAD. Failing
// that load sent the film back to the Mac. The TV was by then already reading the new stream.
test('the TV closing the socket while a live-pipe LOAD is in flight reconnects instead of failing it', () => withFakeCast(async (cast, made) => {
  const reconnects = [], errors = [];
  cast.on('reconnect', (e) => reconnects.push(e));
  cast.on('error', (e) => errors.push(e));
  assert.equal(await load(cast, pipe('http://mac/mkv/a', 600)), null);
  // The next LOAD is delivered but never answered: the TV closes the socket first.
  made.players.at(-1).load = function (info) { made.loads.push({ client: this.owner, url: info.contentId }); };
  const pending = load(cast, pipe('http://mac/mkv/b', 900));
  await new Promise((r) => setImmediate(r));
  made.clients.at(-1).tvClosesSocket();
  const err = await pending;
  assert.ok(err && err.reconnecting === true, 'the waiting caller is told the cast is reconnecting, not that it failed: ' + err);
  assert.deepEqual(errors, [], 'no cast error reaches the window');
  assert.deepEqual(reconnects, [{ at: 900, duringLoad: true }], 'reconnect at the position that load was taking the TV to');
}));

