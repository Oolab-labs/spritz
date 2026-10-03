'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const source = fs.readFileSync(path.join(__dirname, '../src/renderer/renderer.js'), 'utf8');
function fixture(engine, volume) {
  let click;
  const calls = [], st = { volume, muted: false }, slider = { value: volume * 100 };
  const api = (name) => ({ setVolume: (value) => calls.push([name, 'volume', value]), setMuted: (value) => calls.push([name, 'mute', value]) });
  const ctx = { engine, st, volSlider: slider, soda: { player: api('mpv'), airplay: api('airplay'), cast: api('chromecast'), dlna: api('dlna') },
    muteBtn: { addEventListener: (_, fn) => { click = fn; } }, updateVolIcon() {} };
  vm.runInNewContext(source.slice(source.indexOf("muteBtn.addEventListener('click'"), source.indexOf('function updateVolIcon()')), ctx);
  return { click, st, calls, slider };
}
test('local zero-gain unmute applies restored volume before removing mute', () => {
  const f = fixture('mpv', 0); f.click(); f.click();
  assert.deepEqual(f.calls, [['mpv', 'mute', true], ['mpv', 'volume', 0.2], ['mpv', 'mute', false]]);
  assert.equal(f.st.volume, 0.2); assert.equal(f.slider.value, 20);
});
for (const engine of ['airplay', 'chromecast', 'dlna']) {
  test(`${engine} mute/unmute retains its remote gain semantics`, () => {
    const f = fixture(engine, 0.7); f.click(); f.click();
    assert.deepEqual(f.calls, [[engine, 'volume', 0], [engine, 'volume', 0.7]]);
    assert.equal(f.st.volume, 0.7);
  });
}
test('local nonzero mute/unmute preserves selected gain', () => {
  const f = fixture('mpv', 0.7); f.click(); f.click();
  assert.deepEqual(f.calls, [['mpv', 'mute', true], ['mpv', 'mute', false]]);
  assert.equal(f.st.volume, 0.7);
});
