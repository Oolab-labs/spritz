'use strict';
// The /24 eureka sweep must drop audio-only Google speakers the same way mDNS discovery does.
// Google Home / Nest Mini / Chromecast Audio answer :8008/setup/eureka_info, and devices are keyed
// by host, so a speaker the mDNS path skipped used to be added back by the sweep a moment later
// and offered as a TV. The eureka check is on the reported MODEL only, not the friendly name: a
// video Chromecast its owner named "Living Room Soundbar" must stay castable.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), vm = require('vm');
const { EventEmitter } = require('events');
const { createRequire } = require('module');

// Same sandbox as discovery-retry.test.js: cast.js runs with fake http/dgram/mdns/os, so the
// sweep's eureka requests can be answered by hand and nothing touches the real network.
function fixture() {
  const filename = path.join(process.env.SPRITZ_TEST_APP_ROOT || path.join(__dirname, '..'), 'src/main/cast.js');
  const localRequire = createRequire(filename), requests = [];
  const socket = () => { const s = new EventEmitter(); s.bind = (...a) => a.at(-1)(); s.send = () => {}; s.setBroadcast = () => {}; s.close = s.destroy = () => {}; s.query = () => {}; return s; };
  const get = (...args) => { const req = new EventEmitter(); req.options = args[0]; req.callback = args.at(-1); req.destroy = () => { req.destroyed = true; }; requests.push(req); return req; };
  const ctx = { module: { exports: {} }, Buffer, URL, process: { env: {} }, console,
    setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
    require: n => n === 'http' ? { get, request: get } : n === 'dgram' ? { createSocket: socket }
      : n === 'multicast-dns' ? () => socket()
        : n === 'os' ? { networkInterfaces: () => ({ en0: [{ family: 'IPv4', address: '192.168.50.2' }] }), homedir: () => '/missing', release: () => '27' }
          : n === 'fs' ? { readFileSync: () => { throw Error('missing'); }, writeFileSync() {} } : localRequire(n) };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), ctx, { filename });
  const api = ctx.module.exports(), events = [];
  api.on('devices', devices => events.push(devices));
  return { api, requests, events };
}

function answer(req, body) {
  const res = new EventEmitter(); res.destroy = () => {};
  req.callback(res); res.emit('data', JSON.stringify(body)); res.emit('end');
}

// Array.from: the device list is built inside the vm realm, and deepEqual is realm-strict about prototypes.
function sweepWith(name, model) {
  const f = fixture(); f.api.startDiscovery();
  const req = f.requests[0], before = f.requests.length;
  answer(req, { name, device_info: { model_name: model, manufacturer: 'Google Inc.' } });
  const listed = Array.from(f.events.at(-1) || [], d => d.name);
  const pumped = f.requests.length > before; // the sweep moved on to the next address
  f.api.teardown();
  return { listed, pumped, host: req.options.host };
}

for (const model of ['Google Nest Mini', 'Google Home', 'Google Home Mini', 'Chromecast Audio', 'Google Nest Audio']) {
  test(`eureka sweep does not list the audio-only speaker "${model}"`, () => {
    const r = sweepWith('Kitchen speaker', model);
    assert.deepEqual(r.listed, [], model + ' cannot show video and must not be offered as a TV');
    assert.ok(r.pumped, 'skipping a speaker must still let the sweep continue to the next host');
  });
}

test('eureka sweep still lists a Nest Hub (it has a screen)', () => {
  assert.deepEqual(sweepWith('Kitchen display', 'Google Nest Hub').listed, ['Kitchen display']);
});

test('eureka sweep still lists a video Chromecast whose friendly name says "Soundbar"', () => {
  assert.deepEqual(sweepWith('Living Room Soundbar', 'Chromecast').listed, ['Living Room Soundbar']);
});

test('eureka sweep still lists a receiver that reports no model at all', () => {
  const f = fixture(); f.api.startDiscovery();
  answer(f.requests[0], { name: 'LG webOS TV' });
  assert.deepEqual(Array.from(f.events.at(-1) || [], d => d.name), ['LG webOS TV']);
  f.api.teardown();
});
