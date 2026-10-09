'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), vm = require('vm');
const { EventEmitter } = require('events');
const { createRequire } = require('module');
function fixture(route) {
  const filename = path.join(process.env.SPRITZ_TEST_APP_ROOT || path.join(__dirname, '..'), 'src/main/' + route + '.js');
  const localRequire = createRequire(filename), requests = [], sockets = [], timers = new Map(); let id = 0;
  const socket = () => { const s = new EventEmitter(); s.sent = []; s.bind = (...args) => args.at(-1)(); s.send = (...args) => s.sent.push(args); s.setBroadcast = () => {}; s.close = s.destroy = () => { s.closed = true; }; sockets.push(s); return s; };
  const get = (...args) => { const req = new EventEmitter(); req.options = args[0]; req.callback = args.at(-1); req.setTimeout = () => {}; req.end = () => {}; req.destroy = () => { req.destroyed = true; }; requests.push(req); return req; };
  const ctx = { module: { exports: {} }, Buffer, URL, process: { env: {} }, console,
    setTimeout: (fn, ms) => { timers.set(++id, { fn, ms }); return id; }, clearTimeout: id => timers.delete(id),
    setInterval: (fn, ms) => { timers.set(++id, { fn, ms }); return id; }, clearInterval: id => timers.delete(id),
    require: n => n === 'http' ? { get, request: get } : n === 'dgram' ? { createSocket: socket }
      : n === 'multicast-dns' ? () => { const s = socket(); s.query = () => {}; return s; }
        : n === 'os' ? { networkInterfaces: () => ({ en0: [{ family: 'IPv4', address: '192.168.50.2' }] }), homedir: () => '/missing', release: () => '27' }
          : n === 'fs' ? { readFileSync: () => { throw Error('missing'); }, writeFileSync() {} } : localRequire(n) };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), ctx, { filename });
  const api = ctx.module.exports(), events = [];
  api.on('devices', devices => events.push(devices));
  return { api, requests, sockets, timers, events };
}
test('Cast retry starts fresh probes even when discovery is already active', () => {
  const f = fixture('cast'); f.api.startDiscovery(); const first = f.requests.length;
  assert.ok(first > 0); f.api.startDiscovery({ retry: true });
  assert.ok(f.requests.length > first, 'Retry must not merely re-emit a cached device list');
  assert.ok(f.sockets[0].closed); assert.ok(f.requests.slice(0, first).every(r => r.destroyed));
  const late = new EventEmitter(); late.destroy = () => {}; f.requests[0].callback(late); late.emit('data', '{"name":"stale TV"}'); late.emit('end');
  assert.equal(f.events.flat().length, 0, 'a retired scan must not publish a device');
  f.api.teardown(); assert.equal(f.timers.size, 0, 'retry and teardown must retire all discovery timers');
});
test('DLNA retry replaces its socket and cancels old burst timers', () => {
  const f = fixture('dlna'); f.api.startDiscovery(); const before = [...f.timers.keys()];
  f.api.startDiscovery({ retry: true });
  assert.ok(f.sockets[0].closed); assert.equal(f.sockets.length, 2);
  assert.ok(before.every(id => !f.timers.has(id))); f.api.teardown(); assert.equal(f.timers.size, 0);
});

test('DLNA ignores description responses from a retired scan and accepts the new scan', () => {
  const f = fixture('dlna'); f.api.startDiscovery();
  const announcement = Buffer.from('HTTP/1.1 200 OK\r\nLOCATION: http://192.168.50.5:1901/device.xml\r\n\r\n');
  f.sockets[0].emit('message', announcement, { address: '192.168.50.5' });
  assert.equal(f.requests.length, 1);
  const old = f.requests[0]; f.api.startDiscovery({ retry: true }); assert.ok(old.destroyed);
  const xml = '<root><friendlyName>Living room</friendlyName><service><serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType><controlURL>/control</controlURL></service></root>';
  const respond = req => { const res = new EventEmitter(); req.callback(res); res.emit('data', xml); res.emit('end'); };
  respond(old); assert.equal(f.events.flat().length, 0);
  f.sockets[1].emit('message', announcement, { address: '192.168.50.5' }); respond(f.requests.at(-1));
  assert.equal(f.events.at(-1)[0].name, 'Living room'); f.api.teardown();
});
