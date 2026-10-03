'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// UI audit S3: the main window ran with sandbox:false. A sandboxed renderer/preload cannot reach Node or most
// Electron modules, so a bug that lets page script run (the CSP and navigation guard are the first defence)
// has far less to work with. The preload only needed `clipboard`, which a sandboxed preload cannot use, so the
// read now goes through the main process.
const preload = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload', 'preload.js'), 'utf8');
const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8');

test('the main window is sandboxed', () => {
  const m = /webPreferences:\s*\{[\s\S]*?sandbox:\s*(true|false)/.exec(main);
  assert.ok(m, 'no sandbox setting found');
  assert.strictEqual(m[1], 'true');
});

test('the preload uses only modules a sandboxed preload may require', () => {
  const required = [...preload.matchAll(/require\('([^']+)'\)/g)].map((x) => x[1]);
  assert.deepStrictEqual(required, ['electron']);
  const names = /const\s*\{([^}]+)\}\s*=\s*require\('electron'\)/.exec(preload)[1].split(',').map((s) => s.trim());
  const ALLOWED = ['contextBridge', 'ipcRenderer', 'webUtils', 'webFrame', 'crashReporter', 'nativeImage'];
  for (const n of names) assert.ok(ALLOWED.includes(n), n + ' is not available to a sandboxed preload');
});

test('the clipboard read goes through the main process, which owns the clipboard', () => {
  assert.ok(!/clipboard\./.test(preload), 'the preload still touches the clipboard directly');
  assert.ok(/ipcRenderer\.sendSync\('clipboard:readText'\)/.test(preload));
  assert.ok(/ipcMain\.on\('clipboard:readText'/.test(main));
  assert.ok(/clipboard\.readText\(\)/.test(main));
});

test('the clipboard handler returns text only, and never throws into the renderer', () => {
  const h = /ipcMain\.on\('clipboard:readText'[\s\S]*?\n  \}\);/.exec(main);
  assert.ok(h, 'handler not found');
  assert.ok(/returnValue\s*=\s*[^;]*typeof[^;]*string|returnValue\s*=\s*String\(/.test(h[0]) || /try\s*\{/.test(h[0]));
});
