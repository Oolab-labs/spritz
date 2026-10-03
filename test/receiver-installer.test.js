'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { findInstaller } = require('../src/main/receiver-installer');

const fsWith = (files) => ({
  readdirSync: (d) => { if (!(d in files)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); return files[d]; }
});

test('a packaged app finds the receiver installer in Contents/Resources/receiver', () => {
  const res = '/Applications/Spritz.app/Contents/Resources';
  const fs = fsWith({ [path.join(res, 'receiver')]: ['readme.txt', 'com.spritz.receiver_0.3.0_all.ipk'] });
  assert.strictEqual(findInstaller({ resourcesPath: res, root: '/src', fs }), path.join(res, 'receiver', 'com.spritz.receiver_0.3.0_all.ipk'));
});

test('in development it falls back to dist-receiver in the repo', () => {
  const fs = fsWith({ [path.join('/repo', 'dist-receiver')]: ['com.spritz.receiver_0.3.0_all.ipk'] });
  assert.strictEqual(findInstaller({ resourcesPath: '/nowhere/Resources', root: '/repo', fs }), path.join('/repo', 'dist-receiver', 'com.spritz.receiver_0.3.0_all.ipk'));
});

test('no installer anywhere gives null, never a made-up path', () => {
  assert.strictEqual(findInstaller({ resourcesPath: '/r', root: '/repo', fs: fsWith({}) }), null);
  assert.strictEqual(findInstaller({ resourcesPath: '/r', root: '/repo', fs: fsWith({ '/r/receiver': ['notes.txt'] }) }), null);
});

test('with several installers the highest version wins', () => {
  const res = '/R';
  const fs = fsWith({ [path.join(res, 'receiver')]: ['com.spritz.receiver_0.3.0_all.ipk', 'com.spritz.receiver_0.10.0_all.ipk', 'com.spritz.receiver_0.9.1_all.ipk'] });
  assert.ok(findInstaller({ resourcesPath: res, root: '/x', fs }).endsWith('_0.10.0_all.ipk'));
});
