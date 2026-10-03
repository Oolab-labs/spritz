'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildReceiverSubtitleCatalog } = require('../src/main/receiver-subtitle-catalog');
const proto = require('../src/main/receiver-protocol');
const parse = m => proto.parse(proto.serialize(m));
const sources = () => Array.from({ length: 36 }, (_, idx) => ({ idx, lang: idx < 3 ? 'eng' : 'und', name: idx < 3 ? 'English' : 'Subtitle', codec: 'subrip', disposition: { hearing_impaired: idx === 2 ? 1 : 0 } }));
test('receiver retains 36 text variants, English SDH metadata and unique names', () => {
  const catalog = buildReceiverSubtitleCatalog(sources());
  assert.equal(catalog.length, 36);
  assert.equal(catalog[2].id, 'source-subtitle-2');
  assert.equal(catalog[2].sdh, true); assert.match(catalog[2].name, /SDH/);
  assert.equal(catalog[2].format, 'subrip');
  assert.equal(new Set(catalog.map(t => t.name)).size, 36);
  const reordered = buildReceiverSubtitleCatalog([sources()[2], { idx: 1, bitmap: true }, sources()[0]]);
  assert.deepEqual(reordered.map(t => t.id), ['source-subtitle-2', 'source-subtitle-0']);
});
test('36 tracks survive LOAD and TV inventory serialization in both directions', () => {
  const catalog = buildReceiverSubtitleCatalog(sources());
  const subtitles = catalog.map(t => ({ ...t, url: 'http://127.0.0.1/sub/' + t.id, prepare: true }));
  const load = parse(proto.load('session', { mediaId: 'film', url: 'http://127.0.0.1/video', subtitles, subtitleTrackId: 'source-subtitle-35' }));
  assert.equal(load.ok, true); assert.equal(load.msg.subtitles.length, 36);
  const inventory = { audio: [], subtitles: catalog.map(t => ({ ...t, title: t.name, selected: t.id === 'source-subtitle-2' })) };
  assert.equal(parse(proto.envelope('tracks', 'session', { mediaId: 'film', tracks: inventory })).ok, true);
  for (const id of ['source-subtitle-35', 'source-subtitle-127', 'off']) {
    assert.equal(parse(proto.envelope('select-track', 'session', { mediaId: 'film', kind: 'subtitle', trackId: id })).ok, true);
  }
});
test('catalog and protocol reject overflow explicitly instead of truncating', () => {
  assert.throws(() => buildReceiverSubtitleCatalog(Array.from({ length: 129 }, (_, idx) => ({ idx }))), /at most 128/);
  assert.throws(() => buildReceiverSubtitleCatalog([{ idx: 128 }]), /ordinal/);
  assert.equal(buildReceiverSubtitleCatalog([{ idx: 127 }])[0].id, 'source-subtitle-127');
  const subtitles = Array.from({ length: 129 }, (_, idx) => ({ id: 'source-subtitle-' + idx, url: 'http://127.0.0.1/sub/' + idx }));
  const msg = proto.load('s', { mediaId: 'm', url: 'http://127.0.0.1/v', subtitles });
  assert.equal(msg.subtitles.length, 129); assert.equal(parse(msg).ok, false);
  for (const trackId of ['source-subtitle-128', 'source-subtitle--1', 'source-subtitle-999']) {
    assert.equal(parse(proto.envelope('select-track', 's', { mediaId: 'm', kind: 'subtitle', trackId })).ok, false);
    assert.equal(parse(proto.load('s', { mediaId: 'm', url: 'http://127.0.0.1/v', subtitleTrackId: trackId })).ok, false);
  }
  const tracks = { audio: Array.from({ length: 33 }, (_, i) => ({ id: String(i), title: 'Audio', lang: 'eng', selected: false })), subtitles: [] };
  assert.equal(parse(proto.envelope('tracks', 's', { mediaId: 'm', tracks })).ok, false);
});
