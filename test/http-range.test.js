'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { byteRange } = require('../src/main/http-range');

test('HEAD ignores Range and empty representations never create negative offsets', () => {
  assert.deepEqual(byteRange('bytes=0-2', 10, 'HEAD'), { kind: 'full' });
  assert.deepEqual(byteRange(undefined, 0), { kind: 'full' });
  assert.deepEqual(byteRange('bytes=0-', 0), { kind: 'unsatisfiable' });
});

test('byte offsets clamp without losing precision on unbounded decimal fields', () => {
  assert.deepEqual(byteRange('bytes=2-999999999999999999999', 10),
    { kind: 'partial', start: 2, end: 9 });
  assert.deepEqual(byteRange('bytes=8-2', 10), { kind: 'unsatisfiable' });
  for (const header of ['bytes=-', 'bytes=1-x', 'bytes=0-2,4-5', 'items=0-2']) {
    assert.deepEqual(byteRange(header, 10), { kind: 'full' });
  }
});
