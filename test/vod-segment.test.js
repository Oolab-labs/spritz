'use strict';

// Segment production. The unit tests below are cheap, but the one that matters is the last one:
// it actually runs ffmpeg and checks that four independently produced segments form a timeline
// that ADVANCES. That is the failure -copyts exists to prevent, it is invisible in any single
// segment, and no amount of inspecting the argument list would catch its absence — which is
// precisely why it is worth the seconds it costs.

const { test } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { segmentArgs, segmentRunArgs, runSegmentReady, presegmentArgs, keyframeArgs, parseKeyframes, segmentPath } = require('../src/main/vod-segment');
const { segmentsFromKeyframes } = require('../src/main/hls-vod');

const args = (over) => segmentArgs(Object.assign({
  input: '/movies/Film.mkv', span: { start: 30, duration: 6 }, out: '/tmp/3.ts'
}, over));

test('the cut is absolute, not a length — -to is the END of the span', () => {
  const a = args();
  assert.equal(a[a.indexOf('-to') + 1], '36', 'start 30 + duration 6');
  assert.equal(a[a.indexOf('-ss') + 1], '30');
});

test('-copyts is present, because without it every segment claims the same instant', () => {
  // Measured on a 40s fixture: four consecutive segments cut without this began at PTS 1.480,
  // 1.485, 1.500 and 1.493. With it: 1.480, 11.400, 21.400, 31.400.
  assert.ok(args().includes('-copyts'));
});

test('-ss comes BEFORE -i, so the seek is the fast one', () => {
  const a = args();
  assert.ok(a.indexOf('-ss') < a.indexOf('-i'), 'an output-side seek would decode everything before the segment');
});

test('the video is always copied; only the audio may be re-encoded', () => {
  const copied = args();
  assert.equal(copied[copied.indexOf('-c:v') + 1], 'copy');
  assert.equal(copied[copied.indexOf('-c:a') + 1], 'copy');
  const reAudio = args({ copyAudio: false });
  assert.equal(reAudio[reAudio.indexOf('-c:v') + 1], 'copy', 'the video copy is never given up here');
  assert.equal(reAudio[reAudio.indexOf('-c:a') + 1], 'aac');
  assert.ok(reAudio.includes('-b:a'));
});

test('nonsense produces no command rather than a wrong one', () => {
  assert.equal(segmentArgs(), null);
  assert.equal(args({ span: { start: -1, duration: 6 } }), null);
  assert.equal(args({ span: { start: 0, duration: 0 } }), null);
  assert.equal(args({ span: { start: NaN, duration: 6 } }), null);
  assert.equal(args({ input: null }), null);
});

test('keyframe timestamps survive ffprobe formatting quirks', () => {
  assert.deepEqual(parseKeyframes('0.000000\n10.000000,\n20.000000\n'), [0, 10, 20]);
  assert.deepEqual(parseKeyframes('10.5\n\nN/A\n0\n'), [0, 10.5], 'a frame with no timestamp is dropped, not turned into NaN');
  assert.deepEqual(parseKeyframes(''), []);
  assert.deepEqual(parseKeyframes(null), []);
});

test('the keyframe probe decodes nothing', () => {
  const a = keyframeArgs('/movies/Film.mkv');
  assert.ok(a.includes('-skip_frame'));
  assert.equal(a[a.indexOf('-skip_frame') + 1], 'nokey');
  assert.equal(keyframeArgs(), null);
});

test('a segment path is derived in one place', () => {
  assert.equal(segmentPath('/tmp/vod', 3), '/tmp/vod/3.ts');
  assert.equal(segmentPath('/tmp/vod', -1), null);
  assert.equal(segmentPath('/tmp/vod', 1.5), null);
  assert.equal(segmentPath(null, 0), null);
});

// ---- the one that would actually have caught it -----------------------------------------------

const FFMPEG = ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg'].find((p) => fs.existsSync(p));
const FFPROBE = ['/opt/homebrew/bin/ffprobe', '/usr/local/bin/ffprobe', '/usr/bin/ffprobe'].find((p) => fs.existsSync(p));

test('independently produced segments form a timeline that ADVANCES', { skip: (!FFMPEG || !FFPROBE) && 'ffmpeg not installed' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spritz-vod-test-'));
  try {
    // 40 seconds, a keyframe every 10, so the segment boundaries are unambiguous.
    const src = path.join(dir, 'fixture.mp4');
    execFileSync(FFMPEG, ['-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=25:duration=40',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=40',
      '-c:v', 'libx264', '-g', '250', '-keyint_min', '250', '-sc_threshold', '0',
      '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', src]);

    // The real pipeline: probe the keyframes, let hls-vod.js decide the segments, produce each one.
    const keys = parseKeyframes(execFileSync(FFPROBE, keyframeArgs(src)).toString());
    assert.deepEqual(keys, [0, 10, 20, 30], 'the fixture must have the keyframes the rest of this assumes');

    const segments = segmentsFromKeyframes(keys, 40, 6);
    assert.equal(segments.length, 4);

    const firstPts = segments.map((span, i) => {
      const out = segmentPath(dir, i);
      execFileSync(FFMPEG, segmentArgs({ input: src, span, out }));
      const raw = execFileSync(FFPROBE, ['-v', 'error', '-select_streams', 'v',
        '-show_entries', 'packet=pts_time', '-read_intervals', '%+#1', '-of', 'csv=p=0', out]).toString();
      return parseKeyframes(raw)[0];
    });

    // THE ASSERTION. Without -copyts every one of these is ~1.48 and the film never progresses.
    for (let i = 1; i < firstPts.length; i++) {
      assert.ok(firstPts[i] > firstPts[i - 1] + 5,
        'segment ' + i + ' starts at ' + firstPts[i] + ', barely after segment ' + (i - 1) +
        ' at ' + firstPts[i - 1] + ' — the timeline is not advancing');
    }
    // Stronger, and what actually makes subtitles possible: each segment's PTS IS the source time
    // the playlist places it at. Without -muxdelay/-muxpreload these are all 1.4s late, which no
    // amount of video-only checking would reveal.
    segments.forEach((span, i) => {
      assert.ok(Math.abs(firstPts[i] - span.start) < 0.05,
        'segment ' + i + ' is placed at ' + span.start + 's by the playlist but its media clock says ' + firstPts[i]);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- eligibility ------------------------------------------------------------------------------

const { vodEligible } = require('../src/main/vod-segment');

const okPlan = { video: 'copy', audioTracks: [{ action: 'copy' }] };
const okInfo = { vcodec: 'hevc' };

test('a pure copy with compatible audio is eligible, and copies the audio', () => {
  const r = vodEligible(okPlan, okInfo);
  assert.equal(r.ok, true);
  assert.equal(r.copyAudio, true);
});

test('incompatible AUDIO does not disqualify — it just gets re-encoded', () => {
  // Re-encoding one audio track is cheap and leaves the video copy untouched, which is the only
  // thing this path actually depends on.
  const r = vodEligible({ video: 'copy', audioTracks: [{ action: 'encode' }] }, okInfo);
  assert.equal(r.ok, true);
  assert.equal(r.copyAudio, false);
});

test('anything that would change a video byte is refused, with the reason', () => {
  for (const patch of [{ video: 'encode' }, { tonemap: true }, { stripDovi: true }, { speculative: true }, { burnSub: 2 }]) {
    const r = vodEligible(Object.assign({}, okPlan, patch), okInfo);
    assert.equal(r.ok, false, JSON.stringify(patch) + ' should be refused');
    assert.ok(r.why && r.why.length > 5, 'a refusal must say why');
  }
});

test('an unreadable source is refused rather than copied hopefully', () => {
  assert.equal(vodEligible(okPlan, {}).ok, false);
  assert.equal(vodEligible(okPlan, null).ok, false);
  assert.equal(vodEligible(null, okInfo).ok, false);
});

test('a file with subtitles is accepted — they are carried as renditions', () => {
  assert.equal(vodEligible(okPlan, { vcodec: 'hevc', subs: [{ lang: 'eng' }] }).ok, true);
});

test('a file with several audio tracks becomes several renditions', () => {
  const r = vodEligible(okPlan, { vcodec: 'hevc', audio: [{ codec: 'eac3', lang: 'eng' }, { codec: 'aac', lang: 'jpn' }] });
  assert.equal(r.ok, true);
  assert.equal(r.splitAudio, true, 'two tracks cannot both be muxed into one segment');
  assert.equal(r.audioTracks.length, 2);
  assert.equal(r.audioTracks[1].lang, 'jpn');
});

test('one audio track keeps the simpler muxed shape', () => {
  const r = vodEligible(okPlan, { vcodec: 'hevc', audio: [{ codec: 'eac3', lang: 'eng' }] });
  assert.equal(r.splitAudio, false, 'splitting one track costs a second fetch stream for nothing');
});

test('each audio rendition carries the plan for ITS OWN stream', () => {
  // One flag for every track would re-encode a compatible one or copy an incompatible one; which
  // of those happens depends on track order, which is the worst kind of bug to chase.
  const plan = { video: 'copy', audioTracks: [{ action: 'copy' }, { action: 'encode' }] };
  const r = vodEligible(plan, { vcodec: 'hevc', audio: [{ codec: 'eac3' }, { codec: 'truehd' }] });
  assert.equal(r.audioTracks[0].copy, true);
  assert.equal(r.audioTracks[1].copy, false);
});

test('one audio track and no subtitles is the case this path does carry', () => {
  assert.equal(vodEligible(okPlan, { vcodec: 'hevc', audio: [{ codec: 'eac3' }], subs: [] }).ok, true);
});

test('audio-only and video-only segments are cut on the SAME boundaries as the muxed ones', () => {
  // An audio rendition that did not line up segment-for-segment with the video would land a
  // language switch somewhere other than where the film already is.
  const span = { start: 30, duration: 6 };
  const v = segmentArgs({ input: 'i.mkv', span, out: 'v.ts', kind: 'video' });
  const a = segmentArgs({ input: 'i.mkv', span, out: 'a.ts', kind: 'audio', audioTrack: 1 });
  assert.equal(v[v.indexOf('-ss') + 1], a[a.indexOf('-ss') + 1]);
  assert.equal(v[v.indexOf('-to') + 1], a[a.indexOf('-to') + 1]);
  assert.ok(v.includes('-an'), 'a video rendition must not carry audio too');
  assert.ok(a.includes('-vn'));
  assert.equal(a[a.indexOf('-map') + 1], '0:a:1');
  assert.ok(a.includes('-copyts') && a.includes('-muxdelay'), 'the clock rules apply to every kind');
});

test('an unknown segment kind produces nothing rather than a muxed guess', () => {
  assert.equal(segmentArgs({ input: 'i.mkv', span: { start: 0, duration: 6 }, out: 'o.ts', kind: 'both' }), null);
  assert.equal(segmentArgs({ input: 'i.mkv', span: { start: 0, duration: 6 }, out: 'o.ts', kind: 'audio', audioTrack: -1 }), null);
});

test('the master names an audio group and marks exactly one default', () => {
  const m = buildVodMaster({ mediaUrl: 'media.m3u8', audio: [
    { playlist: 'audio_0.m3u8', lang: 'eng', name: 'English', default: true },
    { playlist: 'audio_1.m3u8', lang: 'jpn', name: 'Japanese' }
  ] });
  assert.equal((m.match(/#EXT-X-MEDIA:TYPE=AUDIO/g) || []).length, 2);
  assert.equal((m.match(/DEFAULT=YES/g) || []).length, 1, 'no default is silence; two is ambiguous');
  assert.ok(m.includes('AUDIO="aud"'), 'the variant must reference the group');
});

test('a film with one audio track gets no audio group at all', () => {
  const m = buildVodMaster({ mediaUrl: 'media.m3u8', audio: [] });
  assert.ok(!m.includes('AUDIO="aud"'));
  assert.ok(!m.includes('TYPE=AUDIO'));
});

// ---- master playlist and subtitle renditions ---------------------------------------------------

const { subPlaylist, subExtractArgs, buildVodMaster, VTT_HEAD } = require('../src/main/vod-segment');

test('a subtitle rendition is one whole-film cue file in a finished playlist', () => {
  const pl = subPlaylist('sub_0_eng.vtt', 7200);
  assert.ok(pl.includes('#EXT-X-PLAYLIST-TYPE:VOD'));
  assert.ok(pl.includes('#EXT-X-ENDLIST'));
  assert.ok(pl.includes('sub_0_eng.vtt'));
  assert.equal((pl.match(/#EXTINF:/g) || []).length, 1, 'there is no reason to cut subtitles up');
  // TARGETDURATION must be an integer and not less than the segment it describes.
  assert.ok(/#EXT-X-TARGETDURATION:7200\b/.test(pl), pl);
  assert.equal(subPlaylist('x.vtt', 0), null);
  assert.equal(subPlaylist(null, 100), null);
});

test('the timestamp map anchors cues at zero, which the muxer delay fix makes true', () => {
  assert.ok(VTT_HEAD.startsWith('WEBVTT'));
  assert.ok(VTT_HEAD.includes('X-TIMESTAMP-MAP=MPEGTS:0,LOCAL:00:00:00.000'));
});

test('extraction targets one track by index', () => {
  const a = subExtractArgs('/movies/Film.mkv', 2, '/tmp/sub_2.vtt');
  assert.equal(a[a.indexOf('-map') + 1], '0:s:2');
  assert.equal(a[a.indexOf('-c:s') + 1], 'webvtt');
  assert.equal(subExtractArgs('/movies/Film.mkv', -1, '/tmp/x.vtt'), null);
  assert.equal(subExtractArgs(null, 0, '/tmp/x.vtt'), null);
});

test('the master lists every subtitle track and links the group to the variant', () => {
  const m = buildVodMaster({ mediaUrl: 'media.m3u8', width: 1920, height: 1080, subs: [
    { playlist: 'sub_0_eng.m3u8', lang: 'eng', name: 'English' },
    { playlist: 'sub_1_fre.m3u8', lang: 'fre', name: 'French' }
  ] });
  assert.equal((m.match(/#EXT-X-MEDIA:TYPE=SUBTITLES/g) || []).length, 2);
  assert.ok(m.includes('SUBTITLES="subs"'), 'the variant must reference the group or nothing shows');
  assert.ok(m.includes('RESOLUTION=1920x1080'));
  assert.ok(m.trim().endsWith('media.m3u8'));
});

test('no subtitle track is ever DEFAULT or AUTOSELECT', () => {
  // Turning subtitles on unasked is a worse failure than making the viewer choose.
  const m = buildVodMaster({ mediaUrl: 'media.m3u8', subs: [{ playlist: 'a.m3u8', lang: 'eng', name: 'English' }] });
  assert.ok(m.includes('DEFAULT=NO'));
  assert.ok(m.includes('AUTOSELECT=NO'));
  assert.ok(!/DEFAULT=YES|AUTOSELECT=YES/.test(m));
});

test('a film with no subtitles gets a master with no group reference', () => {
  const m = buildVodMaster({ mediaUrl: 'media.m3u8', subs: [] });
  assert.ok(!m.includes('SUBTITLES='), 'referencing an empty group is a playlist a receiver may reject');
  assert.ok(m.includes('#EXT-X-STREAM-INF:'));
  assert.equal(buildVodMaster({}), null);
});

test('CODECS is stated only when the caller knows it', () => {
  assert.ok(!buildVodMaster({ mediaUrl: 'media.m3u8' }).includes('CODECS='));
  assert.ok(buildVodMaster({ mediaUrl: 'media.m3u8', codecs: 'hvc1.2.4.L150.90' }).includes('CODECS="hvc1.2.4.L150.90"'));
});


// ---- what a cut on an open-GOP source actually does ---------------------------------------------

// x265 with B-pyramids and an open GOP — what a real WEBRip release turned out to be, and a shape
// the simple fixtures above do not have.
function openGopFixture(dir) {
  const src = path.join(dir, 'opengop.mkv');
  execFileSync(FFMPEG, ['-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=25:duration=60',
    '-c:v', 'libx265', '-preset', 'medium',
    '-x265-params', 'keyint=50:min-keyint=50:bframes=8:b-pyramid=1:open-gop=1:scenecut=0',
    '-pix_fmt', 'yuv420p10le', '-f', 'matroska', src]);
  return src;
}

test('an open-GOP cut starts EARLY, and still covers everything the playlist promised', { skip: (!FFMPEG || !FFPROBE) && 'ffmpeg not installed', timeout: 300000 }, () => {
  // Characterising a real limit, not asserting a wish.
  //
  // On an open-GOP source a stream copy CANNOT begin at an arbitrary keyframe. The keyframe is a CRA
  // whose leading pictures reference the previous IRAP, so ffmpeg backs up to that one and the
  // segment opens a whole keyframe interval early. Measured on this fixture by sweeping the seek:
  //
  //   -ss 11.70 … 12.10  → first PTS 10.000     (the keyframe at 12 is never the first frame)
  //   -ss 13.90 … 14.00  → first PTS 12.000
  //
  // A step function offset by one keyframe, so no choice of seek target lands on the boundary. This
  // was investigated because a 100-minute HEVC WEBRip stuttered through the VOD route at 68% of
  // realtime while the same file range-served to the same television played at exactly 1:1; on that
  // file consecutive segments overlapped by 1.9-10.4s. Seeking by the keyframe's DTS was tried and
  // does NOT fix it — it lands one keyframe early too, and on timestamps read from the frame-level
  // probe (whose PTS and DTS columns are out of step) it can overshoot into a GAP, which is worse.
  //
  // So vod-segment.js's "0.16-0.30s overlap" is a property of its closed-GOP fixture, not a general
  // bound. What IS invariant, and what this asserts, is containment: a segment may begin before its
  // span, but it must never begin AFTER it or end before it — that would be missing film.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spritz-opengop-'));
  try {
    const src = openGopFixture(dir);
    const keys = parseKeyframes(execFileSync(FFPROBE, keyframeArgs(src)).toString());
    const spans = segmentsFromKeyframes(keys, 60, 6);
    assert.ok(spans && spans.length > 3, 'the fixture should divide into several segments');

    const span = spans[2];
    const out = path.join(dir, 'seg.ts');
    execFileSync(FFMPEG, segmentArgs({ input: src, span, out }));
    const pts = execFileSync(FFPROBE, ['-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'packet=pts_time', '-of', 'csv=p=0', out]).toString()
      .split('\n').map((l) => parseFloat(l)).filter(Number.isFinite);

    const first = Math.min(...pts);
    const last = Math.max(...pts);
    assert.ok(first <= span.start + 0.001,
      'a segment must never START after its span (' + first + ' > ' + span.start + ') — that is film the receiver asked for and did not get');
    assert.ok(last >= span.start + span.duration - 0.5,
      'a segment must cover the END of its span (' + last + ' < ' + (span.start + span.duration) + ')');
    // And the lead-in is real: this is the behaviour, recorded so it is not mistaken for a bug again.
    assert.ok(first < span.start, 'expected the documented open-GOP lead-in; if this now starts exactly on the span, the cut behaviour changed and the comment above is stale');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- consecutive segments must not overlap ------------------------------------------------------

test('a segment RUN produces consecutive segments that do not overlap', { skip: (!FFMPEG || !FFPROBE) && 'ffmpeg not installed', timeout: 300000 }, () => {
  // The bug this exists to prevent, measured on hardware before it was understood.
  //
  // Cutting each segment INDEPENDENTLY gives every one of them the open-GOP lead-in characterised
  // above, so consecutive segments overlap in presentation time — by 1.9-10.4s on a real WEBRip.
  // The playlist declares no EXT-X-DISCONTINUITY, so a receiver is told the timeline is continuous
  // when every boundary steps BACKWARD. What that costs:
  //
  //   ffmpeg's own HLS demuxer  "timestamp discontinuity ... new offset= 10259700" at EVERY
  //                             boundary, accumulating 83.6s of correction over nine of them
  //   an LG webOS television    plays 130s, then livelocks — 15,107 aborted segment fetches,
  //                             alternating between the two segments whose ranges conflict
  //
  // vod-segment.js used to claim the overlap was "duplicate data at PTS a player has already seen,
  // which it drops". Nothing drops it. Producing the segments in ONE ffmpeg run removes it: one
  // decode pass means one continuous timeline, and consecutive segments abut instead of overlapping.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spritz-segrun-'));
  try {
    const src = openGopFixture(dir);
    const keys = parseKeyframes(execFileSync(FFPROBE, keyframeArgs(src)).toString());
    const spans = segmentsFromKeyframes(keys, 60, 6);
    assert.ok(spans && spans.length > 4, 'the fixture should divide into several segments');

    const from = 1;
    const count = 4;
    const args = segmentRunArgs({ input: src, spans, fromIndex: from, count, dir });
    assert.ok(args, 'segmentRunArgs should accept a valid span list');
    execFileSync(FFMPEG, args);

    const range = (i) => {
      const pts = execFileSync(FFPROBE, ['-v', 'error', '-select_streams', 'v:0',
        '-show_entries', 'packet=pts_time', '-of', 'csv=p=0', segmentPath(dir, i, '')]).toString()
        .split('\n').map((l) => parseFloat(l)).filter(Number.isFinite);
      return { first: Math.min(...pts), last: Math.max(...pts) };
    };

    for (let i = from + 1; i < from + count; i++) {
      const prev = range(i - 1);
      const cur = range(i);
      // One frame of slack: -to under -c copy includes the packet straddling the boundary, so a few
      // milliseconds of touching is expected. A whole keyframe interval is the bug.
      assert.ok(cur.first >= prev.last - 0.1,
        'segment ' + i + ' starts at ' + cur.first + ' but segment ' + (i - 1) + ' runs to ' +
        prev.last + ' — that is a ' + (prev.last - cur.first).toFixed(3) +
        's backward step at the boundary, which is the livelock');
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- when is a segment in a run finished? -------------------------------------------------------

test('a segment in a run is only complete once the run has moved past it', () => {
  // The hazard a run introduces that independent cuts did not have.
  //
  // segmentArgs runs one ffmpeg per segment, so the process exiting IS the segment being finished.
  // A run writes its files progressively: while ffmpeg is producing segment 5, the file for segment
  // 5 already exists on disk and is STILL BEING WRITTEN. Serving it because it exists would hand the
  // receiver a truncated segment — a worse failure than the overlap this whole change removes,
  // because it looks like corrupt media rather than a stall.
  //
  // The rule: a segment is complete when the NEXT one has been started, or when the run has ended.
  const exists = new Set([3, 4, 5]);
  const has = (i) => exists.has(i);

  assert.equal(runSegmentReady({ index: 3, has, runEnded: false }), true, 'segment 4 exists, so 3 is closed');
  assert.equal(runSegmentReady({ index: 4, has, runEnded: false }), true, 'segment 5 exists, so 4 is closed');
  assert.equal(runSegmentReady({ index: 5, has, runEnded: false }), false,
    'segment 5 is the one being written — nothing has started after it');
  assert.equal(runSegmentReady({ index: 5, has, runEnded: true }), true,
    'once the run has exited, its last segment is complete');
  assert.equal(runSegmentReady({ index: 9, has, runEnded: true }), false,
    'a segment the run never produced is not complete just because the run ended');
});

// ---- pre-segmenting the whole film in one pass --------------------------------------------------

test('pre-segmenting produces a complete playlist and non-overlapping segments', { skip: (!FFMPEG || !FFPROBE) && 'ffmpeg not installed', timeout: 300000 }, () => {
  // Why the whole film at once, when the rest of this module exists to produce segments on demand.
  //
  // Every attempt to cut segments at boundaries WE choose corrupts this kind of source. Measured on
  // a real open-GOP HEVC WEBRip, all at the identical packet: -segment_times at keyframe PTS, at
  // keyframe DTS, with -segment_time_delta, with audio removed, and -segment_frames cutting on
  // decode-order frame numbers. The boundary overlaps in DECODE order — the previous GOP's trailing
  // packets are decoded after the next segment's keyframe — so splitting there is not expressible.
  // ffmpeg's own -f hls cuts at the SAME keyframe and is clean, so the cut point was never the
  // problem; forcing it was.
  //
  // Letting the segmenter choose means the playlist must follow it, which looked like it cost the
  // upfront playlist that makes an instant seek work. It does not, because segmenting is not
  // encoding: measured on the 5981s WEBRip, a stream copy segments 600s in 0.3s — 2169x realtime,
  // so ~3s for the whole film, at a disk cost about equal to the source. The on-demand design was
  // avoiding a cost that does not exist. What it bought instead was the overlap that livelocked an
  // LG television after 130s of playback.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spritz-preseg-'));
  try {
    const src = openGopFixture(dir);
    const out = path.join(dir, 'out');
    fs.mkdirSync(out);
    const args = presegmentArgs({ input: src, dir: out, targetSec: 6 });
    assert.ok(args, 'presegmentArgs should accept a valid request');
    execFileSync(FFMPEG, args);

    const pl = fs.readFileSync(path.join(out, 'media.m3u8'), 'utf8');
    // NOTE: this line documents intent rather than catching a regression. ffmpeg writes ENDLIST for
    // any finite input whether or not -hls_playlist_type vod is passed — verified by removing that
    // flag, after which this still passed. The assertions that DO discriminate are the non-overlap
    // ones below: run against the old independent-cut path on this same fixture they fail with a
    // 2.240s backward step.
    assert.ok(/#EXT-X-ENDLIST/.test(pl), 'the playlist must be complete — a seek needs the whole timeline');
    const names = pl.match(/^[0-9]+\.ts$/gm) || [];
    assert.ok(names.length > 2, 'the fixture should divide into several segments, got ' + names.length);
    assert.equal((pl.match(/#EXT-X-DISCONTINUITY/g) || []).length, 0,
      'a continuous stream copy should need no discontinuity tags');

    const range = (n) => {
      const pts = execFileSync(FFPROBE, ['-v', 'error', '-select_streams', 'v:0',
        '-show_entries', 'packet=pts_time', '-of', 'csv=p=0', path.join(out, n)]).toString()
        .split('\n').map((l) => parseFloat(l)).filter(Number.isFinite);
      return { first: Math.min(...pts), last: Math.max(...pts) };
    };
    for (let i = 1; i < names.length; i++) {
      const prev = range(names[i - 1]);
      const cur = range(names[i]);
      assert.ok(cur.first >= prev.last - 0.1,
        names[i] + ' starts at ' + cur.first + ' but ' + names[i - 1] + ' runs to ' + prev.last +
        ' — a ' + (prev.last - cur.first).toFixed(3) + 's backward step, which is the livelock');
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
