'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createCriticalAim } = require('../src/main/critical-aim');
function fixture() {
  let now = 1;
  const aim = createCriticalAim({ now: () => now });
  const file = { length: 1000000, _startPiece: 0, _endPiece: 999 };
  const t = { pieceLength: 1000, _critical: [], critical() {} };
  aim.setPlayhead(0.4, 1000);
  const state = () => { aim.refresh(t, file); return aim.state(); };
  const read = (lease, position, event = 'progress') => lease.noteSourceRead({ reader: 'producer', event, position });
  return { aim, state, read, advance: () => { now += 60000; } };
}
test('new candidate owns urgency despite late rollback reads; disposal restores rollback', () => {
  const f = fixture(), old = f.aim.registerProducer(), candidate = f.aim.registerProducer();
  old.setActive(true); f.read(old, 10000); candidate.setActive(true); f.read(candidate, 700000);
  f.read(old, 20000);
  assert.equal(f.state().decision.byteStart, 700000);
  old.setActive(false); assert.equal(f.state().decision.byteStart, 700000);
  old.setActive(true); candidate.dispose(); assert.equal(f.state().decision.byteStart, 20000);
  candidate.setActive(true); f.read(candidate, 900000); assert.equal(f.state().decision.byteStart, 20000);
});
test('blocked owned producer keeps urgency until explicit lifecycle ends', () => {
  const f = fixture(), p = f.aim.registerProducer(); p.setActive(true); f.read(p, 20000);
  f.advance(); assert.equal(f.state().decision.source, 'producer');
  f.read(p, 900000, 'close'); assert.equal(f.state().decision.byteStart, 20000);
  p.setActive(false); assert.equal(f.state().decision.source, 'viewer');
});
test('new source reset rejects old lifecycle and source read callbacks', () => {
  const f = fixture(), p = f.aim.registerProducer(); p.setActive(true); f.read(p, 20000);
  f.aim.reset(); f.aim.setPlayhead(0.1, 1000); p.setActive(true); f.read(p, 900000);
  assert.equal(f.state().decision.source, 'viewer'); assert.equal(f.state().decision.byteStart, 100000);
});
test('unobserved new candidate preserves prior demand and never changes viewer position', () => {
  const f = fixture(), p = f.aim.registerProducer(); p.setActive(true);
  assert.equal(f.state().decision.byteStart, 400000);
  f.read(p, 0, 'open'); assert.equal(f.state().decision.byteStart, 0);
  assert.equal(f.aim.viewerFrac(), 0.4);
  p.dispose(); assert.equal(f.state().decision.byteStart, 400000);
});
