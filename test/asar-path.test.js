'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { unpackedPath } = require('../src/main/asar-path');

test('paths inside app.asar are redirected to app.asar.unpacked (native code cannot read an asar)', () => {
  assert.strictEqual(unpackedPath('/A/Spritz.app/Contents/Resources/app.asar/vendor/shaders/anime4k'),
    '/A/Spritz.app/Contents/Resources/app.asar.unpacked/vendor/shaders/anime4k');
});

test('development paths and already-unpacked paths are untouched', () => {
  assert.strictEqual(unpackedPath('/Users/x/spritz/vendor/shaders'), '/Users/x/spritz/vendor/shaders');
  assert.strictEqual(unpackedPath('/R/app.asar.unpacked/vendor'), '/R/app.asar.unpacked/vendor');
});
