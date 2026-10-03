'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const yml = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'ci.yml'), 'utf8');

// electron-builder skips code signing on pull-request builds unless told otherwise, which left the staged
// app with Electron's stock (now invalid) signature, and verify-package rightly refused it: the first CI run
// on the public pull request failed with "the app bundle signature does not verify". The build is signed ad
// hoc (identity "-"), so there is no certificate or secret to protect.
test('the package job signs the staged app on pull requests too', () => {
  const step = yml.slice(yml.indexOf('- name: Stage the app and verify its contents'));
  assert.ok(step.length > 100, 'the step exists');
  const head = step.slice(0, step.indexOf('run:'));
  assert.ok(/env:\s*\n\s+CSC_FOR_PULL_REQUEST: ['"]?true['"]?/.test(head), 'CSC_FOR_PULL_REQUEST is set on the step that builds');
});

test('the signing identity really is ad hoc, which is what makes that safe', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.strictEqual(pkg.build.mac.identity, '-');
  assert.ok(!/CSC_LINK|CSC_KEY_PASSWORD|APPLE_ID/.test(yml), 'no signing secret is exposed to the workflow');
});

// The package verifier requires the licence texts inside the app, and extraResources maps dist-licenses into it,
// so the job has to build them before electron-builder runs (it calls electron-builder directly, not npm run dist).
test('the package job collects the licence files before it builds', () => {
  const step = yml.slice(yml.indexOf('- name: Stage the app and verify its contents'));
  assert.ok(step.indexOf('node build/collect-licenses.js') > 0, 'collect-licenses runs');
  assert.ok(step.indexOf('node build/collect-licenses.js') < step.indexOf('npx electron-builder'), 'and before electron-builder');
});

test('npm run dist collects them too', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.ok(pkg.scripts.dist.includes('node build/collect-licenses.js'));
  assert.ok(pkg.build.extraResources.some((r) => r.from === 'dist-licenses' && r.to === 'licenses'));
});

// CI installs with --ignore-scripts, which skips Electron's own download, so node_modules/electron/dist (where the
// Electron and Chromium licence files live) does not exist until something fetches it. The first run with the
// licence collector failed with "Electron LICENSE not found".
test('the package job fetches the Electron distribution before it collects licences', () => {
  const step = yml.slice(yml.indexOf('- name: Stage the app and verify its contents'));
  const install = step.indexOf('node node_modules/electron/install.js');
  assert.ok(install > 0, 'the Electron distribution is fetched');
  assert.ok(install < step.indexOf('node build/collect-licenses.js'), 'before collect-licenses');
});
