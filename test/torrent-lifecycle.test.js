'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { createRequire } = require('module');
const { EventEmitter } = require('events');
const filename = path.join(__dirname, '../src/main/torrent.js');
const localRequire = createRequire(filename);
const source = fs.readFileSync(filename, 'utf8');
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
function fixture(t, options = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'spritz-torrent-test-'));
  const clients = [], events = [], timers = new Map(); let seq = 0;
  class Client extends EventEmitter {
    constructor() { super(); this.torrents = []; clients.push(this); }
    add(src, opts, ready) {
      const tor = new EventEmitter();
      Object.assign(tor, { src, opts, name: src, infoHash: 'same-hash', downloaded: 0, numPeers: 1,
        pieceLength: 4194304, bitfield: { get: () => false }, downloadSpeed: 0, files: [],
        critical() {}, select() {}, ready: () => ready(tor),
        destroy: (o, cb) => { tor.destroyed = true; tor.retire = cb; } });
      tor.files = ['A.mkv', 'B.mkv'].map((name, i) => ({ name, path: name, length: 20 * 1024 * 1024,
        offset: i * 20 * 1024 * 1024, _startPiece: i * 5, _endPiece: i * 5 + 4,
        select() {}, deselect() {} }));
      this.torrents.push(tor); return tor;
    }
    createServer() {
      const socket = new EventEmitter(); socket.listening = false;
      socket.listen = () => { socket.listening = !options.holdBind; };
      socket.address = () => ({ port: 23456 });
      const server = { server: socket, close: () => { socket.closed = true; } };
      this.server = server; return server;
    }
    destroy() { this.destroyed = true; }
  }
  const context = { module: { exports: {} }, Buffer, process: { env: {} }, console: { log() {}, warn() {}, error() {} },
    require: (n) => n === 'electron' ? { app: { getPath: () => temp } } : localRequire(n),
    setTimeout: (fn, ms) => { timers.set(++seq, { fn, ms }); return seq; }, clearTimeout: (id) => timers.delete(id),
    setInterval: (fn, ms) => { timers.set(++seq, { fn, ms, interval: true }); return seq; }, clearInterval: (id) => timers.delete(id) };
  vm.runInNewContext(source, context, { filename });
  const create = () => context.module.exports((type, payload) => events.push({ type, payload }),
    { loadWebTorrent: options.loader || (async () => ({ default: Client })) });
  const torrent = create();
  t.after(() => { torrent.teardown(); fs.rmSync(temp, { recursive: true, force: true }); });
  return { temp, torrent, create, Client, clients, events, timers };
}
test('Cancel and teardown invalidate import admission before a client is allocated', async (t) => {
  const hold = deferred(), f = fixture(t, { loader: () => hold.promise });
  const add = f.torrent.add('A'); f.torrent.cancel(); hold.resolve({ default: f.Client }); await add;
  assert.equal(f.clients.length, 0); assert.equal(f.events.length, 0);
  const h = deferred(), g = fixture(t, { loader: () => h.promise });
  const pending = g.torrent.add('B'); g.torrent.teardown(); h.resolve({ default: g.Client }); await pending;
  assert.equal(g.clients.length, 0); assert.equal(g.timers.size, 0);
});
test('last add wins when shared import completes; old failure does not publish', async (t) => {
  const hold = deferred(), f = fixture(t, { loader: () => hold.promise });
  const a = f.torrent.add('A'), b = f.torrent.add('B'); hold.resolve({ default: f.Client }); await Promise.all([a, b]);
  assert.equal(f.clients.length, 1); assert.deepEqual(f.clients[0].torrents.map((x) => x.src), ['B']);
  const failed = deferred(), g = fixture(t, { loader: () => failed.promise });
  const pending = g.torrent.add('A'); g.torrent.cancel(); failed.reject(new Error('late import failure')); await pending;
  assert.equal(g.events.length, 0);
});
test('retired metadata, errors and timers cannot change the current torrent', async (t) => {
  const f = fixture(t); await f.torrent.add('A'); const a = f.clients[0].torrents[0];
  const oldDeadline = [...f.timers.values()][0].fn;
  await f.torrent.add('B'); const b = f.clients[0].torrents[1];
  a.ready(); a.emit('error', new Error('old')); oldDeadline();
  assert.equal(f.events.length, 0); assert.equal(b.destroyed, undefined);
  b.ready(); assert.equal(f.events.filter((x) => x.type === 'torrent:metadata').length, 1);
  assert.equal(f.events[0].payload.name, 'B');
});
test('storage is unique per generation and instance; delayed retirement preserves replacement', async (t) => {
  const f = fixture(t); await f.torrent.add('same'); const a = f.clients[0].torrents[0];
  fs.writeFileSync(path.join(a.opts.path, 'movie.bin'), 'AAAA');
  await f.torrent.add('same'); const b = f.clients[0].torrents[1];
  fs.writeFileSync(path.join(b.opts.path, 'movie.bin'), 'BBBB');
  assert.notEqual(a.opts.path, b.opts.path); a.retire();
  assert.equal(fs.existsSync(a.opts.path), false);
  assert.equal(fs.readFileSync(path.join(b.opts.path, 'movie.bin'), 'utf8'), 'BBBB');
  const other = f.create(); t.after(() => other.teardown());
  await other.add('same'); const c = f.clients[1].torrents[0];
  fs.writeFileSync(path.join(c.opts.path, 'movie.bin'), 'CCCC');
  f.torrent.teardown(); b.retire();
  assert.equal(fs.readFileSync(path.join(c.opts.path, 'movie.bin'), 'utf8'), 'CCCC');
  other.cancel(); c.retire();
});
test('failed retirement retains owned files and cannot delete replacement', async (t) => {
  const f = fixture(t); await f.torrent.add('A'); const a = f.clients[0].torrents[0];
  fs.writeFileSync(path.join(a.opts.path, 'movie.bin'), 'AAAA');
  await f.torrent.add('B'); const b = f.clients[0].torrents[1]; a.retire(new Error('close failed'));
  f.torrent.teardown(); b.retire();
  assert.equal(fs.readFileSync(path.join(a.opts.path, 'movie.bin'), 'utf8'), 'AAAA');
});
test('Cancel removes pending bind continuations and prebuffer checks', async (t) => {
  const f = fixture(t, { holdBind: true }); await f.torrent.add('A'); const c = f.clients[0];
  c.torrents[0].ready(); f.torrent.selectFile(0);
  assert.equal(c.server.server.listenerCount('listening'), 1);
  f.torrent.cancel(); assert.equal(c.server.server.listenerCount('listening'), 0);
  c.server.server.emit('listening'); assert.equal(f.events.some((e) => e.type === 'torrent:ready'), false);
  const g = fixture(t); await g.torrent.add('A'); g.clients[0].torrents[0].ready(); g.torrent.selectFile(0);
  const pending = [...g.timers.values()].find((v) => v.ms === 300).fn;
  g.torrent.cancel(); assert.equal(g.timers.size, 0); pending();
  assert.equal(g.events.some((e) => e.type === 'torrent:ready'), false);
});
test('reselecting while binding leaves only the latest file continuation', async (t) => {
  const f = fixture(t, { holdBind: true }); await f.torrent.add('A'); const c = f.clients[0]; c.torrents[0].ready();
  f.torrent.selectFile(0); f.torrent.selectFile(1);
  assert.equal(c.server.server.listenerCount('listening'), 1);
  c.torrents[0].bitfield.get = () => true; c.server.server.listening = true; c.server.server.emit('listening');
  const ready = f.events.filter((e) => e.type === 'torrent:ready');
  assert.equal(ready.length, 1); assert.match(ready[0].payload.url, /B\.mkv$/);
});

test('Cancel destroys a blocked index reader and retires seek polls without late publication', async (t) => {
  const f = fixture(t); await f.torrent.add('A'); const tor = f.clients[0].torrents[0]; tor.ready();
  const streams = []; tor.files[0].name = 'A.mp4';
  tor.files[0].createReadStream = () => {
    const s = new EventEmitter(); s.destroy = () => { s.destroyed = true; s.emit('close'); }; streams.push(s); return s;
  };
  f.torrent.selectFile(0); let callbacks = 0;
  f.torrent.ensureIndexForCast(() => callbacks++);
  f.torrent.ensureBytes(4194304, () => callbacks++);
  assert.equal(streams.length, 1);
  assert.ok([...f.timers.values()].some((x) => x.ms === 200));
  f.torrent.cancel();
  assert.equal(streams[0].destroyed, true); assert.equal(f.timers.size, 0);
  streams[0].emit('end'); await new Promise((r) => setImmediate(r));
  assert.equal(callbacks, 0);
});

test('normal completed index read still resolves and drains its timeout', async (t) => {
  const f = fixture(t); await f.torrent.add('A'); const tor = f.clients[0].torrents[0]; tor.ready();
  tor.files[0].name = 'A.mp4';
  tor.files[0].createReadStream = () => {
    const s = new EventEmitter(); s.destroy = () => {};
    queueMicrotask(() => { const header = Buffer.alloc(16); header.writeUInt32BE(16); header.write('moov', 4); s.emit('data', header); s.emit('end'); s.emit('close'); });
    return s;
  };
  f.torrent.selectFile(0);
  await new Promise((r) => f.torrent.ensureIndexForCast(r));
  assert.equal([...f.timers.values()].some((x) => x.ms === 30000), false);
});

test('real chunk-store deletion after delayed close cannot unlink a replacement session file', async (t) => {
  const { default: Storage } = await import('fs-chunk-store');
  const f = fixture(t); await f.torrent.add('same'); const a = f.clients[0].torrents[0];
  const old = new Storage(4, { path: a.opts.path, files: [{ path: 'movie.bin', length: 4 }] });
  const put = (s, data) => new Promise((resolve, reject) => s.put(0, Buffer.from(data), (err) => err ? reject(err) : resolve()));
  await put(old, 'AAAA');
  const closed = deferred(); let release;
  const close = old.close.bind(old);
  old.close = (cb) => close(() => { release = cb; closed.resolve(); });
  a.destroy = (opts, done) => old.destroy(done);
  await f.torrent.add('same'); await closed.promise;
  const b = f.clients[0].torrents[1];
  const replacement = new Storage(4, { path: b.opts.path, files: [{ path: 'movie.bin', length: 4 }] });
  try {
    await put(replacement, 'BBBB');
    release(); release = null;
    // Await the old store's actual deletion and production retirement cleanup.
    await new Promise((resolve, reject) => {
      const deadline = Date.now() + 2000;
      const check = () => {
        if (!fs.existsSync(a.opts.path)) return resolve();
        if (Date.now() > deadline) return reject(new Error('retirement did not finish'));
        setTimeout(check, 5);
      };
      check();
    });
    assert.equal(fs.readFileSync(path.join(b.opts.path, 'movie.bin'), 'utf8'), 'BBBB');
  } finally {
    if (release) release();
    await new Promise((resolve) => replacement.close(resolve));
  }
});


test('repeated metadata readiness cannot orphan progress or stall timers', async (t) => {
  const f = fixture(t); await f.torrent.add('A');
  const tor = f.clients[0].torrents[0];
  tor.ready(); const count = f.timers.size;
  tor.ready(); tor.ready();
  assert.equal(f.events.filter(e => e.type === 'torrent:metadata').length, 1);
  assert.equal(f.timers.size, count);
  f.torrent.cancel(); assert.equal(f.timers.size, 0);
});
test('disk-backed torrent disables duplicate whole-piece read cache', async t => {
  const f = fixture(t); await f.torrent.add('A');
  assert.equal(f.clients[0].torrents[0].opts.storeCacheSlots, 0);
  assert.equal(fs.existsSync(f.clients[0].torrents[0].opts.path), true);
});
