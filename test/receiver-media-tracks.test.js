'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const tracks = require('../webos-receiver/media-tracks');
const protocol = require('../src/main/receiver-protocol');
protocol.validate = msg => protocol.parse(JSON.stringify(msg));
test('native track switching keeps clock and pause, with subtitles Off and metadata excluded', () => {
  const video = { currentTime: 217, paused: true, audioTracks: [{ enabled: true, language: 'en' }, { enabled: false, language: 'fr' }], textTracks: [{ kind: 'metadata', mode: 'hidden' }, { kind: 'subtitles', label: 'English', mode: 'disabled' }] };
  assert.equal(tracks.select(video, 'audio', '1'), true);
  assert.equal(video.audioTracks[0].enabled, false); assert.equal(video.audioTracks[1].enabled, true);
  assert.equal(tracks.select(video, 'subtitle', '1'), true);
  assert.equal(video.textTracks[1].mode, 'showing'); assert.equal(video.textTracks[0].mode, 'hidden');
  assert.equal(tracks.select(video, 'subtitle', 'off'), true); assert.equal(video.textTracks[1].mode, 'disabled');
  assert.equal(tracks.select(video, 'audio', '99'), false);
  assert.equal(video.currentTime, 217); assert.equal(video.paused, true);
});
test('track protocol validates lists and selection before authenticated routing', () => {
  assert.equal(protocol.validate(protocol.envelope('tracks', 's', { mediaId: 'film', tracks: { audio: [], subtitles: [] } })).ok, true);
  assert.equal(protocol.validate(protocol.envelope('tracks', 's', { mediaId: 'film', tracks: { audio: [{}], subtitles: [] } })).ok, false);
  assert.equal(protocol.validate(protocol.envelope('select-track', 's', { mediaId: 'film', kind: 'invalid', trackId: '1' })).ok, false);
});
test('TV remote navigates tracks explicitly and exits without a playback command', () => {
  let closed = 0; const selected = [];
  const choice = { options: [{}, {}], selectedIndex: 0, get value() { return String(this.selectedIndex); }, blur() { closed++; } };
  assert.equal(tracks.remoteChoice(choice, 40, id => selected.push(id)), true);
  assert.deepEqual(selected, []);
  assert.equal(tracks.remoteChoice(choice, 13, id => selected.push(id)), true);
  assert.deepEqual(selected, ['1']);
  assert.equal(tracks.remoteChoice(choice, 39, () => assert.fail('horizontal movement cannot select')), false);
  for (const key of [461, 27]) assert.equal(tracks.remoteChoice(choice, key, () => assert.fail('exit cannot select')), true);
  assert.equal(closed, 3);
});
test('prepared text subtitles survive LOAD serialization for TV sideloading', () => {
  const subtitles = [{ url: 'http://mac/hls/token/sub_en.vtt', lang: 'en', name: 'English' }];
  const message = protocol.load('s', { mediaId: 'film', url: 'http://mac/hls/token/index.m3u8', subtitles });
  assert.deepEqual(protocol.parse(protocol.serialize(message)).msg.subtitles, subtitles);
});

test('subtitle selection disables multiple automatic defaults and keeps metadata untouched', () => {
  const video = { textTracks: [{ kind: 'subtitles', mode: 'showing' }, { kind: 'subtitles', mode: 'showing' }, { kind: 'metadata', mode: 'hidden' }] };
  tracks.select(video, 'subtitle', 'off');
  assert.deepEqual(video.textTracks.map(t => t.mode), ['disabled', 'disabled', 'hidden']);
  tracks.select(video, 'subtitle', '1');
  assert.deepEqual(video.textTracks.map(t => t.mode), ['disabled', 'showing', 'hidden']);
});

test('source subtitle binding survives preceding native/metadata tracks and DOM reordering', () => {
  const metadata = { kind: 'metadata', mode: 'hidden' }, native = { kind: 'subtitles', mode: 'showing' };
  const english = { kind: 'subtitles', mode: 'disabled', cues: [{ startTime: 1, endTime: 2 }] };
  const french = { kind: 'subtitles', mode: 'disabled' };
  const video = { textTracks: [metadata, native, french, english] };
  const bindings = [{ id: 'source-subtitle-0', title: 'English', lang: 'eng', node: { track: english, readyState: 2 } }, { id: 'source-subtitle-2', title: 'French', lang: 'fra', node: { track: french, readyState: 0 } }];
  assert.equal(tracks.selectBoundSubtitle(video, bindings, 'source-subtitle-0'), true);
  assert.equal(english.mode, 'showing'); assert.equal(french.mode, 'disabled'); assert.equal(native.mode, 'disabled'); assert.equal(metadata.mode, 'hidden');
  assert.deepEqual(tracks.boundSubtitles(bindings)[0], { id: 'source-subtitle-0', title: 'English', lang: 'eng', selected: true, readyState: 2, cueCount: 1 });
  tracks.selectBoundSubtitle(video, bindings, 'off'); assert.equal(english.mode, 'disabled');
  assert.equal(tracks.selectBoundSubtitle(video, bindings, 'source-subtitle-9'), false);
});
test('LOAD preserves stable source subtitle choice across audio replacement', () => {
  const subtitles = [{ id: 'source-subtitle-2', url: 'http://mac/sub.vtt', lang: 'fra', name: 'French' }];
  const message = protocol.load('s', { mediaId: 'film', url: 'http://mac/media', subtitles, subtitleTrackId: 'source-subtitle-2' });
  const parsed = protocol.parse(protocol.serialize(message));
  assert.equal(parsed.ok, true); assert.equal(parsed.msg.subtitleTrackId, subtitles[0].id);
});
