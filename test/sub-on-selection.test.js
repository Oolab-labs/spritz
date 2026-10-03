'use strict';
const test = require('node:test');
const assert = require('node:assert');
const lan = require('../src/main/lanserver');

const OFFER = [{ name: 'e0' }, { name: 'e1' }, { name: 'e2' }];

test('the picked track is the one extracted', () => {
  assert.strictEqual(lan.pickActiveSub(OFFER, 1), 'e1');
  assert.strictEqual(lan.pickActiveSub(OFFER, 2), 'e2');
});

test('no selection extracts nothing rather than defaulting to the first', () => {
  // The whole point: a 103-cue signs track used to win by being first in the file.
  assert.strictEqual(lan.pickActiveSub(OFFER, -1), null);
  assert.strictEqual(lan.pickActiveSub(OFFER, null), null);
  assert.strictEqual(lan.pickActiveSub(OFFER, undefined), null);
});

test('an out-of-range pick extracts nothing rather than the first', () => {
  assert.strictEqual(lan.pickActiveSub(OFFER, 3), null);
  assert.strictEqual(lan.pickActiveSub(OFFER, 99), null);
});

test('an empty offer is not a crash', () => {
  assert.strictEqual(lan.pickActiveSub([], 0), null);
  assert.strictEqual(lan.pickActiveSub(null, 0), null);
});

test('a receiver-side pick is adopted', () => {
  assert.strictEqual(lan.receiverSubPick([1002], 3, -1), 2);
  assert.strictEqual(lan.receiverSubPick([1000], 3, 2), 0);
});

test('no change reports no change, so a re-cast is not triggered every frame', () => {
  assert.strictEqual(lan.receiverSubPick([1001], 3, 1), null);
  assert.strictEqual(lan.receiverSubPick([], 3, -1), null);
});

test('subtitles switched off on the remote is a real change to -1', () => {
  assert.strictEqual(lan.receiverSubPick([], 3, 1), -1);
});

test('ids outside our sideloaded range are not ours', () => {
  // Audio ids and receiver-discovered embedded tracks must not be read as a subtitle pick.
  assert.strictEqual(lan.receiverSubPick([1, 2, 3], 3, -1), null);
  assert.strictEqual(lan.receiverSubPick([1099], 3, -1), null);
});

test('a missing or empty track list never triggers a re-cast', () => {
  assert.strictEqual(lan.receiverSubPick(null, 3, 1), null);
  assert.strictEqual(lan.receiverSubPick([1000], 0, -1), null);
});

// --- HLS discontinuity alignment (AirPlay -12312) ---
test('a playlist opening with a discontinuity is detected', () => {
  const pl = '#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-MAP:URI="init_0.mp4"\n#EXT-X-DISCONTINUITY\n#EXTINF:2.002,\nseg00000.m4s\n';
  assert.strictEqual(lan.opensWithDiscontinuity(pl), true);
});

test('an unseeked playlist reports none, so we do not invent one', () => {
  const pl = '#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-MAP:URI="init_0.mp4"\n#EXTINF:2.002,\nseg00000.m4s\n';
  assert.strictEqual(lan.opensWithDiscontinuity(pl), false);
});

test('a discontinuity AFTER the first segment is not a leading one', () => {
  // Mid-stream discontinuities are normal and must not change segment 0's sequence.
  const pl = '#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:2.0,\nseg00000.m4s\n#EXT-X-DISCONTINUITY\n#EXTINF:2.0,\nseg00001.m4s\n';
  assert.strictEqual(lan.opensWithDiscontinuity(pl), false);
});

test('empty or missing input is not a discontinuity', () => {
  assert.strictEqual(lan.opensWithDiscontinuity(''), false);
  assert.strictEqual(lan.opensWithDiscontinuity(null), false);
});

// --- AirPlay downscale box (-11870 "Cannot Decode" on wider-than-16:9 sources) ---
test('a 2:1 source is bounded to the panel width, not just the height', () => {
  // 3840x1920 used to emit 2160x1080 — wider than the 1920 panel, and H.264 Level 5.0.
  assert.deepStrictEqual(lan.airplayScaleBox(1080, 3840, 1920), { scale: true, w: 1920, h: 960 });
});

test('ultrawide already at the height cap is still too wide, and is scaled', () => {
  // The height-only gate skipped this entirely: 1080 is not < 1080, so it passed through at 2560 wide.
  assert.deepStrictEqual(lan.airplayScaleBox(1080, 2560, 1080), { scale: true, w: 1920, h: 810 });
});

test('ordinary 16:9 content is untouched by the width bound', () => {
  assert.deepStrictEqual(lan.airplayScaleBox(1080, 3840, 2160), { scale: true, w: 1920, h: 1080 });
  assert.strictEqual(lan.airplayScaleBox(1080, 1920, 1080).scale, false);
  assert.strictEqual(lan.airplayScaleBox(1080, 1280, 720).scale, false);
});

test('portrait video is bounded by height and stays that way', () => {
  const r = lan.airplayScaleBox(1080, 1080, 1920);
  assert.strictEqual(r.h, 1080);
  assert.ok(r.w <= 1920 && r.w % 2 === 0);
});

test('a 4K-capable receiver keeps 4K rather than being pulled to 1920', () => {
  assert.strictEqual(lan.airplayScaleBox(2160, 3840, 2160).scale, false);
});

test('output dimensions are always even', () => {
  for (const [w, h] of [[3841, 1621], [1999, 1001], [2560, 1073]]) {
    const r = lan.airplayScaleBox(1080, w, h);
    assert.strictEqual(r.w % 2, 0); assert.strictEqual(r.h % 2, 0);
  }
});

test('the width bound comes from the receiver, not the source height', () => {
  // Regression: deriving capW from encPlan.targetHeight (= source height when no downscale is
  // needed) shrank a 2.40:1 scope release to 1422x592 — 45% of its pixels, for nothing.
  assert.strictEqual(lan.airplayScaleBox(1080, 1920, 800).scale, false);
  assert.strictEqual(lan.airplayScaleBox(1080, 1920, 1072).scale, false);
  assert.strictEqual(lan.airplayScaleBox(1080, 1280, 536).scale, false);
});

// --- master playlist shape (AirPlay refused a master describing the picture) ---
test('the multi-audio STREAM-INF is reduced to the proven shape', () => {
  const inp = '#EXT-X-STREAM-INF:BANDWIDTH=704000,RESOLUTION=3840x2160,CODECS="hvc1.2.4.L150.90,ec-3",AUDIO="group_aud",SUBTITLES="subs"';
  const out = lan.minimalStreamInf(inp);
  assert.ok(!/RESOLUTION/.test(out), 'RESOLUTION must be gone');
  assert.ok(!/CODECS/.test(out), 'CODECS must be gone');
  assert.ok(/BANDWIDTH=704000/.test(out));
  assert.ok(/AUDIO="group_aud"/.test(out));
  assert.ok(/SUBTITLES="subs"/.test(out));
});

test('a quoted comma inside CODECS does not split the attribute list', () => {
  // CODECS="hvc1...,ec-3" contains a comma; a naive split would leave a stray `ec-3"` fragment.
  const out = lan.minimalStreamInf('#EXT-X-STREAM-INF:BANDWIDTH=1,CODECS="a.1,b.2",AUDIO="g"');
  assert.strictEqual(out, '#EXT-X-STREAM-INF:BANDWIDTH=1,AUDIO="g"');
});

test('a STREAM-INF with no BANDWIDTH still gets one, because it is required', () => {
  assert.ok(/BANDWIDTH=/.test(lan.minimalStreamInf('#EXT-X-STREAM-INF:RESOLUTION=1920x1080')));
});

test('VIDEO-RANGE and FRAME-RATE are dropped too', () => {
  const out = lan.minimalStreamInf('#EXT-X-STREAM-INF:BANDWIDTH=9,VIDEO-RANGE=PQ,FRAME-RATE=23.976,RESOLUTION=3840x2160');
  assert.strictEqual(out, '#EXT-X-STREAM-INF:BANDWIDTH=9');
});


// --- subtitle rendition budget ---
test('every track of the primary language survives the cap', () => {
  // The bug: one-per-language kept English #1 (a 103-cue signs track) and dropped the two real
  // dialogue tracks. Offering all 40 instead made AVFoundation refuse the master outright.
  const list = [];
  for (const l of ['eng', 'eng', 'eng', 'spa', 'spa', 'fra', 'deu', 'ita', 'por', 'bul', 'cze']) list.push({ lang: l });
  const out = lan.capSubSources(list, 8);
  assert.strictEqual(out.length, 8);
  assert.strictEqual(out.filter((s) => s.lang === 'eng').length, 3, 'all three English tracks kept');
  assert.strictEqual(new Set(out.map((s) => s.lang)).size, 6, 'plus one each of five other languages');
});

test('a list within the cap is returned untouched', () => {
  const list = [{ lang: 'eng' }, { lang: 'fra' }];
  assert.deepStrictEqual(lan.capSubSources(list, 8), list);
});

test('a single language does not exceed the budget', () => {
  const list = Array.from({ length: 20 }, () => ({ lang: 'eng' }));
  assert.strictEqual(lan.capSubSources(list, 8).length, 8);
});
