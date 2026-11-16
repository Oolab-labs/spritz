'use strict';
// Manual TV addresses come from ONE place: the validated Settings field (IPv4 literals only),
// parsed by src/main/lan-hosts.js for both Cast and DLNA. The old SPRITZ_CAST_HOSTS /
// SPRITZ_DLNA_HOSTS env vars bypassed that filter (a hostname was probed as-is) and are gone.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), vm = require('vm');
const { EventEmitter } = require('events');
const { createRequire } = require('module');

// Same sandbox shape as discovery-retry.test.js: stub os/http/dgram/fs so no real network is touched.
function fixture(route, env) {
  const filename = path.join(process.env.SPRITZ_TEST_APP_ROOT || path.join(__dirname, '..'), 'src/main/' + route + '.js');
  const localRequire = createRequire(filename), requests = [], sockets = [], timers = new Map(); let id = 0;
  const socket = () => { const s = new EventEmitter(); s.sent = []; s.bind = (...args) => args.at(-1)(); s.send = (...args) => s.sent.push(args); s.setBroadcast = () => {}; s.close = s.destroy = () => { s.closed = true; }; sockets.push(s); return s; };
  const get = (...args) => { const req = new EventEmitter(); req.options = args[0]; req.callback = args.at(-1); req.setTimeout = () => {}; req.end = () => {}; req.destroy = () => { req.destroyed = true; }; requests.push(req); return req; };
  const ctx = { module: { exports: {} }, Buffer, URL, process: { env }, console,
    setTimeout: (fn, ms) => { timers.set(++id, { fn, ms }); return id; }, clearTimeout: id => timers.delete(id),
    setInterval: (fn, ms) => { timers.set(++id, { fn, ms }); return id; }, clearInterval: id => timers.delete(id),
    require: n => n === 'http' ? { get, request: get } : n === 'dgram' ? { createSocket: socket }
      : n === 'multicast-dns' ? () => { const s = socket(); s.query = () => {}; return s; }
        : n === 'os' ? { networkInterfaces: () => ({ en0: [{ family: 'IPv4', address: '192.168.50.2' }] }), homedir: () => '/missing', release: () => '27' }
          : n === 'fs' ? { readFileSync: () => { throw Error('missing'); }, writeFileSync() {} } : localRequire(n) };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), ctx, { filename });
  return { api: ctx.module.exports(), requests, sockets, timers };
}
// Run the DLNA unicast sweep (the 30s interval) and collect every unicast destination.
function dlnaSweepTargets(f) {
  for (const t of [...f.timers.values()].filter(t => t.ms === 30000)) t.fn();
  // drain the staggered chunks
  for (let n = 0; n < 100; n++) { const next = [...f.timers.values()].filter(t => t.ms === 40); if (!next.length) break; f.timers.clear(); next.forEach(t => t.fn()); }
  return f.sockets.flatMap(s => s.sent.map(a => a[4])).filter(Boolean);
}

test('Cast does not probe a SPRITZ_CAST_HOSTS hostname (only the validated Settings field)', () => {
  const f = fixture('cast', { SPRITZ_CAST_HOSTS: 'tv.example' });
  f.api.startDiscovery();
  assert.ok(f.requests.length > 0);
  assert.ok(!f.requests.some(r => r.options.host === 'tv.example'), 'an env hostname must not be probed');
  f.api.teardown();
});

test('Cast probes a repeated manual address once, ahead of the /24 sweep', () => {
  const f = fixture('cast', {});
  f.api.setManualHosts('10.9.9.9, 10.9.9.9, tv.example');
  f.api.startDiscovery();
  assert.equal(f.requests[0].options.host, '10.9.9.9');
  assert.equal(f.requests.filter(r => r.options.host === '10.9.9.9').length, 1);
  assert.ok(!f.requests.some(r => r.options.host === 'tv.example'));
  f.api.teardown();
});

test('DLNA does not sweep a SPRITZ_DLNA_HOSTS hostname, but does sweep a Settings address once', () => {
  const f = fixture('dlna', { SPRITZ_DLNA_HOSTS: 'tv.example' });
  f.api.setManualHosts('10.9.9.9,10.9.9.9');
  f.api.startDiscovery();
  const targets = dlnaSweepTargets(f);
  assert.ok(targets.includes('192.168.50.7'), 'the /24 sweep still runs');
  assert.ok(!targets.includes('192.168.50.2'), 'never probes our own address');
  assert.ok(!targets.includes('tv.example'), 'an env hostname must not be probed');
  const perHost = targets.filter(h => h === '192.168.50.7').length;
  assert.equal(targets.filter(h => h === '10.9.9.9').length, perHost, 'a repeated manual address is swept once');
  f.api.teardown();
});

test('lan-hosts: lanSubnets keeps physical private IPv4 only; parseHosts keeps unique IPv4 literals', () => {
  const { lanSubnets, parseHosts } = require('../src/main/lan-hosts');
  assert.deepEqual(lanSubnets({
    lo0: [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
    en0: [{ family: 'IPv4', address: '192.168.1.5' }, { family: 'IPv6', address: 'fe80::1' }],
    en1: [{ family: 4, address: '172.20.0.3' }, { family: 'IPv4', address: '8.8.8.8' }],
    eth0: [{ family: 'IPv4', address: '10.0.0.9' }],
    utun3: [{ family: 'IPv4', address: '10.8.0.2' }],
  }), ['192.168.1.5', '172.20.0.3', '10.0.0.9']);
  assert.deepEqual(parseHosts(' 10.0.0.2, tv.local,10.0.0.2 ,, 192.168.1.40'), ['10.0.0.2', '192.168.1.40']);
  assert.deepEqual(parseHosts(undefined), []);
});
