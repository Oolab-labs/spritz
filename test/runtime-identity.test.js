'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runtimeIdentity } = require('../src/main/runtime-identity');
test('runtime identity distinguishes packaged and development Electron', () => {
  const runtime = { versions: { node: '22', electron: '35', modules: '133' }, execPath: '/app/Electron', arch: 'arm64', platform: 'darwin' };
  const app = { isPackaged: true, getVersion: () => '2.0', getAppPath: () => '/app/app.asar' };
  const identity = runtimeIdentity(app, runtime);
  assert.equal(identity.kind, 'packaged-electron'); assert.equal(identity.appPath, '/app/app.asar');
  assert.equal(identity.architecture, 'arm64'); assert.equal(identity.versions.modules, '133');
  app.isPackaged = false; assert.equal(runtimeIdentity(app, runtime).kind, 'development-electron');
});
test('Node execution and unavailable app metadata remain explicit', () => {
  const identity = runtimeIdentity({ getAppPath: () => { throw new Error('unavailable'); } }, { versions: { node: '22' } });
  assert.equal(identity.kind, 'node'); assert.equal(identity.appPath, null); assert.equal(identity.appVersion, null);
  assert.equal(identity.versions.electron, null);
});
