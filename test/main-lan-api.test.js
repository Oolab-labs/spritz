'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// main.js talks to the LAN server through `lan`, the INSTANCE the factory returns. Helpers exported
// on the module (pickActiveSub, receiverSubPick, ...) are not on it. Calling one through `lan` threw
// a TypeError inside the Cast status handler on the first status frame of any film with subtitles,
// which aborted the load callback and surfaced as "Chromecast connect timed out" on every build.
test('every lan.<name> main.js calls is part of the LAN server instance', () => {
  const root = path.join(__dirname, '..', 'src', 'main');
  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  const ls = fs.readFileSync(path.join(root, 'lanserver.js'), 'utf8');
  const used = [...new Set([...main.matchAll(/\blan\.([A-Za-z_]\w*)/g)].map((m) => m[1]))];
  assert.ok(used.length > 10, 'the scan should find the real call sites');
  const start = ls.indexOf('\n  return { retireReceiverHls');
  assert.ok(start > 0, 'could not locate the instance return block');
  const block = ls.slice(start, ls.indexOf('\n};', start));
  const exposed = new Set([...block.matchAll(/\b([A-Za-z_]\w*)\b/g)].map((m) => m[1]));
  const missing = used.filter((u) => !exposed.has(u));
  assert.deepStrictEqual(missing, [], 'main.js calls lan.' + missing.join(', lan.') + ' but the instance does not expose it');
});
