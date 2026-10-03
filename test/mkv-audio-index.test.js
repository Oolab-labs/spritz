'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), vm = require('vm');
const source = fs.readFileSync(path.join(__dirname, '../src/main/lanserver.js'), 'utf8');
const start = source.indexOf('        const aN =');
const selection = source.slice(start, source.indexOf('        const token =', start));
test('MKV audio index only admits an in-range integer', () => {
  for (const input of [0.5, NaN, Infinity, -1, 2, '1', {}, 1]) {
    const ctx = { info: { audio: [{}, {}] }, opts: { audioTrack: input } }; vm.createContext(ctx);
    vm.runInContext(selection + '\nthis.selected = audioTrack;', ctx);
    assert.equal(ctx.selected, input === 1 ? 1 : 0);
  }
});
test('missing audio metadata safely selects the default index', () => {
  const ctx = { info: {}, opts: { audioTrack: 1 } }; vm.createContext(ctx);
  vm.runInContext(selection + '\nthis.selected = audioTrack;', ctx); assert.equal(ctx.selected, 0);
});
