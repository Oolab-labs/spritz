'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), vm = require('vm'), { EventEmitter } = require('events');
const source = fs.readFileSync(path.join(__dirname, '../src/main/lanserver.js'), 'utf8');
function fixture() {
  const children = []; let lost = 0;
  const ctx = { mkvEntry: { token: 't', startSec: 0, livePos: 0, dur: 100 }, mkvProc: null, mkvRes: null, clog() {}, MKV_MIME: 'video/x-matroska', resumePosition: () => 0, resolveOrigin: (e, from, cb) => cb(0), mkvArgs: () => [], FFMPEG: 'controlled', Date, classifyFailure: () => 'source', shouldRetryInSoftware: () => false, onCastStreamLost: () => lost++, spawn: () => {
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdout.pipe = () => {}; child.unpipes = 0; child.stdout.unpipe = () => child.unpipes++; child.kills = 0; child.kill = () => child.kills++; children.push(child); return child;
  } };
  vm.createContext(ctx); vm.runInContext(source.slice(source.indexOf('  function serveMkvStream('), source.indexOf('  // Remux `src`')), ctx);
  const connect = () => { const req = new EventEmitter(), res = new EventEmitter(); req.method = 'GET'; res.writeHead = () => {}; res.end = () => {}; res.destroy = () => res.emit('close'); ctx.serveMkvStream(req, res, 't'); return { req, res }; };
  return { ctx, children, connect, lost: () => lost };
}
test('old MKV response cannot kill a replacement stream on late disconnect', () => {
  const f = fixture(), old = f.connect(), fresh = f.connect();
  assert.equal(f.children[0].kills, 1);
  old.req.emit('aborted'); old.res.emit('close'); old.res.emit('error', Error('late'));
  assert.equal(f.children[1].kills, 0); assert.equal(f.ctx.mkvRes, fresh.res);
  assert.equal(f.lost(), 0);
});
test('normal MKV request close preserves streaming while response disconnect retires once', () => {
  const f = fixture(), current = f.connect(); current.req.emit('close');
  assert.equal(f.children[0].kills, 0);
  current.res.emit('close'); current.req.emit('aborted');
  assert.equal(f.children[0].kills, 1); assert.equal(f.lost(), 1);
  assert.equal(f.ctx.mkvProc, null); assert.equal(f.ctx.mkvRes, null);
});

test('MKV synchronous spawn failure closes its response without escaping', () => {
  const f = fixture(); f.ctx.spawn = () => { throw Error('launch failed'); };
  assert.doesNotThrow(() => f.connect()); assert.equal(f.ctx.mkvRes, null); assert.equal(f.ctx.mkvProc, null);
});
for (const emitter of ['child', 'stdout', 'stderr']) {
  test(`MKV ${emitter} error kills the owned producer and ignores late delivery`, () => {
    const f = fixture(); f.connect(); const child = f.children[0];
    const target = emitter === 'child' ? child : child[emitter];
    target.emit('error', Error('failed')); target.emit('error', Error('late')); child.emit('close', 0);
    assert.equal(child.kills, 1); assert.equal(f.ctx.mkvRes, null); assert.equal(f.ctx.mkvProc, null);
  });
}

test('retired encoder output is detached before retry and cannot alter retry status', () => {
  const f = fixture(), tails = [];
  f.ctx.shouldRetryInSoftware = tail => { tails.push(tail); return tail === 'encoder failed'; };
  f.connect(); const old = f.children[0];
  old.stderr.emit('data', Buffer.from('encoder failed')); old.emit('error', Error('failed'));
  assert.equal(f.children.length, 2); assert.equal(old.unpipes, 1);
  old.stdout.emit('data', Buffer.from('late bytes')); old.stderr.emit('data', Buffer.from('late error'));
  assert.equal(f.ctx.mkvEntry.servedOnce, undefined);
  const fresh = f.children[1]; fresh.stdout.emit('data', Buffer.from('fresh bytes'));
  assert.equal(f.ctx.mkvEntry.servedOnce, true);
  old.emit('close', 1); assert.equal(f.ctx.mkvProc, fresh);
  fresh.emit('close', 0); assert.equal(f.ctx.mkvProc, null);
  assert.deepEqual(tails, ['encoder failed']);
});

test('MKV HEAD returns headers without superseding active playback', () => {
  const f = fixture(), active = f.connect(), req = new EventEmitter(); req.method = 'HEAD';
  let status, ended = 0;
  const res = { writeHead: code => { status = code; }, end: () => ended++ };
  f.ctx.serveMkvStream(req, res, 't');
  assert.equal(status, 200); assert.equal(ended, 1);
  assert.equal(f.children.length, 1); assert.equal(f.children[0].kills, 0);
  assert.equal(f.ctx.mkvRes, active.res); assert.equal(f.ctx.mkvProc, f.children[0]);
});
test('MKV HEAD with stale token returns 404 without touching active playback', () => {
  const f = fixture(), active = f.connect(); let status;
  f.ctx.serveMkvStream({ method: 'HEAD' }, { writeHead: code => { status = code; }, end() {} }, 'stale');
  assert.equal(status, 404); assert.equal(f.children[0].kills, 0); assert.equal(f.ctx.mkvRes, active.res);
});

test('real MKV HTTP stream survives request completion and retires on client disconnect', { timeout: 10000 }, async t => {
  const http = require('http'), { spawn } = require('child_process'), { once } = require('events');
  const f = fixture(); let child, closed = false, request, response;
  f.ctx.spawn = () => {
    child = spawn(process.execPath, ['-e', 'process.stdout.write("stream bytes"); setInterval(() => {}, 1000);']);
    child.once('close', () => { closed = true; }); return child;
  };
  const server = http.createServer((req, res) => f.ctx.serveMkvStream(req, res, 't'));
  t.after(async () => {
    if (response) response.destroy(); if (request) request.destroy();
    if (child && !closed) { const end = once(child, 'close'); child.kill('SIGKILL'); await end; }
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  request = http.get({ host: '127.0.0.1', port: server.address().port, path: '/mkv' });
  request.on('error', () => {}); [response] = await once(request, 'response');
  const [bytes] = await once(response, 'data'); assert.equal(bytes.toString(), 'stream bytes');
  assert.equal(f.lost(), 0); assert.equal(closed, false); assert.equal(f.ctx.mkvProc, child);
  const headers = await new Promise((resolve, reject) => {
    const head = http.request({ host: '127.0.0.1', port: server.address().port, path: '/mkv', method: 'HEAD' }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    head.on('error', reject); head.end();
  });
  assert.equal(headers, 200); assert.equal(closed, false); assert.equal(f.ctx.mkvProc, child);
  const end = once(child, 'close'); response.destroy(); request.destroy();
  const [code, signal] = await end; assert.equal(code, null); assert.equal(signal, 'SIGKILL');
  assert.throws(() => process.kill(child.pid, 0), e => e.code === 'ESRCH');
  assert.equal(f.lost(), 1); assert.equal(f.ctx.mkvProc, null); assert.equal(f.ctx.mkvRes, null);
});

test('MKV replacement detaches producer before synchronous termination callbacks', () => {
  const f = fixture(); f.connect(); const old = f.children[0];
  old.kill = () => { old.kills++; old.emit('close', 0); };
  const fresh = f.connect();
  assert.equal(old.kills, 1); assert.equal(f.children.length, 2);
  assert.equal(f.ctx.mkvProc, f.children[1]); assert.equal(f.ctx.mkvRes, fresh.res);
});
test('MKV cleanup admitting a newer request prevents the intermediate launch', () => {
  const f = fixture(); f.connect(); const old = f.children[0]; let latest;
  old.kill = () => { old.kills++; latest = f.connect(); };
  f.connect();
  assert.equal(old.kills, 1); assert.equal(f.children.length, 2);
  assert.equal(f.ctx.mkvRes, latest.res); assert.equal(f.ctx.mkvProc, f.children[1]);
});

test('MKV retry cannot launch after unpipe retires the response', () => {
  const f = fixture(), current = f.connect(); f.ctx.shouldRetryInSoftware = () => true;
  const child = f.children[0]; child.stdout.unpipe = () => current.res.emit('close');
  child.stderr.emit('data', Buffer.from('encoder failed')); child.emit('error', Error('failed'));
  assert.equal(f.children.length, 1); assert.equal(child.kills, 1);
  assert.equal(f.ctx.mkvRes, null); assert.equal(f.ctx.mkvProc, null);
});
test('MKV retry cannot launch for a retired cast entry', () => {
  const f = fixture(); f.connect(); f.ctx.shouldRetryInSoftware = () => true;
  const child = f.children[0]; child.stdout.unpipe = () => { f.ctx.mkvEntry = null; };
  child.emit('error', Error('failed'));
  assert.equal(f.children.length, 1); assert.equal(child.kills, 1);
});
