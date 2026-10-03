'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), vm = require('vm');
const source = fs.readFileSync(path.join(__dirname, '../src/main/lanserver.js'), 'utf8');
test('owned source release removes its token, closes its reads and rejects late activation', () => {
  const calls = [], entries = new Map([['other', {}]]);
  const ctx = { port: 1234, dlnaProxies: entries, newToken: () => 'owned',
    registerSourceProducer: () => ({ noteSourceRead() {}, setActive: a => calls.push(a), dispose: () => calls.push('dispose') }) };
  vm.createContext(ctx);
  vm.runInContext(source.slice(source.indexOf('  function createOwnedSource('), source.indexOf('  function serveDlnaProxy(')) + '\nthis.create = createOwnedSource;', ctx);
  const owned = ctx.create('source'); entries.get('owned').cancelReads.add(() => calls.push('cancel-read'));
  owned.setActive(true); owned.dispose(); owned.dispose(); owned.setActive(true);
  assert.deepEqual(calls, [true, 'dispose', 'cancel-read']);
  assert.equal(entries.has('owned'), false); assert.equal(entries.has('other'), true);
});
