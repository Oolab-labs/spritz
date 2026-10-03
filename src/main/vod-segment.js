'use strict';

// Producing one HLS segment, on demand, from an arbitrary point in a film.
//
// hls-vod.js works out WHICH slices a film divides into and writes a complete, seekable playlist
// before any of them exist. This is the other half: turning "segment 47" into an ffmpeg invocation.
// The two were never connected — hls-vod.js has unit tests and, until now, no callers at all.
//
// Two constraints decide every argument here, and both were measured on a fixture rather than
// reasoned about, because both fail silently.
//
// 1. THE CUT MUST LAND ON A KEYFRAME. hls-vod.js documents this at length: a stream copy cannot
//    cut anywhere else, so asking for "18 seconds in, six seconds long" hands back a segment
//    starting at 10s. Measured on a 40s fixture with keyframes every 10s: `-ss 18 -t 6` produced
//    14.29s of video, and `-ss 25 -t 6` produced 11.26s. That is why segmentsFromKeyframes exists
//    and why this module takes a span rather than an index.
//
// 2. THE SEGMENT MUST CARRY ABSOLUTE TIMESTAMPS — `-copyts`. This one is NOT recorded anywhere in
//    the project and is the more dangerous of the two, because the segments look perfectly correct
//    on their own. Measured on the same fixture, cutting four consecutive segments independently:
//
//      without -copyts   first PTS 1.480  1.485  1.500  1.493   ← every segment starts at zero
//      with    -copyts   first PTS 1.480 11.400 21.400 31.400   ← a timeline that advances
//
//    MPEG-TS restarts its clock at ~1.4s for each independent run, so without -copyts every
//    segment claims to be the same moment in the film. A player concatenating them has a timeline
//    that never moves: it decodes segment 0, is handed segment 1 covering the same instant, and
//    the film appears to stall or loop a few seconds in. The playlist arithmetic is untouched by
//    this and would look entirely correct while the stream was unplayable.
//
// A known, accepted imperfection: `-to` under `-c copy` includes the packets straddling the
// boundary, so consecutive segments overlap by a fraction of a second (measured 0.16-0.30s on the
// fixture).
//
// THAT FIGURE IS THE FIXTURE'S, NOT A GENERAL BOUND. The fixture has a closed GOP. On an OPEN-GOP
// source the overlap is a whole keyframe interval, because the keyframe is a CRA whose leading
// pictures reference the previous IRAP and a copy must include it. Measured on a real HEVC WEBRip:
// consecutive segments overlapped by 1.9-10.4s while the playlist promised none. Seeking by the
// keyframe's DTS instead was tried and does not help — the landing is a step function offset by one
// keyframe, so no seek target lands on the boundary; see the open-GOP test in vod-segment.test.js
// for the sweep. Segments still CONTAIN their spans, so the stream is complete, but a receiver is
// handed materially more media than EXTINF describes. Because the timestamps are absolute, that overlap is duplicate data at PTS a player has
// already seen, which it drops — as against the alternative of re-encoding every segment to force
// exact boundaries, which is the expensive path this whole design exists to avoid.

const path = require('path');

// The container for a produced segment. MPEG-TS rather than fMP4: it needs no initialisation
// segment, so a segment fetched after a seek is independently decodable with nothing fetched first.
const SEGMENT_EXT = '.ts';

// Target segment length handed to the segmenter. ffmpeg treats it as a target, not a floor: it cuts
// at keyframes, so the actual durations follow the source's keyframe spacing.
const DEFAULT_TARGET_SEC = 6;

// ffmpeg arguments for one segment.
//
// input — the source file.
// span  — { start, duration } from hls-vod.js's segmentsFromKeyframes. `start` MUST be a keyframe
//         time from that source; this module cannot check that and a caller that guesses will get
//         the measured overshoot above, not an error.
// out   — where to write it.
// copyAudio — false when the source's audio is not something the receiver decodes, in which case
//         only the audio is re-encoded. The video copy is the whole point and is never given up
//         here; a source needing video re-encoding does not belong on this path at all.
// kind  — what goes in the segment:
//           'muxed' (default) — video plus the one audio track, the shape used when a film has only
//                               one anyway. Fewer requests and fewer moving parts.
//           'video'           — video alone, for a film whose audio tracks are separate renditions.
//           'audio'           — one audio track alone, likewise.
//         Audio-only segments are cut on the VIDEO's keyframe boundaries, not on audio frame
//         boundaries. That is deliberate and required: an audio rendition's playlist has to line up
//         with the video's segment for segment, or a player switching languages lands in the wrong
//         place. Audio frames do not divide evenly there, so a segment overruns its boundary
//         slightly — the same accepted overlap described above, and harmless for the same reason.
// audioTrack — which audio stream, for kind 'audio'.
function segmentArgs({ input, span, out, copyAudio = true, kind = 'muxed', audioTrack = 0 } = {}) {
  if (!input || !out || !span) return null;
  if (kind !== 'muxed' && kind !== 'video' && kind !== 'audio') return null;
  const start = Number(span.start);
  const duration = Number(span.duration);
  if (!Number.isFinite(start) || start < 0) return null;
  if (!Number.isFinite(duration) || duration <= 0) return null;
  const track = Number(audioTrack);
  if (kind === 'audio' && (!Number.isInteger(track) || track < 0)) return null;

  const streams =
    kind === 'video' ? ['-map', '0:v:0', '-an', '-c:v', 'copy']
    : kind === 'audio' ? ['-map', '0:a:' + track, '-vn', '-c:a', copyAudio ? 'copy' : 'aac',
      ...(copyAudio ? [] : ['-b:a', '192k'])]
    : ['-c:v', 'copy', '-c:a', copyAudio ? 'copy' : 'aac', ...(copyAudio ? [] : ['-b:a', '192k'])];

  return [
    '-loglevel', 'error', '-y',
    // -ss BEFORE -i: the fast input seek. With -c copy it lands on the preceding keyframe, which is
    // exactly why `start` has to be one already.
    '-ss', String(start),
    // Absolute output timestamps. See the measurement above — without this the stream is broken in
    // a way that no single segment reveals.
    '-copyts',
    '-i', input,
    // -to is an ABSOLUTE time under -copyts, not a length, so it is the end of the span rather than
    // its duration. Getting this wrong produces a segment running to the end of the film.
    '-to', String(start + duration),
    ...streams,
    // A segment is one continuous run of the source; muxing anything else into it would make it
    // undecodable on its own, which is the property the whole scheme rests on.
    '-avoid_negative_ts', 'disabled',
    // Zero the muxer's start delay. ffmpeg's MPEG-TS muxer otherwise offsets output by its default
    // 1.4s preload, so with -copyts a segment cut at 10s emitted PTS 11.4 — a constant skew between
    // the playlist's arithmetic and the actual media clock. Measured:
    //
    //   default                    first PTS  1.400  11.400  21.400   for cuts at 0s, 10s, 20s
    //   -muxdelay 0 -muxpreload 0  first PTS  0.000  10.000  20.000
    //
    // The skew is survivable for video alone, because a player takes its origin from the first
    // segment it sees. It is NOT survivable for WebVTT: a subtitle track is aligned with
    // X-TIMESTAMP-MAP against MPEGTS 0, so every cue would land 1.4 seconds early. Making PTS equal
    // source time removes the question instead of compensating for it.
    '-muxdelay', '0', '-muxpreload', '0',
    '-f', 'mpegts', out
  ];
}

// ffmpeg arguments for a RUN of consecutive segments, produced in one pass.
//
// WHY THIS EXISTS, and why segmentArgs above is not enough.
//
// segmentArgs cuts ONE segment independently, and on an open-GOP source every independent cut
// carries the lead-in characterised in vod-segment.test.js. That makes consecutive segments OVERLAP
// in presentation time — 1.9-10.4s on a real WEBRip — so every boundary steps BACKWARD while the
// playlist, which carries no EXT-X-DISCONTINUITY, promises a continuous timeline. Measured:
//
//   ffmpeg's own HLS demuxer   "timestamp discontinuity ... new offset= 10259700" at EVERY boundary,
//                              accumulating 83.6s of correction over nine of them
//   an LG webOS television     plays 130s, then LIVELOCKS — 15,107 aborted segment fetches,
//                              alternating between the two segments whose ranges conflict, each
//                              connection closed by the receiver after ~20ms
//
// The comment above used to assert the overlap was "duplicate data at PTS a player has already
// seen, which it drops". Nothing drops it. That assumption was the bug.
//
// One ffmpeg run means one decode pass and therefore ONE continuous timeline: the segmenter cuts at
// the times it is given without re-seeking, so consecutive segments abut instead of overlapping.
// Verified on the same 100-minute WEBRip — 34 segments, stream copy, no re-encode — the demuxer
// above goes silent, and consecutive segments meet with a one-frame gap (-0.042s) rather than a
// multi-second overlap.
//
// The lead-in is NOT eliminated, only reduced to once per run: the run's FIRST segment still opens
// at the preceding keyframe, because that is what an input seek does. One boundary per seek is the
// cost; 659 of them was the bug.
//
// spans     — the full span list from segmentsFromKeyframes. Indices here are indices into it, so
//             the produced files line up with the playlist the receiver is reading.
// fromIndex — the first segment this run produces.
// count     — how many to produce. Bounded by the caller, not open-ended: a run that produced the
//             whole film would defeat the on-demand design this route exists for.
// dir       — where segments land; they are named by segmentPath, so the run writes exactly the
//             paths the route serves.
function segmentRunArgs({ input, spans, fromIndex, count, dir, prefix = '', kind = 'muxed',
  audioTrack = 0, copyAudio = true } = {}) {
  if (!input || !dir || !Array.isArray(spans) || !spans.length) return null;
  if (kind !== 'muxed' && kind !== 'video' && kind !== 'audio') return null;
  const from = Number(fromIndex);
  const n = Number(count);
  if (!Number.isInteger(from) || from < 0 || from >= spans.length) return null;
  if (!Number.isInteger(n) || n < 1) return null;
  const last = Math.min(from + n, spans.length) - 1;
  const start = Number(spans[from].start);
  const endSpan = spans[last];
  const end = Number(endSpan.start) + Number(endSpan.duration);
  if (!Number.isFinite(start) || start < 0 || !Number.isFinite(end) || end <= start) return null;

  const track = Number(audioTrack);
  if (kind === 'audio' && (!Number.isInteger(track) || track < 0)) return null;

  const streams =
    kind === 'video' ? ['-map', '0:v:0', '-an', '-c:v', 'copy']
    : kind === 'audio' ? ['-map', '0:a:' + track, '-vn', '-c:a', copyAudio ? 'copy' : 'aac',
      ...(copyAudio ? [] : ['-b:a', '192k'])]
    : ['-c:v', 'copy', '-c:a', copyAudio ? 'copy' : 'aac', ...(copyAudio ? [] : ['-b:a', '192k'])];

  // The interior boundaries only. The segmenter starts a new file at each of these times; the run's
  // own start and end are set by -ss and -to, so listing them here would emit an empty leading file.
  const cuts = [];
  for (let i = from + 1; i <= last; i++) cuts.push(Number(spans[i].start).toFixed(6));

  return [
    '-loglevel', 'error', '-y',
    '-ss', String(start),
    // Absolute timestamps, for the same reason segmentArgs needs them: the receiver's timeline has
    // to be film time, not run time.
    '-copyts',
    '-i', input,
    '-to', String(end),
    ...streams,
    '-avoid_negative_ts', 'disabled',
    '-muxdelay', '0', '-muxpreload', '0',
    '-f', 'segment',
    // Cut where the playlist says, not on a duration heuristic: the receiver is reading EXTINF
    // values already computed from the keyframe list, and a segmenter left to choose its own
    // boundaries would produce files that do not match them.
    ...(cuts.length ? ['-segment_times', cuts.join(',')] : []),
    // Keep the absolute clock across the run's own boundaries. Resetting it is what independent
    // cuts effectively did, and it is the thing being fixed.
    '-reset_timestamps', '0',
    '-segment_start_number', String(from),
    '-segment_format', 'mpegts',
    path.join(dir, prefix + '%d' + SEGMENT_EXT)
  ];
}

// Is segment `index` finished, given what a run has written so far?
//
// The hazard a run introduces that per-segment cuts did not have. segmentArgs runs one ffmpeg per
// segment, so the process exiting IS the segment being finished — existence on disk is proof. A run
// writes progressively: while ffmpeg is producing segment 5 the file for 5 already exists and is
// still being appended to. Serving it on existence alone hands the receiver a truncated segment,
// which is a WORSE failure than the overlap this change removes — corrupt media rather than a stall.
//
// So a segment is complete when the next one has been started, or when the run has exited. `has` is
// injected rather than stat'ing here so the rule can be tested without a filesystem.
function runSegmentReady({ index, has, runEnded } = {}) {
  const i = Number(index);
  if (!Number.isInteger(i) || i < 0 || typeof has !== 'function') return false;
  if (!has(i)) return false;
  if (has(i + 1)) return true;
  return !!runEnded;
}

// Segment the WHOLE film in one stream-copy pass, letting ffmpeg choose the boundaries and write
// the playlist.
//
// This replaces choosing boundaries ourselves, which does not work on this kind of source. Measured
// on a real open-GOP HEVC WEBRip, every way of forcing a cut corrupted the output at the identical
// packet: -segment_times at keyframe PTS, at keyframe DTS, with -segment_time_delta, with audio
// removed, and -segment_frames cutting on decode-order frame numbers. The reason is visible in the
// timestamps — the next segment's keyframe has DTS 14.431 while the previous segment's last packets
// run to DTS 14.472, so the boundary overlaps in DECODE order and a split there is not expressible.
// ffmpeg's own -f hls cuts at that SAME keyframe and is clean, so the cut POINT was never the
// problem; dictating it was.
//
// The reason this is affordable, and the mistake the on-demand design rested on: segmenting is not
// encoding. Measured on the 5981s WEBRip — a stream copy segments 600s of it in 0.3s, 2169x
// realtime, so about 3 seconds for the whole film, at a disk cost roughly equal to the source
// (2.9 GB against a 2.8 GB file). The original comment in this module justified per-segment cutting
// as avoiding "the expensive path" of pre-encoding; that conflated re-encoding, which is genuinely
// expensive, with segmenting, which is free. What the on-demand path bought instead was a 1.9-10.4s
// overlap at every boundary, which livelocked an LG television after 130s of playback.
//
// The playlist ffmpeg writes here is complete, with ENDLIST, before playback starts — so a seek to
// minute 80 still works immediately, which was the property the on-demand design existed to protect.
function presegmentArgs({ input, dir, targetSec = DEFAULT_TARGET_SEC, copyAudio = true,
  kind = 'muxed', audioTrack = 0 } = {}) {
  if (!input || !dir) return null;
  if (kind !== 'muxed' && kind !== 'video' && kind !== 'audio') return null;
  const target = Number(targetSec);
  if (!Number.isFinite(target) || target <= 0) return null;
  const track = Number(audioTrack);
  if (kind === 'audio' && (!Number.isInteger(track) || track < 0)) return null;

  const streams =
    kind === 'video' ? ['-map', '0:v:0', '-an', '-c:v', 'copy']
    : kind === 'audio' ? ['-map', '0:a:' + track, '-vn', '-c:a', copyAudio ? 'copy' : 'aac',
      ...(copyAudio ? [] : ['-b:a', '192k'])]
    // The '?' makes the audio map OPTIONAL. Without it ffmpeg refuses outright on a source with no
    // audio track — "Stream map '' matches no streams" — which is a real shape (a silent source, and
    // every video-only fixture) and should produce a video-only segment rather than an error.
    : ['-map', '0:v:0', '-map', '0:a:' + track + '?', '-c:v', 'copy',
      '-c:a', copyAudio ? 'copy' : 'aac', ...(copyAudio ? [] : ['-b:a', '192k'])];

  return [
    '-loglevel', 'error', '-y',
    // Absolute timestamps, for the same reason segmentArgs needs them: subtitle alignment is done
    // against MPEGTS 0, so segment PTS has to equal source time rather than run time.
    '-copyts',
    '-i', input,
    ...streams,
    '-avoid_negative_ts', 'disabled',
    '-muxdelay', '0', '-muxpreload', '0',
    '-f', 'hls',
    // NOT -f segment. The two differ exactly at a boundary, and only this one is clean — see above.
    '-hls_time', String(target),
    // VOD, so the receiver gets ENDLIST and knows the film's full length up front. Without this the
    // playlist is an EVENT list and a seek past the end of what exists is refused.
    '-hls_playlist_type', 'vod',
    // Keep every segment. The default rolling window would delete the film behind the playhead,
    // which is precisely the seeking this route exists to provide.
    '-hls_list_size', '0',
    '-hls_segment_filename', path.join(dir, '%d' + SEGMENT_EXT),
    path.join(dir, 'media.m3u8')
  ];
}

// One HLS PACKAGE — picture and every audio rendition — from a single ffmpeg pass.
//
// presegmentArgs above produces one variant. That is right for a muxed source, but a source with
// more than one audio track needs the picture and each track as separate renditions, and producing
// them as separate passes would put Spritz back in charge of making their boundaries agree. That is
// exactly the mistake that caused the receiver livelock: independently cut segments whose timelines
// disagree, described by a playlist that claims they do not. `-var_stream_map` keeps ONE muxer
// deciding the boundaries for every rendition at once, so the audio segments line up with the
// picture's by construction rather than by our arithmetic.
//
// Naming is chosen to match what the route already serves: variant `aN` writes `aN_<i>.ts`, which is
// the prefix scheme segmentPath already implements, and the picture writes `v_<i>.ts`. ffmpeg
// expands %v to a variant's name.
function presegmentPackageArgs({ input, dir, targetSec = DEFAULT_TARGET_SEC, copyAudio = true,
  audioTracks = [] } = {}) {
  if (!input || !dir) return null;
  const target = Number(targetSec);
  if (!Number.isFinite(target) || target <= 0) return null;
  const tracks = Array.isArray(audioTracks) ? audioTracks : [];
  // One track (or none) is presegmentArgs' job; this shape exists only for the split case, and
  // returning null keeps a caller from quietly getting a one-variant package from the wrong builder.
  if (tracks.length < 2) return null;

  const maps = ['-map', '0:v:0'];
  tracks.forEach((t) => { maps.push('-map', '0:a:' + Number(t.index || 0)); });

  // The picture carries no audio group of its own; the receiver pairs it with the group named here.
  const varMap = ['v:0,agroup:aud,name:v'];
  tracks.forEach((t, i) => {
    const bits = ['a:' + i, 'agroup:aud', 'name:a' + i];
    if (t.lang) bits.push('language:' + String(t.lang).replace(/[^a-z0-9-]/gi, ''));
    if (i === 0) bits.push('default:yes');
    varMap.push(bits.join(','));
  });

  return [
    '-loglevel', 'error', '-y',
    // Absolute timestamps, for the same reason presegmentArgs needs them: subtitle alignment is
    // done against MPEGTS 0, so segment PTS has to equal source time rather than run time.
    '-copyts',
    '-i', input,
    ...maps,
    '-c:v', 'copy',
    '-c:a', copyAudio ? 'copy' : 'aac', ...(copyAudio ? [] : ['-b:a', '192k']),
    '-avoid_negative_ts', 'disabled',
    '-muxdelay', '0', '-muxpreload', '0',
    '-f', 'hls',
    '-hls_time', String(target),
    '-hls_playlist_type', 'vod',
    '-hls_list_size', '0',
    '-var_stream_map', varMap.join(' '),
    // ffmpeg insists on writing a master when -var_stream_map is used. The route builds its own
    // (it also carries the subtitle renditions, which this pass knows nothing about), so this one
    // is written and never served — named distinctly so it cannot be mistaken for the real one.
    '-master_pl_name', 'ff_master.m3u8',
    '-hls_segment_filename', path.join(dir, '%v_%d' + SEGMENT_EXT),
    path.join(dir, '%v.m3u8')
  ];
}

// ffprobe arguments for the keyframe list segmentsFromKeyframes needs.
//
// -skip_frame nokey makes this a decode-nothing pass over the index rather than over the video, but
// it is still a full pass and takes real time on a long film — so a caller does it ONCE per source
// and keeps the answer, never per segment.
function keyframeArgs(input) {
  if (!input) return null;
  return ['-v', 'error', '-select_streams', 'v:0', '-skip_frame', 'nokey',
    '-show_entries', 'frame=pts_time', '-of', 'csv=p=0', String(input)];
}

// Parse what that produces. ffprobe emits one value per line, sometimes with a trailing comma, and
// occasionally a blank or an 'N/A' for a frame with no timestamp — which must be dropped rather
// than becoming a NaN that sorts to the front and cuts a segment at the wrong place.
function parseKeyframes(stdout) {
  return String(stdout || '')
    .split('\n')
    .map((l) => parseFloat(String(l).replace(/,\s*$/, '').trim()))
    .filter((n) => Number.isFinite(n) && n >= 0)
    .sort((a, b) => a - b);
}

// Where a produced segment lives. Kept here so the route and the producer cannot disagree about it.
//
// `prefix` separates the variants of one film: the video (or muxed) segments are bare indices and
// each audio rendition has its own, so segment 12 of the Japanese track cannot be mistaken for
// segment 12 of the picture.
function segmentPath(dir, index, prefix) {
  const i = Number(index);
  if (!dir || !Number.isInteger(i) || i < 0) return null;
  const pre = prefix == null ? '' : String(prefix);
  if (/[/\\]|\.\./.test(pre)) return null;   // a prefix reaches the filesystem; it never contains a path
  return path.join(dir, pre + String(i) + SEGMENT_EXT);
}

// Is this source something the VOD path may serve at all?
//
// Every segment here is produced with `-c:v copy`. That is the whole economy of the design — a 4K
// HEVC segment costs milliseconds instead of a sustained transcode — but it means the path can only
// carry video the receiver already decodes. Anything that would change a single video byte belongs
// on the live-HLS path, which exists to do exactly that.
//
// Audio is different and is NOT a disqualifier: re-encoding one audio track is cheap and does not
// touch the video copy, so an incompatible track simply sets copyAudio false.
//
// Same shape as canSendOriginal in send-original.js, and for the same reason: "we did not take this
// path" has to be distinguishable from "there is no such path".
function vodEligible(plan, info) {
  if (!plan) return { ok: false, why: 'nothing was planned' };
  // A probe that could not read the file is not evidence that a copy is safe. serveHls can recover
  // from a bad guess by re-encoding; this path has nothing to fall back to mid-film.
  if (plan.speculative) return { ok: false, why: 'the probe was inconclusive' };
  if (plan.video !== 'copy') return { ok: false, why: 'the video has to be re-encoded' };
  if (plan.tonemap) return { ok: false, why: 'HDR has to be tone-mapped' };
  if (plan.stripDovi) return { ok: false, why: 'Dolby Vision has to be stripped' };
  if (!info || !info.vcodec) return { ok: false, why: 'the video codec is unknown' };
  // Burned-in subtitles are a filter over the picture, which is a re-encode by another name.
  if (plan.burnSub != null && plan.burnSub >= 0) return { ok: false, why: 'a subtitle has to be burned in' };
  // Subtitles ARE carried — as WebVTT renditions on a master playlist, extracted on selection. See
  // buildVodMaster and subPlaylist below.
  //
  // Several audio tracks become several renditions, each with its own audio-only segment playlist
  // cut on the same boundaries as the video — so a language switch lands where the film already is.
  // A film with one track keeps the simpler muxed shape; see `kind` in segmentArgs.
  const audio = Array.isArray(info.audio) ? info.audio : [];
  const planned = Array.isArray(plan.audioTracks) ? plan.audioTracks : [];
  // A track that has to be re-encoded is fine; a track this path cannot describe is not. Each
  // rendition carries whatever the plan says about ITS OWN stream, rather than one flag for all.
  const perTrack = audio.map((a, i) => ({
    index: i,
    lang: (a && a.lang) || 'und',
    name: (a && a.name) || (a && a.lang) || ('Audio ' + (i + 1)),
    copy: !planned[i] || planned[i].action === 'copy'
  }));
  return {
    ok: true,
    // The muxed shape's single flag, kept for the one-track case.
    copyAudio: !planned[0] || planned[0].action === 'copy',
    splitAudio: perTrack.length > 1,
    audioTracks: perTrack
  };
}

// The header every emitted WebVTT carries. X-TIMESTAMP-MAP anchors cue zero to media PTS zero,
// which is only true because segmentArgs zeroes the muxer delay — see the measurement there.
// ffmpeg's webvtt muxer omits this line and some players then render nothing.
const VTT_HEAD = 'WEBVTT\nX-TIMESTAMP-MAP=MPEGTS:0,LOCAL:00:00:00.000\n\n';

// A subtitle rendition is one WebVTT file covering the whole film, in a playlist of one segment.
// There is no reason to cut subtitles up: the file is tiny and a player fetches it once.
function subPlaylist(vttName, durationSec) {
  const dur = Number(durationSec);
  if (!vttName || !Number.isFinite(dur) || dur <= 0) return null;
  const span = Math.ceil(dur);
  return '#EXTM3U\n#EXT-X-VERSION:6\n#EXT-X-TARGETDURATION:' + span + '\n' +
    '#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-PLAYLIST-TYPE:VOD\n' +
    '#EXTINF:' + span + '.0,\n' + vttName + '\n#EXT-X-ENDLIST\n';
}

// Extract one embedded text subtitle track to WebVTT.
function subExtractArgs(input, trackIndex, out) {
  const i = Number(trackIndex);
  if (!input || !out || !Number.isInteger(i) || i < 0) return null;
  return ['-loglevel', 'error', '-y', '-i', input, '-map', '0:s:' + i, '-c:s', 'webvtt', '-f', 'webvtt', out];
}

// The master playlist: the one video variant, plus a SUBTITLES rendition per track.
//
// hls-vod.js's buildMasterPlaylist takes a single subtitlesUrl, which is all the AirPlay path ever
// needed. A film usually has several tracks, so this writes the group properly.
//
// No track is DEFAULT or AUTOSELECT. Turning subtitles on unasked is a worse failure than making
// the viewer pick, and this project has already been bitten by a receiver silently choosing a
// rendition for itself.
function buildVodMaster({ mediaUrl, subs, audio, bandwidth, width, height, codecs } = {}) {
  if (!mediaUrl) return null;
  const list = Array.isArray(subs) ? subs : [];
  const auds = Array.isArray(audio) ? audio : [];
  const lines = ['#EXTM3U', '#EXT-X-VERSION:6'];
  // Exactly one audio rendition is DEFAULT — unlike subtitles, where none is. A variant with an
  // AUDIO group and no default leaves a player with no audio to start, which is silence rather
  // than a choice.
  auds.forEach((a, i) => {
    if (!a || !a.playlist) return;
    lines.push('#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud"' +
      ',NAME="' + String(a.name || a.lang || ('Audio ' + (i + 1))).replace(/"/g, '') + '"' +
      ',LANGUAGE="' + String(a.lang || 'und').replace(/"/g, '') + '"' +
      ',DEFAULT=' + (a.default ? 'YES' : 'NO') +
      ',AUTOSELECT=' + (a.default ? 'YES' : 'NO') +
      ',URI="' + a.playlist + '"');
  });
  for (const s of list) {
    if (!s || !s.playlist) continue;
    lines.push('#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs"' +
      ',NAME="' + String(s.name || s.lang || 'Subtitle').replace(/"/g, '') + '"' +
      ',LANGUAGE="' + String(s.lang || 'und').replace(/"/g, '') + '"' +
      ',DEFAULT=NO,AUTOSELECT=NO,URI="' + s.playlist + '"');
  }
  const attrs = ['BANDWIDTH=' + (Number(bandwidth) > 0 ? Math.floor(bandwidth) : 20000000)];
  if (Number(width) > 0 && Number(height) > 0) attrs.push('RESOLUTION=' + Math.floor(width) + 'x' + Math.floor(height));
  // Only ever stated when it is known to be true — a guessed CODECS string once made AVPlayer reject
  // a master outright and cost this project days (see buildMasterPlaylist in hls-vod.js).
  if (codecs) attrs.push('CODECS="' + codecs + '"');
  if (lines.some((l) => l.startsWith('#EXT-X-MEDIA:TYPE=AUDIO'))) attrs.push('AUDIO="aud"');
  if (lines.some((l) => l.startsWith('#EXT-X-MEDIA:TYPE=SUBTITLES'))) attrs.push('SUBTITLES="subs"');
  lines.push('#EXT-X-STREAM-INF:' + attrs.join(','));
  lines.push(mediaUrl);
  return lines.join('\n') + '\n';
}

module.exports = { segmentArgs, segmentRunArgs, runSegmentReady, presegmentArgs, presegmentPackageArgs, keyframeArgs, parseKeyframes, segmentPath, vodEligible,
  subPlaylist, subExtractArgs, buildVodMaster, VTT_HEAD, SEGMENT_EXT };
