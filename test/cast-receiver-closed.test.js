'use strict';

// When the TV closes the Cast app, the cast is over.
//
// The Default Media Receiver goes away when the viewer presses Home, switches input, or another phone
// casts something else. The receiver says so with a CLOSE on the app's connection, which castv2-client
// turns into a 'close' on the player (senders/application.js). The control socket itself stays up —
// the platform heartbeat keeps it alive — so no 'error' fires either. Nothing in cast.js listened for
// that 'close', so Spritz sat in the cast screen with a clock that never moved again: the hang.
//
// These drive the real cast.js load path against a stand-in castv2-client.

const { test } = require('node:test');
const assert = require('assert');
const { EventEmitter } = require('events');

function fakeCastLib() {
  const made = { clients: [], players: [] };
  class Player extends EventEmitter {
    constructor() { super(); this.media = new EventEmitter(); this.media.send = () => {}; this.media.sessionRequest = (_m, cb) => cb && cb(); made.players.push(this); }
    load(info, _opts, cb) { setImmediate(() => cb(null, { playerState: 'PLAYING', currentTime: 0, media: { contentId: info.contentId } })); }
    stop(cb) { if (cb) cb(); }
  }
  class Client extends EventEmitter {
    constructor() { super(); made.clients.push(this); this.closed = false; }
    connect(_host, cb) { setImmediate(cb); }
    launch(_app, cb) { setImmediate(() => cb(null, new Player())); }
    close() { this.closed = true; }
    setVolume(_v, cb) { if (cb) cb(); }
  }
  return { lib: { Client, DefaultMediaReceiver: function DefaultMediaReceiver() {} }, made };
}

function withFakeCast(fn) {
  const { lib, made } = fakeCastLib();
  const resolved = require.resolve('castv2-client');
  const prior = require.cache[resolved];
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: lib };
  const castPath = require.resolve('../src/main/cast');
  delete require.cache[castPath];
  const cast = require('../src/main/cast')();
  const restore = () => {
    try { cast.teardown(); } catch (e) {}
    delete require.cache[castPath];
    if (prior) require.cache[resolved] = prior; else delete require.cache[resolved];
  };
  return Promise.resolve().then(() => fn(cast, made)).finally(restore);
}

const MEDIA = { url: 'http://192.168.1.2:5000/file/abc/film.mp4', contentType: 'video/mp4', title: 'Film', currentTime: 0 };
const loaded = (cast) => new Promise((resolve, reject) => cast.load('192.168.1.6', MEDIA, (e) => e ? reject(e) : resolve()));

test('the TV closing the Cast app ends the cast, once', () => withFakeCast(async (cast, made) => {
  const closed = [];
  cast.on('receiver-closed', (e) => closed.push(e));
  await loaded(cast);
  const p = made.players.at(-1);
  p.emit('status', { playerState: 'PLAYING', currentTime: 812, media: { contentId: MEDIA.url } });
  p.emit('close');
  assert.equal(closed.length, 1, 'the cast was told the receiver app closed');
  assert.equal(closed[0].at, 812, 'with the last position the TV reported, so local playback can resume there');
  assert.equal(made.clients.at(-1).closed, true, 'the dead session was torn down');
  p.emit('close');
  assert.equal(closed.length, 1, 'a second close from the same retired player says nothing');
}));

test('closing the session ourselves is not the TV closing it', () => withFakeCast(async (cast, made) => {
  const closed = [];
  cast.on('receiver-closed', (e) => closed.push(e));
  await loaded(cast);
  const p = made.players.at(-1);
  cast.stop();
  p.emit('close'); // what castv2-client emits when our own CLOSE goes out
  assert.deepEqual(closed, []);
}));

test('a close from a player a newer load replaced is ignored', () => withFakeCast(async (cast, made) => {
  const closed = [];
  cast.on('receiver-closed', (e) => closed.push(e));
  await loaded(cast);
  const old = made.players.at(-1);
  // A fresh load to another TV starts a new session; the old player is retired.
  await new Promise((resolve, reject) => cast.load('192.168.1.7', MEDIA, (e) => e ? reject(e) : resolve()));
  assert.notEqual(made.players.at(-1), old);
  old.emit('close');
  assert.deepEqual(closed, []);
}));

// Stop on the TV's remote ends the film on the TV with IDLE/CANCELLED, and the receiver closes the
// live pipe's socket. The stream-lost path then read that close as a Wi-Fi drop and re-cast the film
// the viewer had just stopped.
const { endedByViewer } = require('../src/main/cast-recovery');

test('a cast the viewer stopped on the TV is not recovered', () => {
  assert.equal(endedByViewer('CANCELLED'), true);
  // Every seek on the live pipe is our own LOAD over the session, and the item it replaces reports
  // INTERRUPTED. Treating that as the viewer leaving would end the cast on every seek.
  assert.equal(endedByViewer('INTERRUPTED'), false);
  assert.equal(endedByViewer('ERROR'), false, 'a receiver error is exactly what recovery is for');
  assert.equal(endedByViewer('FINISHED'), false, 'the end of the film has its own path');
  assert.equal(endedByViewer(null), false);
  assert.equal(endedByViewer(undefined), false);
});
