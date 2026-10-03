'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), vm = require('vm');
const source = fs.readFileSync(path.join(__dirname, '../src/main/lanserver.js'), 'utf8');
function fixture() {
  const ctx = {}; vm.createContext(ctx);
  vm.runInContext(source.slice(source.indexOf('  let subQueue ='), source.indexOf('  function serveMkvSub(')), ctx);
  return ctx;
}
test('subtitle queue bounds waiting work while preserving admitted order', () => {
  const ctx = fixture(), completed = [], ran = []; let release;
  assert.equal(ctx.enqueueSub(done => { release = done; }), true);
  for (let i = 0; i < 32; i++) assert.equal(ctx.enqueueSub(done => { ran.push(i); completed.push(done); }), true);
  assert.equal(ctx.enqueueSub(() => assert.fail('overflow ran')), false);
  release();
  for (let i = 0; i < 32; i++) { assert.equal(ran[i], i); completed[i](); }
  assert.equal(ran.length, 32);
});
test('clearing subtitle queue detaches retired work before abandonment callbacks', () => {
  const ctx = fixture(); let release, abandoned = 0, replacement = 0;
  ctx.enqueueSub(done => { release = done; });
  const retired = () => assert.fail('retired job ran');
  retired.abandon = () => { abandoned++; ctx.enqueueSub(done => { replacement++; done(); }); };
  ctx.enqueueSub(retired); ctx.clearSubQueue(); release();
  assert.equal(abandoned, 1); assert.equal(replacement, 1);
});

for (const event of ['aborted', 'close']) {
  test(`queued subtitle ${event} releases admission and disconnect listeners`, () => {
    const { EventEmitter } = require('events');
    const ctx = fixture(); let release, ran = 0;
    Object.assign(ctx, { mkvEntry: { token: 't', subs: [{ name: 's' }], subCache: {}, subActive: 's' }, safeStat: () => null, clog() {}, runSubExtract: (_req, _res, _token, _name, done) => { ran++; done(); } });
    vm.runInContext(source.slice(source.indexOf('  function serveMkvSub('), source.indexOf('  // A valid, cueless WebVTT')), ctx);
    ctx.enqueueSub(done => { release = done; });
    const req = new EventEmitter(), res = new EventEmitter();
    res.destroy = () => {}; res.writeHead = () => assert.fail('unexpected overflow'); res.end = () => {};
    ctx.serveMkvSub(req, res, 't', 's');
    (event === 'aborted' ? req : res).emit(event);
    assert.equal(req.listenerCount('aborted'), 0); assert.equal(res.listenerCount('close'), 0);
    for (let i = 0; i < 32; i++) assert.equal(ctx.enqueueSub(done => done()), true);
    release(); assert.equal(ran, 0);
  });
}

for (const active of ['s', 'other']) {
  test(`uncached subtitle HEAD with active track ${active} allocates no extraction`, () => {
    const ctx = fixture(); let status, body, ended = 0;
    Object.assign(ctx, { mkvEntry: { token: 't', subs: [{ name: 's' }], subCache: {}, subActive: active }, safeStat: () => null, clog() {}, runSubExtract: () => assert.fail('extraction allocated'), serveSubStub: () => assert.fail('body stub served') });
    vm.runInContext(source.slice(source.indexOf('  function serveMkvSub('), source.indexOf('  // A valid, cueless WebVTT')), ctx);
    ctx.serveMkvSub({ method: 'HEAD' }, { writeHead: (code, headers) => { status = code; assert.equal(headers['Content-Type'], 'text/vtt; charset=utf-8'); }, end: value => { ended++; body = value; } }, 't', 's');
    assert.equal(status, 200); assert.equal(ended, 1); assert.equal(body, undefined);
  });
}

test('duplicate subtitle queue completion cannot overlap later work', () => {
  const ctx = fixture(); let first, second, third = 0;
  ctx.enqueueSub(done => { first = done; });
  ctx.enqueueSub(done => { second = done; });
  ctx.enqueueSub(done => { third++; done(); });
  first(); first(); assert.equal(third, 0);
  second(); assert.equal(third, 1);
});
test('throwing subtitle job abandons its response and releases the queue', () => {
  const ctx = fixture(); let release, abandoned = 0, next = 0;
  ctx.enqueueSub(done => { release = done; });
  const failed = () => { throw Error('admission failed'); };
  failed.abandon = () => { abandoned++; throw Error('cleanup failed'); };
  ctx.enqueueSub(failed); ctx.enqueueSub(done => { next++; done(); });
  assert.doesNotThrow(release); assert.equal(abandoned, 1); assert.equal(next, 1);
});
test('throw after completed subtitle job cannot abandon completed work', () => {
  const ctx = fixture(); let abandoned = 0;
  const job = done => { done(); throw Error('late exception'); }; job.abandon = () => abandoned++;
  assert.equal(ctx.enqueueSub(job), true); assert.equal(abandoned, 0);
});
