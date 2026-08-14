'use strict';

// cast.js kept its own copy of the capability logic and never adopted device-profile.js. The values
// agreed, so nothing looked wrong — but the copy returned a bare capability bag with no label, no
// stable id and no record of where the answer came from, and the device memory consequently keyed
// itself on an IP address. These pin both halves of that: the values are unchanged, and the identity
// the memory depends on is actually carried.

const test = require('node:test');
const assert = require('node:assert');
const dp = require('../src/main/device-profile');

// The pre-migration logic from cast.js, verbatim.
const isTvLike = (s) => /\bTV\b|webos|nanocell|oled|qled|neo|bravia|google ?tv|android ?tv|\blg\b|samsung|sony|vizio|hisense|tcl|philips/i.test(s || '');
function legacyProfile(isTv, fourK) {
  const passthrough = isTv || fourK;
  return {
    hevc: isTv || fourK, hevc4k: fourK, h264_4k: fourK, hdr10: true, dovi: false,
    audioCopy: passthrough ? ['aac', 'mp3', 'alac', 'ac3', 'eac3'] : ['aac', 'mp3', 'alac'],
    maxHeight: fourK ? 2160 : 1080
  };
}
const legacyMdns = (name, model) => { const tv = isTvLike((model || '') + ' ' + (name || '')); return legacyProfile(tv, tv); };
const legacyEureka = (j) => {
  const di = j.device_info || {};
  const tv = isTvLike([j.name, di.model_name, di.manufacturer, di.product_name].join(' '));
  const b = di['4k_blocked'];
  return legacyProfile(tv, b === 0 || b === '0' || (tv && b == null));
};

const NAMES = ['[LG] webOS TV NANO80T6A', 'Chromecast', 'Living Room', 'Bravia OLED', 'Kitchen speaker', '', null, 'Samsung QLED TV', 'TCL Google TV', 'Nest Hub'];
const MODELS = ['Chromecast Ultra', 'Chromecast', '', null, 'NANO80', 'Bravia'];
const BLOCKED = [0, '0', 1, '1', null, undefined];
const CAPS = ['hevc', 'hevc4k', 'h264_4k', 'hdr10', 'dovi', 'maxHeight'];

test('the shared profile decides exactly what cast.js used to decide', () => {
  let compared = 0;
  const same = (a, b, ctx) => {
    compared++;
    for (const k of CAPS) assert.equal(b[k], a[k], `${k} differs for ${ctx}`);
    assert.deepEqual(b.audioCopy, a.audioCopy, `audioCopy differs for ${ctx}`);
  };
  for (const name of NAMES) for (const model of MODELS) {
    same(legacyMdns(name, model), dp.fromMdns(name, model), `mdns ${name}/${model}`);
    for (const blocked of BLOCKED) {
      const j = { name, device_info: { model_name: model, '4k_blocked': blocked } };
      same(legacyEureka(j), dp.fromEureka(j), `eureka ${name}/${model}/${blocked}`);
    }
  }
  assert.ok(compared >= 400, 'the comparison should actually cover the space');
});

test('a device reports an identity that outlives its address', () => {
  const p = dp.fromEureka({
    name: '[LG] webOS TV NANO80T6A',
    ssdp_udn: 'f15e58d0-34db-4186-b0a2-87237b74fa8b',
    device_info: { '4k_blocked': 0 }
  });
  assert.equal(p.id, 'f15e58d0-34db-4186-b0a2-87237b74fa8b');
  assert.equal(p.label, '[LG] webOS TV NANO80T6A');
  assert.equal(p.source, 'reported', 'the TV said so, rather than us guessing from the name');
  assert.equal(dp.normalise(p).id, p.id, 'and it survives normalisation');
});

test('a device with no identity to give reports none rather than inventing one', () => {
  assert.equal(dp.fromEureka({ name: 'Chromecast', device_info: {} }).id, null);
  assert.equal(dp.fromMdns('Chromecast', 'Chromecast Ultra').id, null);
  assert.equal(dp.defaultProfile().id, null);
});
