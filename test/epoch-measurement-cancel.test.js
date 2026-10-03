'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { createEpochs } = require('../src/main/transport-epoch');
test('epoch retirement disposes shared timestamp probe once and rejects its late value', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spritz-epoch-measure-'));
  let finish, probes = 0, disposed = 0, settled = 0;
  const epochs = createEpochs({ root, ffmpeg: 'ffmpeg', spawn: () => {
    const child = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {}; return child;
  }, probeFirstPts: (_, cb) => { probes++; finish = cb; return () => disposed++; } });
  try {
    const e = epochs.open({ mediaId: 'movie', input: '/movie', logicalStart: 30 });
    epochs.noteFirstSegment(e.id, '/segment', () => settled++);
    epochs.noteFirstSegment(e.id, '/segment', () => { throw new Error('caller failed'); });
    epochs.noteFirstSegment(e.id, '/segment', () => settled++);
    assert.equal(probes, 1); epochs.retire(e.id);
    assert.equal(disposed, 1); assert.equal(settled, 2);
    finish(20); assert.equal(settled, 2); assert.equal(epochs.get(e.id), undefined);
  } finally { epochs.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('epoch spawn failure leaves a failed inspectable epoch and releases active state', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spritz-epoch-spawn-'));
  let calls = 0;
  const children = [];
  const epochs = createEpochs({ root, ffmpeg: 'ffmpeg', spawn: () => {
    if (++calls === 2) throw new Error('spawn unavailable');
    const child = new EventEmitter(); child.stderr = new EventEmitter();
    child.killed = 0; child.kill = () => child.killed++;
    children.push(child); return child;
  } });
  try {
    epochs.open({ mediaId: 'movie', input: '/movie' });
    assert.equal(epochs.active(), true);
    const failed = epochs.open({ mediaId: 'movie', input: '/movie', logicalStart: 30 });
    assert.equal(children[0].killed, 1);
    assert.equal(failed.state, 'failed');
    assert.equal(epochs.current().id, failed.id);
    assert.equal(epochs.current().running, false);
    assert.equal(epochs.active(), false);
    assert.ok(failed.endedAt);
  } finally { epochs.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('retirement during probe admission disposes the owner returned afterwards', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spritz-epoch-reentrant-'));
  let id, disposed = 0, settled = 0, epochs;
  epochs = createEpochs({ root, ffmpeg: 'ffmpeg', spawn: () => {
    const child = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {}; return child;
  }, probeFirstPts: () => {
    epochs.retire(id);
    return () => disposed++;
  } });
  try {
    id = epochs.open({ mediaId: 'movie', input: '/movie' }).id;
    epochs.noteFirstSegment(id, '/segment', () => settled++);
    assert.equal(settled, 1);
    assert.equal(disposed, 1);
    assert.equal(epochs.get(id), undefined);
    assert.equal(epochs.active(), false);
  } finally { epochs.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
