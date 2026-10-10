'use strict';
/* The elapsed and total times are read from a sofa across the room, over arbitrary video. Reported:
 * at 20px grey with only a text-shadow they were not readable on a 1920x1080 webOS surface. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path');
const html = fs.readFileSync(path.join(__dirname, '../webos-receiver/index.html'), 'utf8');
const css = html.slice(html.indexOf('<style'), html.indexOf('</style>')).replace(/\/\*[\s\S]*?\*\//g, '');

function declarations(selector) {
  const out = {};
  const re = /([^{}]+)\{([^{}]*)\}/g; let m;
  while ((m = re.exec(css))) {
    if (!m[1].split(',').map((s) => s.trim()).includes(selector)) continue;
    for (const decl of m[2].split(';')) {
      const i = decl.indexOf(':'); if (i < 0) continue;
      out[decl.slice(0, i).trim()] = decl.slice(i + 1).trim();
    }
  }
  return out;
}
function luminance(hex) {
  const v = hex.replace('#', ''); const full = v.length === 3 ? v.split('').map((c) => c + c).join('') : v;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

test('playback times are large, bright and heavy enough to read across a room', () => {
  for (const id of ['#cur', '#dur']) {
    const d = { ...declarations('.bar'), ...declarations('.time'), ...declarations(id) };
    assert.ok(parseFloat(d['font-size']) >= 28, `${id} font-size ${d['font-size']} < 28px`);
    assert.ok(parseInt(d['font-weight'], 10) >= 500, `${id} font-weight ${d['font-weight']} < 500`);
    assert.match(d.color || '', /^#[0-9a-f]{3,6}$/i, `${id} needs an explicit hex colour`);
    assert.ok(luminance(d.color) >= 0.85, `${id} colour ${d.color} is too dim`);
    assert.match(d['font-variant-numeric'] || '', /tabular-nums/, `${id} digits must not jitter`);
  }
  assert.match(html, /<span id="cur" class="time">/);
  assert.match(html, /<span id="dur" class="time">/);
});

/* The real defect: the pairing countdown's `.bar { width: 560px; height: 6px; overflow: hidden }` (0.3.1)
 * also matched the playback bar, clipping the times to a 6px slice in a centred 560px strip. */
test('no rule meant for another bar can clip the playback time bar', () => {
  const bar = /<div class="([^"]+)">\s*<span id="cur"/.exec(html);
  assert.ok(bar, 'playback bar markup not found');
  const merged = Object.assign({}, ...bar[1].split(/\s+/).map((c) => declarations('.' + c)));
  assert.equal(merged.height, undefined, `playback bar has a fixed height: ${merged.height}`);
  assert.equal(merged.width, undefined, `playback bar has a fixed width: ${merged.width}`);
  assert.notEqual(merged.overflow, 'hidden', 'playback bar clips its contents');
});

test('the control surface carries its own dark backdrop so bright scenes cannot wash the times out', () => {
  const ui = declarations('#ui');
  assert.match(ui.background || '', /linear-gradient\(.*rgba\(0, ?0, ?0, ?0?\.[5-9]/, `#ui background: ${ui.background}`);
});
