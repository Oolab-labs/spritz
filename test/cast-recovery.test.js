'use strict';
// The budget that ended a 63-minute episode four minutes in. Every recovery had WORKED — the playhead
// advanced 104s → 117s → 217s → 248s → 288s — but the counter was a lifetime cap, so the fourth drop
// was refused and the session died. These pin the distinction the cap failed to make: a LOOP (dense
// in time, hopeless) versus INTERMITTENT drops across a long film (sparse, and recovering fine).
const test = require('node:test');
const assert = require('node:assert');
const { allowRecovery, refund, fresh, MAX_IN_WINDOW, WINDOW_MS } = require('../src/main/cast-recovery');

const T = 1_000_000_000; // an arbitrary epoch base

test('a fresh cast may recover', () => {
  const r = allowRecovery(fresh(), T);
  assert.strictEqual(r.allow, true);
  assert.strictEqual(r.state.used, 1);
});

test('a tight loop is still stopped after the cap', () => {
  let s = fresh();
  for (let i = 0; i < MAX_IN_WINDOW; i++) {
    const r = allowRecovery(s, T + i * 1000);
    assert.strictEqual(r.allow, true, 'attempt ' + (i + 1) + ' should be allowed');
    s = r.state;
  }
  const denied = allowRecovery(s, T + MAX_IN_WINDOW * 1000);
  assert.strictEqual(denied.allow, false);
  assert.match(denied.reason, /already retried/);
});

test('surviving the window refills the budget — the real-world case that failed', () => {
  let s = fresh();
  for (let i = 0; i < MAX_IN_WINDOW; i++) s = allowRecovery(s, T + i * 1000).state;
  assert.strictEqual(allowRecovery(s, T + 3000).allow, false, 'exhausted inside the window');
  // …the film then plays happily for twenty minutes and drops once more.
  const later = allowRecovery(s, T + 20 * 60 * 1000);
  assert.strictEqual(later.allow, true);
  assert.strictEqual(later.state.used, 1, 'the counter restarted, not continued');
  assert.match(later.reason, /refilled/);
});

test('the refill boundary is the window, exactly', () => {
  let s = fresh();
  for (let i = 0; i < MAX_IN_WINDOW; i++) s = allowRecovery(s, T).state;
  assert.strictEqual(allowRecovery(s, T + WINDOW_MS - 1).allow, false, 'one ms early is still spent');
  assert.strictEqual(allowRecovery(s, T + WINDOW_MS).allow, true, 'at the window it refills');
});

test('a self-healed stream is refunded, so it never counts against the source', () => {
  const r = allowRecovery(fresh(), T);
  assert.strictEqual(r.state.used, 1);
  assert.strictEqual(refund(r.state).used, 0);
});

test('a refund cannot go negative and bank credit', () => {
  assert.strictEqual(refund({ used: 0, lastAt: T }).used, 0);
  assert.strictEqual(refund(fresh()).used, 0);
});

test('three drops an hour apart never exhaust the budget', () => {
  let s = fresh();
  for (let hour = 0; hour < 3; hour++) {
    const r = allowRecovery(s, T + hour * 3600 * 1000);
    assert.strictEqual(r.allow, true, 'drop at hour ' + hour + ' should be allowed');
    assert.strictEqual(r.state.used, 1);
    s = r.state;
  }
});

test('missing or malformed state is treated as fresh rather than throwing', () => {
  assert.strictEqual(allowRecovery(null, T).allow, true);
  assert.strictEqual(allowRecovery(undefined, T).allow, true);
  assert.strictEqual(allowRecovery({}, T).allow, true);
});

test('the window and cap are overridable, and the reason says which window applied', () => {
  let s = fresh();
  s = allowRecovery(s, T, { max: 1, windowMs: 5000 }).state;
  const denied = allowRecovery(s, T + 1000, { max: 1, windowMs: 5000 });
  assert.strictEqual(denied.allow, false);
  assert.match(denied.reason, /5s/);
  assert.strictEqual(allowRecovery(s, T + 5000, { max: 1, windowMs: 5000 }).allow, true);
});
