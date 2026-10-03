'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), vm = require('vm');
const source = fs.readFileSync(path.join(__dirname, '../src/main/lanserver.js'), 'utf8');
test('MKV retirement detaches old resources before reentrant replacement callbacks', () => {
  const removed = [], killed = [], ctx = { mkvPreparation: null, mkvGeneration: 0, clog() {}, fs: { unlinkSync: file => removed.push(file) } };
  const replacement = { subCache: { s: '/new' } }, newProc = { kill: () => assert.fail('replacement killed') }, newRes = { destroy: () => assert.fail('replacement destroyed') };
  ctx.mkvProc = { kill: () => killed.push('stream') };
  ctx.mkvRes = { destroy: () => killed.push('response') };
  ctx.mkvEntry = { subCache: { s: '/old' } };
  ctx.mkvSubProcs = [{ kill: () => killed.push('subtitle') }];
  ctx.clearSubQueue = () => {
    assert.equal(ctx.mkvEntry, null); assert.equal(ctx.mkvProc, null);
    ctx.mkvEntry = replacement; ctx.mkvProc = newProc; ctx.mkvRes = newRes; ctx.mkvSubProcs = [newProc];
  };
  vm.createContext(ctx); vm.runInContext(source.slice(source.indexOf('  function cancelMkv(why'), source.indexOf('  // Build the single-stream ffmpeg args')), ctx);
  ctx.cancelMkv('test');
  assert.deepEqual(killed, ['stream', 'subtitle', 'response']); assert.deepEqual(removed, ['/old']);
  assert.equal(ctx.mkvEntry, replacement); assert.equal(ctx.mkvProc, newProc); assert.equal(ctx.mkvRes, newRes);
  assert.equal(ctx.mkvSubProcs[0], newProc);
});
