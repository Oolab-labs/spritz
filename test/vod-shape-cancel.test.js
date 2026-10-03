'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { EventEmitter } = require('events');
const source = fs.readFileSync(path.join(__dirname, '../src/main/lanserver.js'), 'utf8');
function fixture() {
  const children = [], results = [];
  const ctx = { FFPROBE: 'ffprobe', VOD_PROBE_TIMEOUT: 5000,
    keyframeArgs: () => [], parseKeyframes: () => [0, 1], spawn: () => {
      const child = new EventEmitter(); child.stdout = new EventEmitter();
      child.kills = 0; child.kill = () => { child.kills++; child.emit('close', 1); };
      children.push(child); return child;
    } };
  vm.createContext(ctx);
  vm.runInContext(source.slice(source.indexOf('  function probeVodShape('), source.indexOf('  // serveVod(input')) + '\nthis.run = probeVodShape;', ctx);
  const cancel = ctx.run('/movie', (result) => results.push(result));
  return { children, results, cancel };
}
test('cancelling duration probe kills it and never starts keyframe scanning', () => {
  const f = fixture(); f.children[0].stdout.emit('data', '20');
  f.cancel(); f.cancel(); f.children[0].emit('close', 0);
  assert.equal(f.children[0].kills, 1);
  assert.equal(f.children.length, 1);
  assert.equal(f.results.length, 0);
});
test('cancelling keyframe probe kills the current child and rejects late result', () => {
  const f = fixture(); f.children[0].stdout.emit('data', '20'); f.children[0].emit('close', 0);
  assert.equal(f.children.length, 2);
  f.cancel(); f.children[1].emit('close', 0);
  assert.equal(f.children[0].kills, 0);
  assert.equal(f.children[1].kills, 1);
  assert.equal(f.results.length, 0);
});
test('error then close completes once and never advances to another child', () => {
  const f = fixture(); f.children[0].stdout.emit('data', '20');
  f.children[0].emit('error', new Error('failed')); f.children[0].emit('close', 0);
  assert.equal(f.children.length, 1);
  assert.deepEqual(f.results, [null]);
});
test('successful shape completes once and completed cancellation does nothing', () => {
  const f = fixture(); f.children[0].stdout.emit('data', '20'); f.children[0].emit('close', 0);
  f.children[1].emit('close', 0); f.cancel();
  assert.equal(f.results.length, 1);
  assert.equal(f.results[0].dur, 20);
  assert.equal(f.children[1].kills, 0);
});
