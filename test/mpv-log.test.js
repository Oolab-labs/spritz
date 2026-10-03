'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createMpvLog } = require('../src/main/mpv-log');

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mpvlog-')), 'mpv.log');

// The libmpv hotplug crash (ao_coreaudio use-after-free after a failed AO init) is only attributable
// if the AO init error was written somewhere before the process died.
test('log events are appended with prefix and text; other events are ignored', () => {
  const file = tmp();
  const log = createMpvLog({ file, now: () => '2026-10-02T00:00:00.000Z' });
  assert.strictEqual(log.handle({ type: 'log', name: 'ao/coreaudio', value: 'failed to set device listener\n' }), true);
  assert.strictEqual(log.handle({ type: 'property-change', name: 'pause', value: true }), false);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), '2026-10-02T00:00:00.000Z [ao/coreaudio] failed to set device listener\n');
});

test('the file is bounded: past maxBytes it rotates to .1 and keeps only one backup', () => {
  const file = tmp();
  const log = createMpvLog({ file, maxBytes: 200, now: () => 't' });
  for (let i = 0; i < 40; i++) log.handle({ type: 'log', name: 'x', value: 'line ' + i });
  assert.ok(fs.statSync(file).size <= 400, 'live file stays near the cap');
  assert.ok(fs.existsSync(file + '.1'));
  assert.ok(!fs.existsSync(file + '.2'));
});

test('a write failure never throws into the mpv event path', () => {
  const log = createMpvLog({ file: '/nonexistent-dir/definitely/mpv.log' });
  assert.doesNotThrow(() => log.handle({ type: 'log', name: 'x', value: 'y' }));
});
