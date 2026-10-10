'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const root = process.env.SPRITZ_TEST_APP_ROOT || path.join(__dirname, '..');
const { createDiscoveryHealth } = require(path.join(root, 'src/main/discovery-health'));
const { describe } = require(path.join(root, 'src/renderer/discovery-status'));
function fixture(route = 'cast') {
  const pending = new Map(), events = []; let id = 0;
  const health = createDiscoveryHealth(route, state => events.push(state), {
    setTimeout(fn) { pending.set(++id, fn); return id; }, clearTimeout(id) { pending.delete(id); }
  });
  return { health, pending, events, finish() { [...pending.values()].forEach(fn => fn()); } };
}
test('closed ports and unreachable hosts never assert a permission denial', () => {
  const f = fixture(); f.health.start();
  for (const code of ['ECONNREFUSED', 'EHOSTUNREACH', 'ETIMEDOUT']) f.health.error({ code });
  f.finish(); assert.equal(f.health.snapshot().phase, 'empty');
  assert.doesNotMatch(describe(f.health.snapshot(), 'cast'), /permission|access refused/);
});
test('explicit access denial is visible without waiting for the deadline', () => {
  const f = fixture(); f.health.start(); f.health.error({ code: 'EACCES' });
  assert.equal(f.events.at(-1).phase, 'error');
  assert.match(describe(f.events.at(-1), 'cast'), /network access refused/); f.health.stop();
});
test('each route finishes independently and retry clears failures and the old deadline', () => {
  const cast = fixture(), dlna = fixture('dlna'); cast.health.start(); dlna.health.start();
  cast.health.found(1); dlna.health.reply(true); dlna.health.error({ code: 'ECONNREFUSED' }, true);
  cast.finish(); dlna.finish();
  assert.match(describe(cast.health.snapshot(), 'cast'), /1 TV found/);
  assert.match(describe(dlna.health.snapshot(), 'dlna'), /none offered video playback/);
  dlna.health.start(); const old = [...dlna.pending.keys()]; dlna.health.start();
  assert.ok(old.every(id => !dlna.pending.has(id))); assert.equal(dlna.pending.size, 1);
  const state = dlna.health.snapshot(); assert.equal(state.attempt, 3); assert.equal(state.cachedFailures, 0);
  state.errors.INJECTED = 1; assert.deepEqual(dlna.health.snapshot().errors, {});
  dlna.health.stop(); assert.equal(dlna.pending.size, 0);
});
