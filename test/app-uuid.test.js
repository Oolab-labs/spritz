'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { execFileSync } = require('child_process');
test('packaged Spritz has an executable UUID distinct from unbranded Electron', { skip: process.platform !== 'darwin' || !process.env.SPRITZ_TEST_APP_BUNDLE }, () => {
  const app = process.env.SPRITZ_TEST_APP_BUNDLE || '/Applications/Spritz.app';
  const electron = path.join(path.dirname(require('electron')), 'Electron');
  const uuid = file => execFileSync('dwarfdump', ['--uuid', file], { encoding: 'utf8' }).match(/UUID: ([0-9A-F-]+)/)[1];
  assert.notEqual(uuid(path.join(app, 'Contents/MacOS/Spritz')), uuid(electron));
});
test('packaging runs UUID isolation before signing', () => {
  assert.equal(require('../package.json').build.afterPack, './build/app-uuid.js');
});
test('UUID rewrite is stable by identity and changes only LC_UUID bytes', () => {
  const { stampUuid, uuidFor } = require('../build/app-uuid');
  const binary = Buffer.alloc(64, 0x7c); binary.writeUInt32LE(0xfeedfacf, 0); binary.writeUInt32LE(1, 16); binary.writeUInt32LE(24, 20); binary.writeUInt32LE(0x1b, 32); binary.writeUInt32LE(24, 36);
  const original = Buffer.from(binary); stampUuid(binary, 'app.spritz.player');
  assert.deepEqual(binary.subarray(0, 40), original.subarray(0, 40)); assert.deepEqual(binary.subarray(56), original.subarray(56));
  assert.deepEqual(binary.subarray(40, 56), uuidFor('app.spritz.player'));
  const once = Buffer.from(binary); stampUuid(binary, 'app.spritz.player'); assert.deepEqual(binary, once);
  assert.notDeepEqual(uuidFor('app.spritz.player'), uuidFor('app.spritz.player.helper'));
  assert.throws(() => stampUuid(Buffer.alloc(64), 'app.spritz.player'), /Mach-O/);
});
