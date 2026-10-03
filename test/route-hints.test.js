'use strict';
const test = require('node:test');
const assert = require('node:assert');
const H = require('../src/renderer/route-hints');

// What the app tells the person about each route: who changes the audio language and subtitles (the Mac or
// the TV), what a change costs, and what a torrent that is still downloading cannot do.

test('playing on this Mac says nothing', () => {
  assert.deepStrictEqual(H.trackNotes({ engine: 'mpv', torrent: false }), { audio: null, subs: null });
  assert.deepStrictEqual(H.trackNotes({ engine: 'mpv', torrent: true }), { audio: null, subs: null }, 'a torrent playing locally has no limits to explain');
});

test('DLNA hands the choice to the TV remote and hides the Mac list', () => {
  const n = H.trackNotes({ engine: 'dlna', torrent: false });
  for (const k of ['audio', 'subs']) {
    assert.strictEqual(n[k].only, true, 'the Mac has nothing to list');
    assert.ok(/TV remote/.test(n[k].text));
  }
  assert.ok(/audio and subtitles/i.test(n.audio.text));
});

test('Google Cast says a change restarts the stream', () => {
  const n = H.trackNotes({ engine: 'chromecast', torrent: false });
  assert.strictEqual(n.audio.only, false);
  assert.ok(/restart/i.test(n.audio.text) && /audio/i.test(n.audio.text));
  assert.ok(/restart/i.test(n.subs.text) && /subtitle/i.test(n.subs.text));
});

test('AirPlay switches in place, so a film needs no note', () => {
  assert.deepStrictEqual(H.trackNotes({ engine: 'airplay', torrent: false }), { audio: null, subs: null });
});

test('Spritz Receiver says the TV remote works too', () => {
  const n = H.trackNotes({ engine: 'receiver', torrent: false });
  assert.ok(/TV remote/.test(n.audio.text) && /TV remote/.test(n.subs.text));
  assert.strictEqual(n.audio.only, false);
});

test('a torrent adds what is true of every cast route: only what has downloaded can be reached', () => {
  for (const engine of ['chromecast', 'airplay', 'receiver']) {
    const n = H.trackNotes({ engine, torrent: true });
    assert.ok(/download/i.test(n.audio.text) && /download/i.test(n.subs.text), engine);
  }
  const air = H.trackNotes({ engine: 'airplay', torrent: true });
  assert.ok(/seek/i.test(air.subs.text) || /seek/i.test(air.audio.text), 'AirPlay still names the seek limit');
  // DLNA streams the original file through a range proxy, so its note stays about the remote.
  assert.ok(!/download/i.test(H.trackNotes({ engine: 'dlna', torrent: true }).audio.text));
});

test('an unknown engine says nothing rather than something wrong', () => {
  assert.deepStrictEqual(H.trackNotes({ engine: 'whatever', torrent: true }), { audio: null, subs: null });
  assert.deepStrictEqual(H.trackNotes(), { audio: null, subs: null });
});

test('each cast-menu row is one short line that says where tracks are changed', () => {
  // Soda Player keeps every device row to a name and a one-word type; ours carry one extra fact, who
  // changes the audio and subtitles, and must stay short enough that the menu stays narrow.
  const rows = { 'dlna-dual': H.routeDetail('dlna', true), dlna: H.routeDetail('dlna', false), chromecast: H.routeDetail('chromecast'),
    airplay: H.routeDetail('airplay'), receiver: H.routeDetail('receiver') };
  for (const [k, t] of Object.entries(rows)) assert.ok(t.length > 0 && t.length <= 40, k + ' is ' + t.length + ' characters: ' + t);
  assert.ok(/TV/.test(rows.dlna) && /TV/.test(rows['dlna-dual']) && !/Mac/.test(rows.dlna));
  assert.ok(/4K/.test(rows['dlna-dual']) && !/4K/.test(rows.dlna));
  assert.ok(/Mac/.test(rows.chromecast) && /Mac/.test(rows.airplay));
  assert.ok(/Mac/.test(rows.receiver) && /TV/.test(rows.receiver), 'a Spritz Receiver can be changed from either');
  assert.strictEqual(H.routeDetail('nope'), '');
});

test('the full explanation moved to a tooltip', () => {
  assert.ok(/TV remote/.test(H.routeTooltip('dlna', true)) && /original file/.test(H.routeTooltip('dlna', true)));
  assert.ok(/converts/i.test(H.routeTooltip('chromecast')) && /restart/i.test(H.routeTooltip('chromecast')));
  assert.ok(/here/i.test(H.routeTooltip('airplay')));
  assert.ok(/TV remote/.test(H.routeTooltip('receiver')) && /here/.test(H.routeTooltip('receiver')));
  assert.strictEqual(H.routeTooltip('nope'), '');
  for (const k of ['dlna', 'chromecast', 'airplay', 'receiver']) assert.ok(H.routeTooltip(k, true).length > H.routeDetail(k, true).length, k + ' tooltip says more than the row');
});

test('the wording avoids jargon a viewer would not know', () => {
  const all = [H.trackNotes({ engine: 'dlna' }), H.trackNotes({ engine: 'chromecast', torrent: true }), H.trackNotes({ engine: 'receiver', torrent: true })]
    .flatMap((n) => [n.audio.text, n.subs.text]).concat(['dlna', 'chromecast', 'airplay'].map((k) => H.routeDetail(k, true)));
  for (const t of all) assert.ok(!/keyframe|HLS|EVENT|playlist|fMP4|MKV/i.test(t), t);
});
