'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), vm = require('vm');
const source = fs.readFileSync(path.join(__dirname, '../src/renderer/renderer.js'), 'utf8');
test('poster queue serializes requests and skips retired queued cards', async () => {
  const pending = [], calls = [], nodes = [];
  const element = () => ({ style: {}, isConnected: true, classList: { add() {}, remove() {} }, appendChild() {}, setAttribute() {}, addEventListener() {}, replaceChild() {} });
  const ctx = { continueWatching: element(), cwRow: element(), titleFromSrc: s => s, routeSource() {},
    document: { createElement: () => { const n = element(); nodes.push(n); return n; } },
    soda: { history: { recents: async () => [{ src: '/a', pos: 10, dur: 100 }, { src: '/b', pos: 10, dur: 100 }, { src: '/c', pos: 10, dur: 100 }] },
      thumbAt: src => { calls.push(src); return new Promise(r => pending.push(r)); } } };
  vm.createContext(ctx);
  vm.runInContext(source.slice(source.indexOf('let continueWatchingRevision ='), source.indexOf('// ---- SponsorBlock')) + '\nthis.render = renderContinueWatching;', ctx);
  await ctx.render(); await new Promise(setImmediate); assert.deepEqual(calls, ['/a']);
  pending[0](null); await new Promise(setImmediate); assert.deepEqual(calls, ['/a', '/b']);
  ctx.soda.history.recents = async () => [];
  await ctx.render(); pending[1](null); await new Promise(setImmediate);
  assert.deepEqual(calls, ['/a', '/b']);
});

test('failed poster request does not stall remaining cards', async () => {
  const calls = [], appended = [];
  const element = () => ({ style: {}, isConnected: true, classList: { add() {}, remove() {} }, appendChild() {}, setAttribute() {}, addEventListener() {}, replaceChild() {} });
  const row = element(); row.appendChild = card => appended.push(card);
  const ctx = { continueWatching: element(), cwRow: row, titleFromSrc: s => s, routeSource() {},
    document: { createElement: element }, soda: {
      history: { recents: async () => [{ src: '/a', pos: 10, dur: 100 }, { src: '/b', pos: 10, dur: 100 }] },
      thumbAt: async src => { calls.push(src); if (src === '/a') throw new Error('controlled'); return null; } } };
  vm.createContext(ctx);
  vm.runInContext(source.slice(source.indexOf('let continueWatchingRevision ='), source.indexOf('// ---- SponsorBlock')) + '\nthis.render = renderContinueWatching;', ctx);
  await ctx.render(); await new Promise(setImmediate);
  assert.equal(appended.length, 2); assert.deepEqual(calls, ['/a', '/b']);
});

test('older history response cannot replace newer Continue Watching cards', async () => {
  const pending = [], cards = [];
  const element = () => ({ style: {}, isConnected: true, classList: { add() {}, remove() {} }, appendChild() {}, setAttribute() {}, addEventListener() {} });
  const row = element(); row.appendChild = card => cards.push(card);
  const ctx = { continueWatching: element(), cwRow: row, titleFromSrc: s => s, routeSource() {},
    document: { createElement: element }, soda: { history: { recents: () => new Promise(resolve => pending.push(resolve)) } } };
  vm.createContext(ctx);
  vm.runInContext(source.slice(source.indexOf('let continueWatchingRevision ='), source.indexOf('// ---- SponsorBlock')) + '\nthis.render = renderContinueWatching;', ctx);
  const old = ctx.render(), fresh = ctx.render();
  pending[1]([{ src: 'https://fresh', pos: 10, dur: 100 }]); await fresh;
  pending[0]([{ src: 'https://old', pos: 10, dur: 100 }]); await old;
  assert.equal(cards.length, 1);
});
