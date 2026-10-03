'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const { EventEmitter } = require('events');
const source = fs.readFileSync(path.join(__dirname, '../src/main/lanserver.js'), 'utf8');
function fixture() {
  const children = [], results = [];
  const files = new Set(), works = [];
  const sess = { dir: '/owned', waiters: new Map(), procs: new Map(), segments: [{}] };
  const ctx = { vod: sess, crypto: require('crypto'), VOD_RUN_ENABLED: () => false, FFMPEG: 'ffmpeg', segmentArgs: args => { works.push(args.out); return []; },
    segmentPath: () => '/owned/0.ts', safeStat: file => files.has(file), touchSegment() {}, fs: { unlinkSync: file => files.delete(file), renameSync: (from, to) => { files.delete(from); files.add(to); } },
    spawn: () => { const child = new EventEmitter(); child.stderr = new EventEmitter(); children.push(child); return child; } };
  vm.createContext(ctx);
  const start = source.indexOf('  function ensureSegment(sess,');
  vm.runInContext(source.slice(start, source.indexOf('  // Prime the segments', start)) + '\nthis.run = ensureSegment;', ctx);
  return { ctx, children, sess, results, files, works, write: () => { files.add(works.at(-1)); }, request: () => ctx.run(sess, 0, null, value => results.push(value)) };
}
test('a partially written segment joins its producer rather than publishing early', () => {
  const f = fixture(); f.request(); f.write(); f.request();
  assert.deepEqual(f.results, []); assert.equal(f.children.length, 1);
  f.children[0].emit('close', 0); assert.deepEqual(f.results, [true, true]);
});
test('failed producer removes partial output and late close cannot finish a replacement', () => {
  const f = fixture(); f.request(); f.write();
  f.children[0].emit('error', new Error('failed'));
  assert.deepEqual(f.results, [false]);
  f.request(); assert.equal(f.children.length, 2);
  f.children[0].emit('close', 0);
  assert.equal(f.sess.procs.size, 1); assert.deepEqual(f.results, [false]);
  f.write(); f.children[1].emit('close', 0); assert.deepEqual(f.results, [false, true]);
});
test('synchronous segment spawn failure settles and removes its waiter', () => {
  const f = fixture(); f.ctx.spawn = () => { throw new Error('spawn failed'); };
  f.request(); assert.deepEqual(f.results, [false]);
  assert.equal(f.sess.waiters.size, 0); assert.equal(f.sess.procs.size, 0);
});


test('late failed writer cannot recreate a published cache entry', () => {
  const f = fixture(); f.request();
  f.children[0].emit('error', new Error('failed'));
  f.files.add(f.works[0]);
  f.children[0].emit('close', 0);
  assert.equal(f.files.size, 0);
  f.request(); assert.equal(f.children.length, 2);
});
