'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { EventEmitter } = require('events');
const source = fs.readFileSync(path.join(__dirname, '../src/main/lanserver.js'), 'utf8');
for (const name of ['probeRaw', 'probeTracksRaw']) {
  test(`${name} cancellation kills only its child and rejects late close`, () => {
    const children = [], results = [];
    const ctx = { FFPROBE: 'ffprobe', PROBE_ENTRIES: '', spawn: () => {
      const child = new EventEmitter(); child.stdout = new EventEmitter();
      child.killed = 0; child.kill = (signal) => { assert.equal(signal, 'SIGKILL'); child.killed++; };
      children.push(child); return child;
    } };
    vm.createContext(ctx);
    const once = source.slice(source.indexOf('function onceProbe('), source.indexOf('function probeRaw('));
    const start = source.indexOf(`function ${name}(`);
    const end = name === 'probeRaw' ? source.indexOf('// pipe a file', start) : source.indexOf('  const cleanName', start);
    vm.runInContext(once + source.slice(start, end) + `\nthis.run = ${name};`, ctx);
    const invoke = (cb) => name === 'probeRaw' ? ctx.run('/movie', cb) : ctx.run('/movie', 5000, cb);
    const dispose = invoke((result) => results.push(result));
    invoke((result) => results.push(result));
    dispose();
    assert.equal(children[0].killed, 1);
    assert.equal(children[1].killed, 0);
    children[0].stdout.emit('data', '{"streams":[]}');
    children[0].emit('close', 0);
    assert.equal(results.length, 0);
    children[1].stdout.emit('data', '{"streams":[]}');
    children[1].emit('close', 0);
    assert.equal(results.length, 1);
  });
}

function timestampProbe() {
  const children = [];
  const ctx = { FFPROBE: 'ffprobe', spawn: (_, args, options) => {
    assert.equal(options.timeout, 5000);
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    child.killed = 0; child.kill = () => { child.killed++; };
    children.push(child); return child;
  } };
  vm.createContext(ctx);
  const start = source.indexOf('  function probeFirstPts(');
  const end = source.indexOf('  function serveEpochFile(', start);
  vm.runInContext(source.slice(start, end) + '\nthis.run = probeFirstPts;', ctx);
  return { run: ctx.run, children };
}

test('timestamp probe rejects empty output and completes once after error plus close', () => {
  const { run, children } = timestampProbe(), results = [];
  run('/segment', value => results.push(value));
  children[0].stdout.emit('data', '  \n');
  children[0].emit('close', 0);
  assert.deepEqual(results, [null]);
  run('/segment', value => results.push(value));
  children[1].emit('error', new Error('probe failed'));
  children[1].stdout.emit('data', '12.5'); children[1].emit('close', 0);
  assert.deepEqual(results, [null, null]);
});

test('timestamp probe cancellation kills its child once and suppresses late results', () => {
  const { run, children } = timestampProbe(), results = [];
  const cancel = run('/segment', value => results.push(value));
  cancel(); cancel();
  assert.equal(children[0].killed, 1);
  children[0].stdout.emit('data', '12.5'); children[0].emit('close', 0);
  assert.deepEqual(results, []);
});

test('timestamp cancellation drains its actual owned child process', { timeout: 5000 }, async () => {
  const { spawn } = require('child_process');
  const { once } = require('events');
  let child, closed;
  const ctx = { FFPROBE: 'controlled-probe', spawn: () => {
    child = spawn(process.execPath, ['-e', 'process.stdout.write("ready\\n"); setInterval(() => {}, 1000)']);
    closed = once(child, 'close');
    return child;
  } };
  vm.createContext(ctx);
  const start = source.indexOf('  function probeFirstPts(');
  const end = source.indexOf('  function serveEpochFile(', start);
  vm.runInContext(source.slice(start, end) + '\nthis.run = probeFirstPts;', ctx);
  const results = [];
  const cancel = ctx.run('/segment', value => results.push(value));
  try {
    await once(child.stdout, 'data');
    assert.ok(child.pid);
    cancel();
    const [code, signal] = await closed;
    assert.equal(code, null);
    assert.equal(signal, 'SIGKILL');
    assert.deepEqual(results, []);
    assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' });
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await closed;
  }
});
