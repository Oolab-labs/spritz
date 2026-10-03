'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const vm = require('vm');
const { EventEmitter } = require('events');
const source = fs.readFileSync(path.join(__dirname, '../src/main/lanserver.js'), 'utf8');
function fixture() {
  const files = new Map(), children = [], works = [], results = [];
  const sess = { dir: '/owned', subWaiters: new Map(), subProcs: new Map() };
  const ctx = { path, crypto, vod: sess, FFMPEG: 'ffmpeg', VTT_HEAD: 'WEBVTT\n\n', clog() {},
    safeStat: file => files.has(file), subExtractArgs: (_, __, work) => { works.push(work); return []; },
    fs: { unlinkSync: file => files.delete(file), readFileSync: file => files.get(file), writeFileSync: (file, body) => files.set(file, body) },
    spawn: () => { const child = new EventEmitter(); child.stderr = new EventEmitter(); children.push(child); return child; } };
  vm.createContext(ctx);
  const start = source.indexOf('  function ensureSub(');
  vm.runInContext(source.slice(start, source.indexOf('  // ---- transport epochs', start)) + '\nthis.run = ensureSub;', ctx);
  return { ctx, files, children, works, results, sess, request: () => ctx.run(sess, { base: 'eng', vtt: 'eng.vtt', idx: 1 }, value => results.push(value)) };
}
test('subtitle error plus late close cannot remove replacement work or settle its waiter', () => {
  const f = fixture(); f.request(); f.files.set(f.works[0], 'partial');
  f.children[0].emit('error', new Error('failed')); f.request();
  assert.notEqual(f.works[0], f.works[1]);
  f.files.set(f.works[1], 'WEBVTT\n\n00:00.000 --> 00:01.000\nText\n');
  f.children[0].emit('close', 0);
  assert.ok(f.files.has(f.works[1])); assert.equal(f.sess.subProcs.size, 1);
  assert.deepEqual(f.results, [false]);
  f.children[1].emit('close', 0); assert.deepEqual(f.results, [false, true]);
});
test('subtitle spawn failure releases waiters and work ownership', () => {
  const f = fixture(); f.ctx.spawn = () => { throw new Error('spawn failed'); };
  f.request(); assert.deepEqual(f.results, [false]); assert.equal(f.sess.subWaiters.size, 0);
});
