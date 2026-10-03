'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { EventEmitter } = require('events');
const source = fs.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8');
function fixture(name) {
  const children = [], results = [];
  const ctx = { YTDLP: 'yt-dlp', httpUrl: (url) => url, spawn: () => {
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    child.kills = 0; child.kill = () => { child.kills++; child.emit('close', 1); };
    children.push(child); return child;
  } };
  vm.createContext(ctx);
  vm.runInContext(source.slice(source.indexOf('const resolverJobs ='), source.indexOf('app.commandLine.appendSwitch')) + `\nthis.run = ${name}; this.cancel = cancelResolvers;`, ctx);
  return { children, results, cancel: ctx.cancel, run: () => ctx.run('https://example.test/page', (...args) => results.push(args)) };
}
for (const name of ['resolveStream', 'resolveAirplayUrl']) {
  test(`${name} source cancellation kills its child and suppresses late completion`, () => {
    const f = fixture(name); f.run(); f.cancel(); f.cancel();
    f.children[0].stdout.emit('data', 'https://example.test/movie.mp4'); f.children[0].emit('close', 0);
    assert.equal(f.children[0].kills, 1); assert.equal(f.results.length, 0);
  });
  test(`${name} error then close completes once`, () => {
    const f = fixture(name); f.run(); f.children[0].emit('error', new Error('failed')); f.children[0].emit('close', 1);
    assert.equal(f.results.length, 1); f.cancel(); assert.equal(f.children[0].kills, 0);
  });
  test(`${name} completed old job does not interfere with new resolver disposal`, () => {
    const f = fixture(name); f.run(); f.children[0].stdout.emit('data', 'https://example.test/movie.mp4'); f.children[0].emit('close', 0);
    f.run(); f.cancel(); assert.equal(f.children[0].kills, 0); assert.equal(f.children[1].kills, 1);
    assert.equal(f.results.length, 1);
  });
}

test('resolver ownership cancellation terminates a real pending child', async () => {
  const { spawn } = require('child_process');
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  let publications = 0;
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(source.slice(source.indexOf('const resolverJobs ='), source.indexOf('function resolveStream(')) + '\nthis.own = ownResolver; this.cancel = cancelResolvers;', ctx);
  const owned = ctx.own(child, () => publications++);
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  try {
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    ctx.cancel();
    const result = await exited;
    assert.equal(result.signal, 'SIGKILL');
    owned.answer(null, { url: 'late' });
    assert.equal(publications, 0);
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }
});
