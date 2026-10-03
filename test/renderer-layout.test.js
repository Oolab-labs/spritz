'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// Unit tests cannot see layout. build/check-layout.js renders the real home screen, dialogs and menus in
// Electron at four window sizes and fails on overlapping blocks, unreachable content and dialog buttons
// outside the window (the rc.3 home-screen regression and the Settings "Done" button off screen).
// Needs the Electron binary; CI's fast job installs with --ignore-scripts and skips it.
let electronBin = null;
try { const p = require('electron'); if (typeof p === 'string' && fs.existsSync(p)) electronBin = p; } catch (e) { /* not installed */ }

test('home screen, dialogs and menus fit and do not overlap at 950x560, 640x480, 520x400 and 1440x900',
  { skip: electronBin ? false : 'Electron binary not installed', timeout: 90000 }, () => {
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    const r = spawnSync(electronBin, [path.join(__dirname, '..', 'build', 'check-layout.js')], { env, encoding: 'utf8', timeout: 80000 });
    const json = (r.stdout || '').slice((r.stdout || '').indexOf('{'));
    let parsed; try { parsed = JSON.parse(json); } catch (e) { assert.fail('layout check produced no result: ' + (r.stderr || r.stdout).slice(0, 400)); }
    assert.deepStrictEqual(parsed.problems, []);
  });
