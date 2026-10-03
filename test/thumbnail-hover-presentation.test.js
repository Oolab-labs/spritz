'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), vm = require('vm');
const source = fs.readFileSync(path.join(__dirname, '../src/renderer/renderer.js'), 'utf8');
function fixture() {
  const listeners = {}, timers = [], requests = [];
  const image = { style: {}, src: 'old' };
  const elements = { '#thumb-img': image, '#thumb-time': {}, '#thumb-preview': { style: {}, classList: { add() {}, remove() {} } } };
  const ctx = { $: id => elements[id], seek: { addEventListener: (name, fn) => { listeners[name] = fn; }, getBoundingClientRect: () => ({ left: 0, width: 100 }) }, st: { loaded: true, duration: 100 }, engine: 'mpv', currentLocalPath: '/film', subtitleOwner: () => 1, ownsSubtitle: () => true, toPlayerTime: String, setTimeout: fn => { timers.push(fn); return timers.length; }, clearTimeout() {}, soda: { thumbAt: () => new Promise(resolve => requests.push(resolve)) } };
  vm.createContext(ctx);
  vm.runInContext(source.slice(source.indexOf("const thumbPreview ="), source.indexOf("seek.addEventListener('mousedown'", source.indexOf("const thumbPreview ="))), ctx);
  return { image, listeners, timers, requests };
}
test('new hover hides the old frame until the owned request succeeds', async () => {
  const f = fixture(); f.listeners.mousemove({ clientX: 10 });
  assert.equal(f.image.style.visibility, 'hidden');
  const old = f.timers[0]();
  f.listeners.mousemove({ clientX: 20 }); const fresh = f.timers[1]();
  f.requests[0]('stale'); await old;
  assert.equal(f.image.src, 'old'); assert.equal(f.image.style.visibility, 'hidden');
  f.requests[1]('fresh'); await fresh;
  assert.equal(f.image.src, 'fresh'); assert.equal(f.image.style.visibility, '');
});
test('failed or retired hover cannot reveal an old frame', async () => {
  const f = fixture(); f.listeners.mousemove({ clientX: 10 }); const request = f.timers[0]();
  f.requests[0](null); await request; assert.equal(f.image.style.visibility, 'hidden');
  f.listeners.mousemove({ clientX: 20 }); const retired = f.timers[1]();
  f.listeners.mouseleave(); f.requests[1]('retired'); await retired;
  assert.equal(f.image.src, 'old'); assert.equal(f.image.style.visibility, 'hidden');
});
