'use strict';

// Will this file play on that television?
//
// Until now the only way to answer that was to cast it and look. The rules lived inside two
// argument-building functions in lanserver.js that could not run without ffmpeg and a real file,
// so the behaviour was only ever observed end-to-end, one television at a time.
//
// These are the cases that produced the rules — several of them are failures that actually
// happened, and the comments in lanserver.js name them. Pinning them here means the next person to
// touch the decision finds out in milliseconds rather than in the living room.

const { test } = require('node:test');
const assert = require('assert');
const { planPlayback, explain } = require('../src/main/playback-planner');
const { defaultProfile, fromMdns, fromEureka, normalise } = require('../src/main/device-profile');

// --- media fixtures, all shapes the probe actually returns ---
const H264_1080 = { vcodec: 'h264', height: 1080, hdr: false, audio: [{ codec: 'aac', channels: 2 }], subs: [] };
const HEVC_4K_HDR = { vcodec: 'hevc', height: 2160, hdr: true, audio: [{ codec: 'eac3', channels: 6 }], subs: [] };
const HEVC_1080 = { vcodec: 'hevc', height: 1080, hdr: false, audio: [{ codec: 'aac', channels: 2 }], subs: [] };
const H264_4K = { vcodec: 'h264', height: 2160, hdr: false, audio: [{ codec: 'aac', channels: 2 }], subs: [] };
const AV1_1080 = { vcodec: 'av1', height: 1080, hdr: false, audio: [{ codec: 'opus', channels: 2 }], subs: [] };
const MKV_TRUEHD = { vcodec: 'hevc', height: 1080, hdr: false, audio: [{ codec: 'truehd', channels: 8 }], subs: [] };
const WITH_PGS = { ...HEVC_1080, subs: [{ name: 'English', bitmap: true }, { name: 'French', bitmap: false }] };

// --- device fixtures ---
const UNKNOWN = defaultProfile();                                   // conservative: 1080p, AAC
const LG_4K = fromMdns('LG OLED TV', 'OLED65C1');                   // inferred 4K TV
const CAST_1080 = fromEureka({ name: 'Living Room', device_info: { model_name: 'Chromecast', '4k_blocked': 1 } });
const CAST_4K = fromEureka({ name: 'Shield', device_info: { model_name: 'Google TV', '4k_blocked': 0 } });

test('a 4K HDR HEVC file plays untouched on a capable TV', () => {
  const p = planPlayback(HEVC_4K_HDR, LG_4K);
  assert.strictEqual(p.video, 'copy');
  assert.strictEqual(p.audio, 'copy', 'E-AC3 is passthrough on a TV — a stereo downmix would be a loss');
  assert.strictEqual(p.hdr, 'preserve');
  assert.strictEqual(p.targetHeight, 2160, 'a 4K receiver keeps 4K');
  assert.ok(p.lossless);
});

test('the same file is downscaled and tonemapped for a 1080p receiver', () => {
  const p = planPlayback(HEVC_4K_HDR, CAST_1080);
  assert.strictEqual(p.video, 'transcode');
  assert.strictEqual(p.targetHeight, 1080);
  assert.strictEqual(p.hdr, 'tonemap');
  assert.ok(p.tonemap);
  assert.ok(p.reasons.some((r) => /HDR/i.test(r)), 'must say why: ' + p.reasons.join(' | '));
});

test('HDR is never kept for a receiver that cannot decode HEVC', () => {
  // The dongle that reports HDR10 but is H.264-only. Keeping HDR means emitting HEVC, which it
  // cannot decode, and there is no fallback — it just fails. (lanserver Audit H5.)
  const oddball = normalise({ hevc: false, hdr10: true, maxHeight: 1080 });
  const p = planPlayback({ ...HEVC_4K_HDR, height: 1080 }, oddball);
  assert.strictEqual(p.hdr, 'tonemap', 'must not emit HEVC to an H.264-only receiver');
  assert.strictEqual(p.video, 'transcode');
});

test('a 4K-capable receiver is not needlessly forced to 1080p', () => {
  // (lanserver Audit M9.) Downscale only ABOVE the receiver's limit, and to that limit.
  const p = planPlayback(H264_4K, CAST_4K);
  assert.strictEqual(p.targetHeight, 2160);
  assert.strictEqual(p.video, 'copy');
});

test('1088-tall encodes are not mistaken for 4K', () => {
  // Some 1080p encodes are 1088 tall from macroblock padding.
  const p = planPlayback({ ...H264_1080, height: 1088 }, UNKNOWN);
  assert.strictEqual(p.video, 'copy', 'must not be treated as too tall');
});

test('AV1 is re-encoded even though modern receivers can decode it', () => {
  // Decodable but not muxable into fMP4 the way Cast and AirPlay want. The DLNA route serves the
  // original instead; this path cannot.
  const p = planPlayback(AV1_1080, LG_4K);
  assert.strictEqual(p.video, 'transcode');
  assert.ok(p.reasons.some((r) => /AV1/.test(r)));
});

test('TrueHD is converted while surround is preserved at a sane bitrate', () => {
  const p = planPlayback(MKV_TRUEHD, LG_4K);
  assert.strictEqual(p.audio, 'transcode');
  assert.strictEqual(p.video, 'copy', 'audio trouble must not drag the video into a re-encode');
  assert.strictEqual(p.audioTracks[0].bitrate, '384k', '8 channels is not a 160k stereo job');
  assert.ok(p.reasons.some((r) => /truehd/i.test(r)));
});

test('an unknown device gets the conservative treatment, not the optimistic one', () => {
  // Guessing a receiver is MORE capable than it is produces a black screen; guessing lower costs
  // a re-encode. The asymmetry is the whole reason the default is what it is.
  const p = planPlayback(HEVC_4K_HDR, UNKNOWN);
  assert.strictEqual(p.targetHeight, 1080);
  assert.strictEqual(p.video, 'transcode');
});

test('an unprobed source starts optimistically rather than refusing', () => {
  // A just-started torrent has no probe yet. Historical behaviour: assume copy and let the
  // software fallback rescue it. Refusing to start would be worse.
  const p = planPlayback(null, LG_4K);
  assert.ok(p.speculative);
  assert.strictEqual(p.video, 'copy');
  assert.ok(p.reasons.some((r) => /not probed/i.test(r)));
});

// --- the plan must describe a command ffmpeg could actually run ---
//
// `-c:v copy` makes ffmpeg return before any filter or pixel-format flag is built, so on the copy
// path there is no scaling and no tonemapping and the HDR metadata rides along in the bitstream.
// A plan that says copy AND tonemap, or copy AND downscale, describes nothing.

test('an H.264 HDR file copied to an H.264-only HDR10 receiver keeps its HDR', () => {
  // The counterpart to the H5 case above: there the source was HEVC and had to be re-encoded, and
  // the encode cannot emit HDR10 without HEVC. Here nothing is re-encoded — the receiver says it
  // displays HDR10, and the bitstream reaches it untouched. Reporting 'tonemap' for a stream being
  // copied bit-for-bit would be a plan that contradicts itself.
  const dongle = normalise({ hevc: false, hdr10: true, maxHeight: 1080 });
  const p = planPlayback({ ...H264_1080, hdr: true }, dongle);
  assert.strictEqual(p.video, 'copy');
  assert.strictEqual(p.hdr, 'preserve');
  assert.strictEqual(p.tonemap, false);
});

test('a copied 1088-tall encode is not reported as downscaled', () => {
  // The two thresholds disagree on purpose: copy-eligibility is >1088, scaling is >maxHeight
  // (1080). 1088 is therefore copyable and above the scale cap — and being copied, it goes out at
  // 1088. Claiming 1080 would be describing a scale filter the pipeline never adds.
  const p = planPlayback({ ...H264_1080, height: 1088 }, UNKNOWN);
  assert.strictEqual(p.video, 'copy');
  assert.strictEqual(p.targetHeight, 1088);
});

test('an 8K source is not copied to a 4K receiver', () => {
  // DELIBERATE DIVERGENCE from the shipped lanserver.js, which is wrong here. Copy-eligibility is
  // decided there by h264_4k/hevc4k plus the 1088 threshold, none of which can tell 2160 from 4320,
  // so a receiver reporting maxHeight 2160 gets an 8K bitstream copied to it and fails to decode.
  // The sw-retry ladder cannot rescue that: the copy "succeeded" as far as ffmpeg is concerned.
  const p = planPlayback({ ...H264_4K, height: 4320 }, CAST_4K);
  assert.strictEqual(p.video, 'transcode', '8K must not be copied to a 2160p receiver');
  assert.strictEqual(p.targetHeight, 2160);
  // and the 1088 padding tolerance survives it
  assert.strictEqual(planPlayback({ ...H264_1080, height: 1088 }, UNKNOWN).video, 'copy');
});

test('an unprobed source still plans the audio it can see', () => {
  // vcodec:null is the video-stream-not-yet-seen case, not the nothing-is-known case: the audio
  // list comes from the same probe record and ffmpeg will act on it. A stub reply here claimed
  // lossless passthrough of a TrueHD track that was about to become 384k AAC, and left audioTracks
  // undefined for callers to iterate.
  const p = planPlayback({ vcodec: null, height: 1080, hdr: false, audio: [{ codec: 'truehd', channels: 8 }], subs: [] }, LG_4K);
  assert.ok(p.speculative);
  assert.strictEqual(p.video, 'copy');
  assert.strictEqual(p.audio, 'transcode', 'TrueHD is re-encoded whether or not the video codec is known');
  assert.strictEqual(p.audioTracks[0].bitrate, '384k');
  assert.strictEqual(p.lossless, false);
  assert.strictEqual(p.targetHeight, 1080, 'the height is known even when the codec is not');
});

test('bitmap subtitles burn in, text subtitles sideload', () => {
  const p = planPlayback(WITH_PGS, LG_4K);
  assert.strictEqual(p.subtitles[0].action, 'burn', 'PGS cannot become WebVTT');
  assert.strictEqual(p.subtitles[1].action, 'sideload-webvtt');
});

test('without libass, bitmap subtitles are reported unavailable rather than silently dropped', () => {
  const p = planPlayback(WITH_PGS, LG_4K, { canBurnIn: false });
  assert.strictEqual(p.subtitles[0].action, 'unavailable');
  assert.ok(p.reasons.some((r) => /Image-based/i.test(r)));
});

test('an ffmpeg without zscale is flagged as approximate, not silently wrong', () => {
  const p = planPlayback(HEVC_4K_HDR, CAST_1080, { canTonemap: false });
  assert.strictEqual(p.tonemap, true);
  assert.strictEqual(p.tonemapAccurate, false);
  assert.ok(p.reasons.some((r) => /zscale/i.test(r)));
});

test('every plan explains itself in one plain sentence', () => {
  assert.match(explain(planPlayback(HEVC_4K_HDR, LG_4K)), /untouched/);
  assert.match(explain(planPlayback(MKV_TRUEHD, LG_4K)), /only the audio/);
  assert.match(explain(planPlayback(AV1_1080, UNKNOWN)), /Converting/);
  assert.match(explain(planPlayback(null, LG_4K)), /Starting/);
});

test('the plan always carries a reason for what it decided', () => {
  for (const media of [H264_1080, HEVC_4K_HDR, HEVC_1080, H264_4K, AV1_1080, MKV_TRUEHD]) {
    for (const dev of [UNKNOWN, LG_4K, CAST_1080, CAST_4K]) {
      const p = planPlayback(media, dev);
      assert.ok(p.reasons.length > 0, 'no reason given for ' + media.vcodec + ' on ' + dev.source);
    }
  }
});

// --- device profile provenance ---

test('a reported capability outranks one guessed from the name', () => {
  assert.strictEqual(CAST_4K.source, 'reported', '4k_blocked=0 is the device telling us');
  assert.strictEqual(LG_4K.source, 'inferred-from-name', 'OLED in a name is a guess');
  // Which matters for anything that later learns from failures: a guess may be revised, a user
  // override must not be.
  const { outranks } = require('../src/main/device-profile');
  assert.ok(outranks(CAST_4K, LG_4K));
  assert.ok(!outranks(LG_4K, CAST_4K));
  assert.ok(!outranks(CAST_4K, normalise({ source: 'user-override' })));
});

test('a device that says it is 4K-blocked is believed over its name', () => {
  // "Chromecast" with 4k_blocked=1 — the name says nothing, the field says 1080p.
  assert.strictEqual(CAST_1080.hevc4k, false);
  assert.strictEqual(CAST_1080.maxHeight, 1080);
});

test('normalise fills gaps conservatively and accepts the old loose shapes', () => {
  const fromOldCode = normalise({ hevc: true, hevc4k: true, audioCopy: new Set(['aac', 'ac3']), maxHeight: 2160 });
  assert.deepStrictEqual(fromOldCode.audioCopy, ['aac', 'ac3'], 'a Set is what lanserver used to pass');
  assert.strictEqual(normalise({}).maxHeight, 1080, 'missing means conservative');
  assert.strictEqual(normalise(null).source, 'default');
  assert.strictEqual(normalise({ maxHeight: -5 }).maxHeight, 1080, 'nonsense means conservative');
});
