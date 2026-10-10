'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = process.env.SPRITZ_TEST_APP_ROOT || path.join(__dirname, '..');
function rowHarness() {
  const handlers = {}, requests = [];
  const row = { addEventListener: (name, fn) => { handlers[name] = fn; } };
  const source = fs.readFileSync(path.join(root, 'src/renderer/renderer.js'), 'utf8');
  vm.runInNewContext(source.slice(source.indexOf('const airRow ='), source.indexOf('function airRect()')), {
    $: () => row, soda: { airplay: { openPicker: () => requests.push('open') } }
  });
  return { handlers, requests };
}
test('AirPlay label/row click requests the native picker once without bubbling to menu close', () => {
  const { handlers, requests } = rowHarness(); let stopped = false;
  assert.equal(typeof handlers.click, 'function', 'the entire row must activate the picker');
  handlers.click({ stopPropagation: () => { stopped = true; } });
  assert.deepEqual(requests, ['open']); assert.equal(stopped, true);
});
test('AirPlay row Enter and Space activate; other keys keep normal navigation', () => {
  const { handlers, requests } = rowHarness(); let prevented = 0;
  assert.equal(typeof handlers.keydown, 'function', 'keyboard activation is required');
  for (const key of ['Enter', ' ', 'Tab', 'Escape']) handlers.keydown({ key, preventDefault: () => prevented++, stopPropagation() {} });
  assert.equal(requests.length, 2); assert.equal(prevented, 2);
  const html = fs.readFileSync(path.join(root, 'src/renderer/index.html'), 'utf8');
  const row = html.match(/<li[^>]*id="cast-airplay-row"[^>]*>/)[0];
  assert.match(row, /role="button"/); assert.match(row, /tabindex="0"/);
});
