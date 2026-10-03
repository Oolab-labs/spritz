'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const source = fs.readFileSync(path.join(__dirname, '../src/main/lanserver.js'), 'utf8');
function fixture() {
  const ready = [], results = [], files = new Map(), proxies = new Map();
  const ctx = { path, files, dlnaProxies: proxies, port: 1234,
    ensure: (cb) => ready.push(cb), lanAddress: () => '127.0.0.1', newToken: () => 'token' };
  vm.createContext(ctx);
  const proxy = source.slice(source.indexOf('  const tokenRegistrations ='), source.indexOf('  function serveDlnaProxy('));
  const file = source.slice(source.indexOf('  function serve(absPath'), source.indexOf('  // prepareCast(input'));
  vm.runInContext(proxy + file + '\nthis.routes = [serve, serveSource, (input, cb) => serveDlna(input, "video/mp4", cb)]; this.cancel = cancelTokenRegistrations;', ctx);
  return { ctx, ready, results, files, proxies, cancel: ctx.cancel,
    admit: (index) => ctx.routes[index]('/movie.mp4', (url) => results.push(url)) };
}
for (const [index, name] of ['file', 'producer proxy', 'viewer proxy'].entries()) {
  test(`${name} cancellation settles once and never registers a late token`, () => {
    const f = fixture(); f.admit(index); f.cancel(); f.cancel(); f.ready[0]();
    assert.deepEqual(f.results, [null]);
    assert.equal(f.files.size + f.proxies.size, 0);
  });
  test(`${name} new admission succeeds after an old registration is cancelled`, () => {
    const f = fixture(); f.admit(index); f.cancel(); f.admit(index);
    f.ready[0](); f.ready[1]();
    assert.equal(f.results.length, 2);
    assert.equal(f.results[0], null);
    assert.ok(f.results[1].includes('/token/'));
    assert.equal(f.files.size + f.proxies.size, 1);
  });
}

for (const [index, name] of ['file', 'producer proxy', 'viewer proxy'].entries()) {
  test(`${name} owned admission cancellation preserves an unrelated pending registration`, () => {
    const f = fixture(); const cancel = f.admit(index); f.admit(index);
    cancel(); cancel(); f.ready[0](); f.ready[1]();
    assert.equal(f.results[0], null); assert.ok(f.results[1].includes('/token/'));
    assert.equal(f.files.size + f.proxies.size, 1);
  });
}

test('throwing cancellation callback cannot strand another pending token registration', () => {
  const f = fixture(); let calls = 0;
  f.ctx.routes[0]('/throw.mp4', () => { calls++; throw new Error('caller failed'); });
  f.admit(1);
  assert.doesNotThrow(() => f.cancel());
  for (const ready of f.ready) ready();
  assert.equal(calls, 1); assert.deepEqual(f.results, [null]);
  assert.equal(f.files.size + f.proxies.size, 0);
});
