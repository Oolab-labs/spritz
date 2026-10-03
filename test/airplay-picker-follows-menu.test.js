'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// The native AirPlay picker is a separate view laid over the "AirPlay" row of the cast menu. It was
// positioned once, when the menu opened. The menu is anchored to the bottom, so when it grew afterwards
// (a television asking to pair adds a row; devices arrive late) the row moved up and the picker stayed
// where it was — drawn over the DLNA entry beneath it, so clicking "AirPlay" did nothing useful.
test('the picker is re-placed whenever the cast menu changes size', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'renderer.js'), 'utf8');
  assert.ok(/new ResizeObserver\([^)]*\)\s*\.observe\(menuCast\)/.test(src) || /ResizeObserver[\s\S]{0,300}observe\(menuCast\)/.test(src),
    'a ResizeObserver on the cast menu must call placePicker');
  const i = src.indexOf('observe(menuCast)');
  assert.ok(/placePicker/.test(src.slice(Math.max(0, i - 300), i)), 'and what it calls is placePicker');
});

// The menu is height-capped and scrolls; the native picker is NOT clipped by it, so it has to be hidden when the
// AirPlay row has scrolled out of the visible part rather than left hovering over another row.
test('the picker is hidden when its row is outside the visible menu', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'renderer.js'), 'utf8');
  const fn = src.slice(src.indexOf('function airRowVisible()'), src.indexOf('function showPicker('));
  assert.ok(/menu-cast/.test(fn) && /getBoundingClientRect/.test(fn));
  assert.ok(/airRowVisible\(\)\) soda\.airplay\.showButton/.test(fn) && /else soda\.airplay\.hideButton\(\)/.test(fn));
  assert.ok(/addEventListener\('scroll'/.test(src), 'and it follows the scroll');
});

// The native picker draws its glyph in the CENTRE of whatever rectangle it is given. Given the whole row it sat
// in the middle, which was empty space in a wide menu and is on top of the text in the narrow one. The row
// leaves padding at its left for the glyph, so the picker is given just that strip.
test('the picker occupies only the glyph strip at the left of the AirPlay row', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'renderer.js'), 'utf8');
  const fn = src.slice(src.indexOf('function airRect()'), src.indexOf('// The picker is a native view laid over'));
  assert.ok(/PICKER_STRIP/.test(fn) && /Math\.min\(r\.width, PICKER_STRIP\)/.test(fn), 'the width is capped to a strip');
  const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'player.css'), 'utf8');
  const strip = Number((/const PICKER_STRIP = (\d+)/.exec(src) || [])[1]);
  const pad = Number((/\.cast-airplay \{ padding-left: (\d+)px/.exec(css) || [])[1]);
  assert.ok(strip > 0 && pad >= strip, 'the row pads at least as far as the strip is wide (' + pad + ' vs ' + strip + ')');
});
