'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { waitForSubtitle } = require('../src/main/subtitle-ready-response');
test('standalone subtitle response waits for published cues instead of returning a stub', async () => {
  const response = new EventEmitter(); let state = 'pending'; const results = [];
  const done = new Promise(resolve => waitForSubtitle({ response, state: () => state, pollMs: 1, finish: result => { results.push(result); resolve(); } }));
  assert.deepEqual(results, []); state = 'ready'; await done;
  assert.deepEqual(results, ['ready']); assert.equal(response.listenerCount('close'), 0);
});
test('failed extraction, retired ownership and timeout do not become empty success', async () => {
  for (const state of ['failed', 'stale', 'pending']) {
    const response = new EventEmitter();
    const result = await new Promise(resolve => waitForSubtitle({ response, state: () => state, timeoutMs: 2, pollMs: 1, finish: resolve }));
    assert.equal(result, state === 'pending' ? 'timeout' : state);
  }
});
test('receiver disconnect cancels a pending subtitle response', async () => {
  const response = new EventEmitter(); let replied = false;
  waitForSubtitle({ response, state: () => 'pending', timeoutMs: 2, pollMs: 1, finish: () => { replied = true; } });
  response.emit('close'); await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(replied, false); assert.equal(response.listenerCount('close'), 0);
});
