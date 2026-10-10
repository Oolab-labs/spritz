'use strict';

// LAN media server (main process) — lets a TV (AirPlay/Chromecast) fetch local files
// and torrent streams over the network. The receiver fetches the URL itself, so it must
// be the Mac's LAN IP (loopback is unreachable from the TV). Binds 0.0.0.0.
//
// Two roles:
//   /file/<token>   — serve a file with HTTP range support (seek/scrub). Used for both
//                     original local files AND remuxed temp files.
//
// Remux-on-demand: containers the receiver can't open (MKV/AVI/TS/WebM) whose VIDEO is
// already H.264/HEVC are repackaged to a temp MP4 with `-c:v copy` (lossless, ~no CPU);
// incompatible audio (AC3/DTS/Opus/FLAC/…) is transcoded to AAC. The temp file is then
// served via /file/ with range support — AVPlayer rejects a live non-seekable pipe
// (status: failed), so it must be a complete, range-seekable file. Video codecs the
// receiver can't decode (VP9/AV1/Xvid) are left un-castable here (needs full transcode).

const http = require('http');
const { byteRange } = require('./http-range');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { containedPath } = require('./ipc-validate'); // resolve-and-verify for LAN-exposed paths
const { spawn } = require('child_process');
// The copy-vs-transcode decision. It used to live here, inline, twice (serveHls and mkvArgs); it is
// now one pure, unit-tested function and these sites only turn its answer into ffmpeg arguments.
const { planPlayback } = require('./playback-planner');
const { trimToCompleteCues, coverageEnd } = require('./vtt-window'); // serving a partially-extracted track
const { probeWithRetries } = require('./probe-retry');                 // a failed probe means a blind re-encode
const { resumePosition } = require('./resume-point');                   // where a re-requested stream restarts
const { canSendOriginal } = require('./send-original');                 // when ffmpeg is not needed at all
const { classifyFailure, shouldRetryInSoftware } = require('./ffmpeg-failure'); // why a run produced nothing
const { flagsFor, SEEK_ENABLED } = require('./dlna-flags');              // shared with dlna.js: byte-identical by construction
const { segmentsFromKeyframes, buildVodPlaylistFromSegments, DEFAULT_SEGMENT_SEC } = require('./hls-vod'); // the seekable playlist
const { createEpochs, planSeek, toLogical: epochToLogical, toLocal: epochToLocal } = require('./transport-epoch'); // one ffmpeg-owned HLS run per seek
const { segmentArgs, segmentRunArgs, runSegmentReady, presegmentArgs, presegmentPackageArgs, keyframeArgs, parseKeyframes, segmentPath, vodEligible,
  subPlaylist, subExtractArgs, buildVodMaster, VTT_HEAD } = require('./vod-segment');                      // one segment, on demand

const { binPath: findBin } = require('./bin-path'); // packaged → bundled only
const FFPROBE = findBin('ffprobe');
const FFMPEG = findBin('ffmpeg');

// The private-LAN IPv4 the TV can route to. Prefer physical NICs (en/eth) on a private
// subnet — a Mac with an active VPN exposes utun/ppp interfaces whose address the TV can't
// reach, and returning that breaks every LAN-served cast (AirPlay-HLS, DLNA, Chromecast).
function isPrivate(a) {
  const o = a.split('.').map(Number);
  return o[0] === 10 || (o[0] === 192 && o[1] === 168) || (o[0] === 172 && o[1] >= 16 && o[1] <= 31);
}
function lanAddress() {
  const ifaces = os.networkInterfaces();
  const phys = []; // private IPv4 on a physical NIC: {name, addr}
  let fallback = null;
  for (const name of Object.keys(ifaces)) {
    for (const ni of ifaces[name] || []) {
      if (ni.family !== 'IPv4' || ni.internal || !isPrivate(ni.address)) continue;
      if (/^(en|eth)/i.test(name)) phys.push({ name, addr: ni.address });
      else if (!fallback) fallback = ni.address; // bridge/other private, not VPN-public
    }
  }
  // Prefer the PRIMARY NIC (lowest en/eth index) — the TV is on the main Wi-Fi/Ethernet, not a
  // secondary en5/en7 (Thunderbolt-bridge / iPhone-USB) which is a different segment the TV can't
  // reach. Returning that address makes the receiver's HTTP GET fail → cast connects but no video.
  phys.sort((a, b) => (parseInt((a.name.match(/\d+/) || [99])[0], 10)) - (parseInt((b.name.match(/\d+/) || [99])[0], 10)));
  return phys.length ? phys[0].addr : fallback;
}

// Quick extension gate (https/direct path still uses this — no probe for remote URLs).
const AV_OK = /\.(mp4|m4v|mov|m3u8|mp3|m4a|aac)(\?|#|$)/i;
function avCompatible(p) { return AV_OK.test(String(p || '')); }

// Codecs the receivers (AVPlayer + Chromecast Default Media Receiver) reliably decode in an
// MP4/HLS container WITHOUT a capability hint. VP9/AV1 are decodable by modern receivers but NOT
// muxable into fMP4/HLS the way Apple/Cast want, so they still need a transcode on the cast path
// (the DLNA route serves the original WebM/MKV and the TV decodes them natively — preferred).
const VIDEO_OK = new Set(['h264', 'hevc']);
const AUDIO_OK = new Set(['aac', 'mp3', 'alac']);
// (The passthrough set — AC3/EAC3 on top of these, copied so a forced AAC stereo downmix can't
// destroy 5.1/7.1 — now lives in device-profile.js as AUDIO_PASSTHROUGH, with that reasoning.)

// One-time probe of what the BUNDLED ffmpeg can actually do — gates burn-in / tonemap code paths so
// they light up automatically if the binary is ever rebuilt with libass / zscale, and stay disabled
// (graceful) otherwise. Synchronous, runs once at module load; failure → assume the feature is absent.
function ffmpegHasFilter(name) {
  try {
    const out = require('child_process').execFileSync(FFMPEG, ['-hide_banner', '-filters'], { encoding: 'utf8', timeout: 8000 });
    return new RegExp('(^|\\n)\\s*[.TSC]{1,3}\\s+' + name + '\\s', 'm').test(out);
  } catch (e) { return false; }
}
// (Bundled ffmpeg has no `subtitles`/libass filter → no burn-in; PGS/VOBSUB bitmap subs are skipped
// and steered to the DLNA route, where the TV renders them. No `zscale` either → tonemap is gated.)
const CAN_TONEMAP = ffmpegHasFilter('tonemap') && ffmpegHasFilter('zscale'); // proper HDR→SDR needs both

// Sniff a subtitle file's text encoding so ffmpeg can decode it to clean UTF-8 WebVTT instead of
// mojibake (no charset-detector dependency in the app). BOM first, then a UTF-8 validity scan, then
// fall back to Windows-1252 (the overwhelmingly common legacy encoding for Western .srt files).
function sniffCharenc(filePath) {
  try {
    const buf = fs.readFileSync(filePath);
    if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) return 'UTF-8';
    if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) return 'UTF-16LE';
    if (buf.length >= 2 && buf[0] === 0xFE && buf[1] === 0xFF) return 'UTF-16BE';
    let i = 0;
    while (i < buf.length) {
      const b = buf[i];
      if (b < 0x80) { i++; continue; }
      let n; // length of this UTF-8 sequence
      if ((b & 0xE0) === 0xC0) n = 1; else if ((b & 0xF0) === 0xE0) n = 2; else if ((b & 0xF8) === 0xF0) n = 3; else return 'WINDOWS-1252';
      for (let k = 1; k <= n; k++) { if (i + k >= buf.length || (buf[i + k] & 0xC0) !== 0x80) return 'WINDOWS-1252'; }
      i += n + 1;
    }
    return 'UTF-8';
  } catch (e) { return 'UTF-8'; }
}

// Receiver capability profile — drives copy-vs-transcode. A capability-confirmed TV (the LG
// NANO80T6A and any webOS-24 / Chromecast-built-in / Apple-TV class receiver) decodes 4K HEVC
// Drop the Dolby Vision NAL units from an HEVC stream while copying it. 62 is the RPU carrying the
// DV metadata and 63 the enhancement layer; with both gone what remains is the base layer, which for
// a profile-8 release is ordinary HDR10 that any HDR receiver plays. This runs on the COPY path — no
// decode, no encode, so a 4K file is retimed at disk speed rather than re-rendered. Applied only when
// the plan asks for it, which it does only for profile 8 (see playback-planner.js).
const DOVI_STRIP = ['-bsf:v', 'filter_units=remove_types=62|63'];

// How long a subtitle extraction may run before what it has is served. Generous enough that a local
// file always finishes cleanly inside it, short enough that a receiver waiting on the track does not
// give up. The cost of overrunning is a blank subtitle menu; the cost of stopping early is only a
// shorter run of cues.
// How long ffmpeg waits on a silent input before giving up. Thirty seconds was too impatient for a
// torrent: a swarm that goes quiet while one piece arrives late produces a gap longer than that at
// perfectly healthy average speed, and the stream died rather than waited. The old Soda Player
// shipped 120s for years on the same job, and a cast that pauses for a moment is strictly better
// than one that ends.
//
// Its companion flag `-seekable 0` is deliberately NOT copied. That app read its input sequentially
// from the start; this one seeks to the resume position (-ss), which on an HTTP source is a range
// request. Declaring the input unseekable would force ffmpeg to read and discard everything up to
// the seek point — on a mid-film resume, gigabytes.
const HTTP_READ_TIMEOUT_US = 120000000;

// Things a receiver has no use for and can trip over: chapter markers, container metadata, and
// embedded A53 closed captions riding inside the video bitstream. The old player stripped all three
// on its TV path. Verified accepted by the bundled ffmpeg on the copy path.
// ---- where the cast pipe's clock starts ----------------------------------------------------------
// The pipe is fragmented MP4 and the MP4 muxer zeroes the timeline at the first packet it writes
// (measured with -ss 4 -copyts: the output starts at 0.000). The receiver therefore counts from the
// start of the STREAM. The stream starts on a keyframe, so the film time of its zero is that
// keyframe's timestamp; the app adds it back to every reported position and the subtitle extractor
// cuts its cues from the same instant.
function lastKeyframeAtOrBefore(csv, sec) {
  let best = null;
  for (const line of String(csv || '').split('\n')) {
    const [t, flags] = line.trim().split(',');
    const n = Number(t);
    if (t === '' || !Number.isFinite(n) || !/K/.test(flags || '') || n > sec) continue;
    if (best === null || n > best) best = n;
  }
  return best;
}
// Seeks a little PAST the keyframe, not onto it. ffmpeg compares the target with the reordered DTS, so
// a target within a few frames of the keyframe lands on the keyframe BEFORE it (measured: keyframe at
// 93.75, seeks of 93.75..93.85 landed 10 s early, 93.9 landed on it). Half a second covers a 12-frame
// reorder depth at 24 fps; the cost is that the audio starts that much after the picture.
const SEEK_MARGIN_SEC = 0.5;
function castSeekArgs(originSec) {
  const o = Number(originSec);
  return Number.isFinite(o) && o > 0 ? ['-ss', String(+(o + SEEK_MARGIN_SEC).toFixed(3))] : [];
}
// Subtitles have no reorder delay to dodge, and their zero must be the stream's zero: the keyframe itself.
function subSeekArgs(originSec) {
  const o = Number(originSec);
  return Number.isFinite(o) && o > 0 ? ['-ss', String(+o.toFixed(3))] : [];
}
const KEYFRAME_WINDOW_SEC = 30; // long enough to hold the longest GOP a release is likely to use
function keyframeProbeArgs(input, sec) {
  const from = Math.max(0, Math.floor(sec) - KEYFRAME_WINDOW_SEC);
  const remote = /^https?:\/\//i.test(String(input));
  return ['-v', 'error', ...(remote ? ['-rw_timeout', '8000000'] : []), '-select_streams', 'v:0',
    '-show_entries', 'packet=pts_time,flags', '-of', 'csv=p=0', '-read_intervals', from + '%' + (sec + 1), input];
}

// How the cast pipe is fragmented. A fragment per keyframe alone is as large as a whole GOP, which
// grows with bitrate; an LG webOS Cast receiver never started playing 4 Mbps material that way (and
// a 4K HEVC copy) but plays both when fragments are also cut every second. See test/cast-fragments.
const CAST_PIPE_MUXFLAGS = ['-movflags', 'frag_keyframe+empty_moov+delay_moov+default_base_moof', '-frag_duration', '1000000'];
// -avoid_negative_ts make_zero: after -ss on a copy the video track starts at its keyframe and the audio at
// the seek point, i.e. negative video timestamps; an LG Cast receiver stalled such a stream 12-23 s in.
const CAST_HYGIENE = ['-map_chapters', '-1', '-map_metadata', '-1', '-a53cc', '0', '-avoid_negative_ts', 'make_zero'];

// Most tracks a viewer will never choose, and on a streamed source each one costs a pass over the
// torrent. Enough to cover the languages anyone actually reaches for, far short of forty-one.
const MAX_REMOTE_SIDELOAD_SUBS = 8;

// Is an ambitious (4K) capability profile worth keeping, or should we fall back to the proven one?
//
// 4K is only worth taking as a stream COPY. A 4K ENCODE cannot hold realtime — its software retry is
// libx264 at 2160p, which is worse — and a wedged encode ends the launch ladder at cb(null), i.e. the
// source becomes uncastable altogether. So an ambitious profile that lands on a transcode is strictly
// worse than the conservative one, which at least plays.
//
// The height gate carries just as much weight: with hevc+hdr10 allowed, a 1080p HEVC HDR10 source
// would be COPIED — and that is the exact configuration this project recorded as "enters AirPlay
// mode, never plays". Anything at or below 1088 (mod-16 padded 1080p) keeps the proven plan.
//
// A speculative plan (inconclusive probe) is refused because it describes a guess, not the source.
function decide4k(plan, height) {
  if (!plan) return { take: false, why: 'no plan' };
  if (plan.speculative) return { take: false, why: 'the probe was inconclusive' };
  if (plan.video !== 'copy') return { take: false, why: 'it would need a transcode, not a copy' };
  if ((height || 0) <= 1088) return { take: false, why: 'the source is not 4K' };
  return { take: true, why: 'a genuine 4K stream copy' };
}

// One rendition per language, capped. Used by both TV paths, which pay the same price for breadth:
// the Cast receiver eagerly fetches every sideloaded track, and AVPlayer will not start until it has
// pulled every subtitle rendition named in the master.
// Which offered text track gets a real extraction. The index is the receiver's trackId minus 1000,
// so an out-of-range or absent pick must mean "extract nothing" rather than silently defaulting to
// the first track — defaulting to the first is precisely the bug this replaced, where a 103-cue
// signs track shadowed two full dialogue tracks because it happened to come first.
function pickActiveSub(textOffer, subPick) {
  const list = textOffer || [];
  if (!(subPick >= 0) || subPick >= list.length || !list[subPick]) return null;
  return list[subPick].name;
}

// Diagnostic only: the first stack frame outside this file, so a log line can name who asked.
// Used by the AirPlay session-churn instrumentation, where the question is never "what happened"
// but "what asked for it" — three HLS sessions appeared in seconds and nothing recorded the caller.
function whoCalled() {
  try {
    const lines = (new Error().stack || '').split('\n').slice(2);
    for (const l of lines) {
      if (l.includes('lanserver.js')) continue;
      const m = l.match(/\(?([^()\s]+\/[^()\s/]+:\d+:\d+)\)?\s*$/);
      if (m) return m[1].replace(/^.*\/src\//, 'src/');
    }
  } catch (e) {}
  return 'unknown';
}

// Does this media playlist mark a discontinuity BEFORE its first segment? ffmpeg does that whenever
// the remux is seeked (-ss with -copyts), because the first packet's timestamp isn't zero.
//
// It matters because a subtitle rendition must agree with the variant it accompanies: AVFoundation
// compares the discontinuity sequence at the same media sequence across a variant and its renditions,
// and refuses the whole stream when they differ — "Media Entry discontinuity value does not match
// previous playlist for MEDIA-SEQUENCE 0", which is a total AirPlay failure, not a subtitle glitch.
// ffmpeg's playlists opened with the tag (sequence 1) and our hand-written subtitle playlists did not
// (sequence 0). Read it rather than assume it: an unseeked remux emits no tag, and adding one there
// would break the case that currently works.
function opensWithDiscontinuity(text) {
  const lines = String(text || '').split('\n');
  for (const ln of lines) {
    const t = ln.trim();
    if (t === '#EXT-X-DISCONTINUITY') return true;
    if (/^#EXTINF:/.test(t)) return false; // reached the first segment without one
  }
  return false;
}

// Reduce an EXT-X-STREAM-INF to the shape this receiver is known to accept: BANDWIDTH plus the
// rendition groups, and nothing describing the picture.
//
// The hand-built SINGLE-audio master has always been exactly that, and the note above it records why:
// adding RESOLUTION/FRAME-RATE/VIDEO-RANGE "broke AirPlay" and was reverted (A6). But the MULTI-audio
// branch does not build a master at all — it patches the one ffmpeg wrote, which arrives carrying
// RESOLUTION and CODECS. So the configuration recorded as broken kept shipping for every file with
// more than one audio track, which is most releases.
//
// Measured on a 4K HEVC stream copy: the variant playlist on its own loads READY in AVFoundation, and
// the master referencing that same variant is refused with -12927 — the media is fine, the master is
// not. Adding VIDEO-RANGE=PQ changed the refusal to -12646, so these attributes are being parsed and
// are load-bearing. Rather than guess which of them the receiver dislikes, describe nothing: a client
// that fetches the one variant anyway has no use for them.
function minimalStreamInf(line) {
  const attrs = String(line).replace(/^#EXT-X-STREAM-INF:/, '');
  const keep = [];
  // Split on commas that are not inside quotes — CODECS="a,b" is one attribute.
  for (const a of attrs.match(/(?:[^,"]|"[^"]*")+/g) || []) {
    const name = a.split('=')[0].trim();
    if (name === 'BANDWIDTH' || name === 'AVERAGE-BANDWIDTH' || name === 'AUDIO' || name === 'SUBTITLES') keep.push(a.trim());
  }
  if (!keep.some((a) => a.startsWith('BANDWIDTH='))) keep.unshift('BANDWIDTH=4000000');
  return '#EXT-X-STREAM-INF:' + keep.join(',');
}
// The whole master, reduced the same way. Used when there are no subtitle renditions to inject, so
// the master ffmpeg wrote would otherwise reach AVFoundation untouched.
function minimalMaster(text) {
  return String(text || '').replace(/^\uFEFF/, '').split('\n')
    .map((ln) => (/^#EXT-X-STREAM-INF:/.test(ln) ? minimalStreamInf(ln) : ln)).join('\n');
}
// The master playlist for a session whose consumer is AVFoundation, as it must be SERVED. ffmpeg rewrites
// its master after measuring the first segments (adding BANDWIDTH), overwriting anything done to the
// file earlier, so the shape is applied on every read rather than once at announce time.
//   shape.subEntries — subtitle renditions to carry (may be empty); shape === null leaves it untouched.
function masterWithSubs(text, subEntries) {
  // Rebuilt from the entries every time. Whatever subtitle lines the file already holds were put there by
  // an earlier pass that may have read a half-written master, so none of it is trusted.
  const lines = String(text || '').replace(/^\uFEFF/, '').split('\n')
    .filter((l) => !/^#EXT-X-MEDIA:TYPE=SUBTITLES/.test(l))
    .map((l) => l.replace(/,SUBTITLES="[^"]*"/, ''));
  const media = subEntries.map((e) =>
    `#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="${(e.name || e.lang).replace(/"/g, '')}",` +
    `LANGUAGE="${e.lang}",AUTOSELECT=NO,DEFAULT=NO,URI="${e.pl}"`).join('\n');
  const out = lines.map((ln) => (/^#EXT-X-STREAM-INF:/.test(ln)
    ? minimalStreamInf(ln) + (/SUBTITLES=/.test(ln) ? '' : ',SUBTITLES="subs"') : ln));
  let hi = out.findIndex((l) => /^#EXT-X-VERSION/.test(l));
  if (hi < 0) hi = out.findIndex((l) => /^#EXTM3U/.test(l));
  out.splice(hi < 0 ? 0 : hi + 1, 0, media);
  return out.join('\n');
}
// A master is whole when every stream line is followed by its URI and the file ends in a newline. ffmpeg
// writes it in place, so a read can land mid-write.
function isCompleteMaster(text) {
  const t = String(text || '');
  if (!t.startsWith('#EXTM3U') || !t.endsWith('\n')) return false;
  const lines = t.split('\n');
  let streams = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!/^#EXT-X-STREAM-INF:/.test(lines[i])) continue;
    streams++;
    const uri = lines[i + 1];
    if (!uri || uri.startsWith('#') || !uri.endsWith('.m3u8')) return false;
  }
  return streams > 0;
}
// ffmpeg writes the master in two steps: the audio renditions first, the stream line only after it has
// measured the video. On a source that arrives slowly that was more than a minute. The variant is always
// stream_0 (it is first in -var_stream_map), so the missing line can be written here.
function canSynthesizeMaster(text) {
  const t = String(text || '');
  return isCompleteMaster(t) || /^#EXT-X-MEDIA:TYPE=AUDIO[^\n]*URI="[^"]+"/m.test(t);
}
const DEFAULT_VARIANT_BANDWIDTH = 8000000;
function withStreamLine(text, bandwidth) {
  if (/^#EXT-X-STREAM-INF:/m.test(text)) return text;
  const group = (/^#EXT-X-MEDIA:TYPE=AUDIO[^\n]*GROUP-ID="([^"]+)"/m.exec(text) || [])[1];
  const bw = Number.isFinite(bandwidth) && bandwidth > 0 ? Math.round(bandwidth) : DEFAULT_VARIANT_BANDWIDTH;
  return text.replace(/\n*$/, '\n') + '#EXT-X-STREAM-INF:BANDWIDTH=' + bw + (group ? ',AUDIO="' + group + '"' : '') + '\nstream_0/index.m3u8\n';
}
function servedMaster(text, shape) {
  if (!shape) return text;
  const entries = Array.isArray(shape.subEntries) ? shape.subEntries : [];
  const whole = withStreamLine(String(text || '').replace(/^\uFEFF/, ''), shape.bandwidth);
  return entries.length ? masterWithSubs(whole, entries) : minimalMaster(whole);
}
function capSubSources(list, max) {
  const cap = max || MAX_REMOTE_SIDELOAD_SUBS;
  const all = list || [];
  if (all.length <= cap) return all.slice();
  // The cap is real and cannot simply be lifted: offering all 40 renditions of a release made
  // AVFoundation refuse the master outright (status=failed, EMPTY error log — it rejected the
  // manifest without fetching anything), where the same source at 8 loads and plays. AVPlayer walks
  // every rendition before it will show a frame, so the count is on the critical path.
  //
  // What WAS wrong is how the budget got spent: one per language, first occurrence wins. Measured on
  // a real release, that picked the 103-cue SIGNS track for English and dropped the two real dialogue
  // tracks (903 and 1257 cues) — so "English" showed a handful of captions across two hours and read
  // as broken. Nothing in the metadata separates them: forced=0 on all three, no titles, and
  // default=1 is set on the signs track, so every automatic rule picks wrong.
  //
  // So: keep EVERY track of the primary language (the first one in the file, which is the one a
  // viewer is overwhelmingly likely to want and the one whose variants actually differ), then one per
  // other language until the budget runs out. The viewer picks between the English entries on the
  // remote; extraction is on-demand, so an unselected one costs a 52-byte stub.
  const primary = String(all[0].lang || 'und').toLowerCase();
  const out = [];
  for (const s of all) if (String(s.lang || 'und').toLowerCase() === primary && out.length < cap) out.push(s);
  const seen = new Set([primary]);
  for (const s of all) {
    if (out.length >= cap) break;
    const lang = String(s.lang || 'und').toLowerCase();
    if (seen.has(lang)) continue;
    seen.add(lang);
    out.push(s);
  }
  return out;
}

const SUB_BUDGET_MS = 12000;
// The AirPlay rendition budget is longer than the cast one: the viewer has EXPLICITLY selected this
// track and is waiting for it, and only one extractor runs at a time now, so it is not competing with
// seven others for the same swarm.
const SUB_RENDITION_BUDGET_MS = 25000;
// How long to let ffmpeg finish and flush after SIGTERM before insisting.
const SUB_GRACE_MS = 3000;

// What the probe asks ffprobe for. Named and exported because one missing field here is invisible:
// `stream_side_data=side_data_type` alone reports THAT a stream carries Dolby Vision and never which
// profile, so every DV file arrived as "DV, profile unknown". Unknown is treated as unsafe to strip,
// which is right — and the consequence was that a profile-8 file, the recoverable kind, was sent to
// a full 4K H.264 re-encode instead of a copy the receiver would have played. Nothing errored; the
// picture simply never arrived. Ask for the fields whose absence changes the decision.
const PROBE_ENTRIES = 'stream=index,codec_type,codec_name,codec_tag_string,width,height,r_frame_rate,color_transfer,channels,channel_layout' +
  ':stream_side_data=side_data_type,dv_profile,dv_bl_signal_compatibility_id' +
  ':stream_tags=language,title:format=duration';

// Opt-in cast diagnostics (SPRITZ_DEBUG=1 → /tmp/spritz-cast.log), matching torrent.js and dlna.js.
// The cast path had no voice at all: ffmpeg's stderr went into an empty handler, so a transcode that
// died before emitting a byte looked identical to one still starting up — a receiver on its idle
// screen and nothing else. Every hypothesis about that screen was unfalsifiable as a result.
const CDBG = !!process.env.SPRITZ_DEBUG;
const CLOG = '/tmp/spritz-cast.log';
if (CDBG) { try { fs.writeFileSync(CLOG, '[cast] log started ' + new Date().toISOString() + '\n'); } catch (e) {} }
function clog(m) {
  if (!CDBG) return;
  try { fs.appendFileSync(CLOG, '[' + new Date().toISOString().slice(11, 23) + '] ' + m + '\n'); } catch (e) {}
}

// (incl. HDR10) and AC3/EAC3 passthrough, so we COPY instead of needlessly transcoding to 1080p
// AAC stereo. Unknown/legacy receivers get the conservative profile (downscale 4K, AAC audio).
// caps = { hevc, hevc4k, h264_4k, hdr10, dovi, audioCopy:Set, maxHeight }
//   • hevc    — receiver decodes HEVC at all (false → transcode HEVC to H.264, for old 1080p dongles)
//   • hevc4k  — decodes 4K HEVC (copy instead of downscaling to 1080p)
//   • hdr10   — displays HDR10 (else HDR is tonemapped to SDR)
// The DEFAULT (no caps) mirrors the historical conservative behaviour: copy ≤1080p H.264/HEVC incl.
// HDR10, downscale 4K to 1080p, AAC audio — safe for any AVPlayer/Cast receiver.
//
// The normalising itself (normCaps/CAPS_CONSERVATIVE/CAPS_FULL) now lives in device-profile.js as
// normalise()/defaultProfile(), called for us by planPlayback(). It accepts exactly the same loose
// shapes callers here have always passed, INCLUDING a Set for audioCopy, and defaults the same way:
// unknown field → the conservative value, because guessing a receiver is more capable than it is
// produces a black screen. So cast.js and every other caller can keep handing over whatever it has.

const MIME = {
  '.mp4': 'video/mp4', '.m4v': 'video/x-m4v', '.mov': 'video/quicktime',
  '.m3u8': 'application/vnd.apple.mpegurl', '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4', '.aac': 'audio/aac',
  // original containers served untouched to a DLNA renderer (LG webOS decodes these natively →
  // full 4K HEVC/HDR, no transcode). Correct MIME matters so the TV knows how to play them.
  '.mkv': 'video/x-matroska', '.webm': 'video/webm', '.avi': 'video/x-msvideo',
  '.ts': 'video/mp2t', '.m2ts': 'video/mp2t', '.wmv': 'video/x-ms-wmv',
  '.flv': 'video/x-flv', '.mpg': 'video/mpeg', '.mpeg': 'video/mpeg', '.ogv': 'video/ogg',
  '.flac': 'audio/flac', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.vtt': 'text/vtt',
  '.srt': 'text/srt', '.smi': 'application/smil'
};
const mimeFor = (p) => MIME[path.extname(p).toLowerCase()] || 'application/octet-stream';

// ffprobe results for a given byte-identical input never change, but recastMkv() re-probes on EVERY
// seek, audio-language change, burn toggle and subDelay nudge — each one a process spawn plus up to
// 5s of container parsing before the cast can even start. Memoize on the local file revision (device, inode, size, modification/change times): a
// still-downloading torrent file grows, which changes the key, so it re-probes exactly when it
// should. Inputs we can't stat (http:// URLs) are simply not cached.
const probeCache = new Map();
function probeKey(tag, input) {
  try { const st = fs.statSync(input); return tag + '\0' + input + '\0' + [st.dev, st.ino, st.size, st.mtimeMs, st.ctimeMs].join('\0'); }
  catch (e) { return null; }
}
// The LAST SUCCESSFUL reading, kept separately from probeCache. Local files use the
// same revision key; HTTP inputs use their URL — because probeKey() needs statSync, which fails for every http:// URL, i.e. for every
// torrent. So a torrent is re-probed from scratch on every seek and every recovery, and each of those
// probes can independently time out.
//
// Measured at 05:58, when a recovery fired four resolves within four seconds: three probed the source
// perfectly (`hevc 3840x1920 dovi profile 8 dur=3782 subs=40`) and the fourth exhausted its retries.
// With info null the planner has no codec, height or audio and correctly plans a full re-encode, so
// the loser's plan was `videoCodec h264, 0x0, videoCopied false, audioCopied false` — a blind 4K
// H.264 + AAC transcode of a file that had just been described correctly three times.
//
// A probe that FAILS has learned nothing about the file. It means ffprobe could not read right now —
// an empty swarm at six in the morning — not that the container changed. So a failure falls back to
// what we already read, and only a source we have NEVER read successfully goes to the blind plan.
const lastGoodProbe = new Map();
const probeMemKey = (tag, input) => /^https?:\/\//i.test(String(input || ''))
  ? tag + '\0' + String(input) : probeKey(tag, input);
function rememberProbe(tag, input, res) {
  if (!res) return res;
  if (lastGoodProbe.size > 32) lastGoodProbe.clear();
  const key = probeMemKey(tag, input);
  if (key) lastGoodProbe.set(key, res);
  return res;
}
function recallProbe(tag, input) { return lastGoodProbe.get(probeMemKey(tag, input)) || null; }

const probeJobs = new Map();
function memoProbe(tag, input, run, cb) {
  const key = probeKey(tag, input);
  if (key && probeCache.has(key)) { cb(probeCache.get(key)); return () => {}; }
  const owner = { cb, active: true };
  let job = key && probeJobs.get(key);
  const cancel = () => {
    if (!owner.active) return;
    owner.active = false;
    job.owners.delete(owner);
    if (!job.done && job.owners.size === 0) {
      job.done = true;
      if (key && probeJobs.get(key) === job) probeJobs.delete(key);
      if (typeof job.dispose === 'function') job.dispose();
    }
  };
  if (job) { job.owners.add(owner); return cancel; }
  job = { owners: new Set([owner]), done: false, dispose: null };
  if (key) probeJobs.set(key, job);
  const finish = (res) => {
    if (job.done) return;
    job.done = true;
    if (key && probeJobs.get(key) === job) probeJobs.delete(key);
    let result = null;
    if (key === probeKey(tag, input)) {
      if (key && res) { if (probeCache.size > 32) probeCache.clear(); probeCache.set(key, res); }
      result = res ? rememberProbe(tag, input, res) : recallProbe(tag, input);
    }
    const owners = [...job.owners]; job.owners.clear();
    for (const listener of owners) {
      if (!listener.active) continue;
      listener.active = false;
      try { listener.cb(result); } catch (e) { clog('probe consumer failed: ' + e.message); }
    }
  };
  try { job.dispose = run(finish); } catch (e) { finish(null); }
  return cancel;
}

// ffprobe the primary video + audio codec of an input (file path or http URL).
function probe(input, cb) { return memoProbe('probe', input, (done) => probeRaw(input, done), cb); }
function onceProbe(cb) {
  let answered = false;
  return (result) => {
    if (answered) return;
    answered = true;
    cb(result);
  };
}
function probeRaw(input, cb) {
  cb = onceProbe(cb);
  let out = '';
  const ps = spawn(FFPROBE, ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name',
    '-of', 'json', input], { timeout: 15000 });
  ps.stdout.on('data', (d) => { out += d; });
  ps.on('error', () => cb(null));
  ps.on('close', () => {
    try {
      const streams = (JSON.parse(out).streams) || [];
      const v = streams.find((s) => s.codec_type === 'video');
      const a = streams.find((s) => s.codec_type === 'audio');
      cb({ vcodec: v && v.codec_name, acodec: a && a.codec_name });
    } catch (e) { cb(null); }
  });
  return () => { cb = () => {}; try { ps.kill('SIGKILL'); } catch (e) {} };
}

// pipe a file to a response, tearing the read stream down if the client walks away. A cast receiver
// aborts range requests constantly (every seek, every buffer re-fill), and `.pipe(res)` alone does
// NOT close the source on an aborted response — each abandoned request leaks an open fd for the
// lifetime of the process, and a long cast makes thousands of them.
function pipeFile(res, rs) {
  const kill = () => { try { rs.destroy(); } catch (e) {} };
  rs.on('error', () => { kill(); res.destroy(); });
  res.on('close', kill);
  res.on('error', kill);
  rs.pipe(res);
}

const REMUX_DIR = path.join(os.tmpdir(), 'spritz', 'remux');
const HLS_DIR = path.join(os.tmpdir(), 'spritz', 'hls');
// The PARENTS of every instance's temp media roots, not directories anything writes into directly.
// Each createLanServer owns exactly one subdirectory of each and never touches a sibling's — see
// ownedRoots below for why that distinction is the whole point.
const VOD_DIR = path.join(os.tmpdir(), 'spritz', 'vod');

// Is the process that owns a VOD root still running?
//
// Signal 0 checks for existence without delivering anything. ESRCH is the only answer that means
// "gone": EPERM means the process exists and belongs to another user, which is emphatically not
// permission to delete its media. Anything else unrecognised is treated as alive, because the cost
// of guessing wrong in that direction is a bounded leftover directory, and the cost of guessing
// wrong in the other is the bug this whole scheme exists to remove.
function ownerAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; }
}

// Remove roots under `parent` whose owning process is gone.
//
// This is what recovers the disk after a crash, which is the one legitimate job the global wipes
// this replaced were doing — a crashed Spritz cannot clean up after itself, and an HLS or VOD root
// is roughly the size of the film. Bounded by construction: it deletes only entries whose name
// parses as an owner id AND whose owner is not running, so a live sibling — another Spritz, or
// another lanserver in this process — is never a candidate, and a name it cannot parse an owner out
// of is not its business. A reused pid reads as alive and its root survives to the next sweep.
//
// One function for all three media classes deliberately: three subtly different ownership schemes
// is how one of them ends up wrong.
function sweepDeadOwners(parent) {
  try {
    for (const name of fs.readdirSync(parent)) {
      const m = /^(\d+)-[0-9a-f]{8}$/.exec(name);
      if (!m || ownerAlive(Number(m[1]))) continue;
      try { fs.rmSync(path.join(parent, name), { recursive: true, force: true }); } catch (e) {}
    }
  } catch (e) {} // no parent yet: nothing to sweep
}
// How many produced segments to keep. A segment is a few MB and a film is hundreds of them, so this
// is the difference between a cache and a second copy of the movie. Generous enough that ordinary
// linear playback never re-encodes anything it has just watched.
//
// Module scope rather than inside the factory so a test can assert against the real bound instead
// of a second copy of the number that could drift away from the one the cache uses.
const VOD_CACHE_SEGMENTS = 40;
// How far a proxied source read advances between position reports. Every report crosses into the
// torrent scheduler, so this is the difference between "cheap enough to leave on" and a callback per
// 16 KB chunk. A megabyte is under a second of a 10 Mbps film — finer than the swarm can act on.
const SOURCE_READ_COALESCE_BYTES = 1024 * 1024;

module.exports = function createLanServer(opts) {
  const onWarn = (opts && opts.onWarn) || (() => {});
  // Called when the cast stream stops for a reason that is NOT a deliberate teardown. The receiver
  // hanging up looks identical to being cancelled from in here, but only one of them means the
  // viewer is now staring at a stalled picture with nothing being sent.
  const onCastStreamLost = (opts && opts.onCastStreamLost) || (() => {});
  // Called when the AirPlay HLS session is destroyed. cancelHls deletes the directory the AVPlayer is
  // bound to, and nothing downstream could tell — so a castUrl kept pointing at a token that now 404s,
  // which is what "AirPlay does nothing" looks like from the couch (CoreMedia -16839 at prepare).
  const onAirplayHlsGone = (opts && opts.onAirplayHlsGone) || (() => {});
  // Ask the torrent engine to make a byte range urgent, because a receiver has just asked for it.
  // Fire-and-forget by design: see the range handling in serveDlnaProxy for why this must not be
  // waited on. No hook (a build with no torrent engine attached) simply means no prioritisation.
  const onSeekBytes = (opts && opts.onSeekBytes) || (() => {});
  // Where a proxied source read IS, as it happens — see serveDlnaProxy. This is how the packager's
  // demand reaches the torrent scheduler: the packager reads the torrent through this proxy, so the
  // proxy is the one place that demand can be observed directly rather than inferred from which
  // segment ffmpeg last wrote. Reports carry `reader` ('producer' for a serveSource URL, 'viewer'
  // for a television on the DLNA route) because the two are different authorities and must not be
  // confused — critical-authority.js is what tells them apart. Coalesced by
  // SOURCE_READ_COALESCE_BYTES; fire-and-forget like onSeekBytes.
  const onSourceRead = (opts && opts.onSourceRead) || (() => {});
  // The packaging run's lifecycle — true when an epoch's ffmpeg starts, false when it exits, fails,
  // is stopped or is superseded. Forwarded to torrent.setProducerActive: this is the ONLY thing
  // that makes the producer the authority for the critical window. Never derived from a request.
  const onProducerActive = (opts && opts.onProducerActive) || (() => {});
  const registerSourceProducer = opts && opts.registerSourceProducer;
  // Sweep leftover transcode segments / remux temp MP4s from previous runs at startup. A long cast
  // keeps every fMP4 segment (a full transcoded copy) and remux makes a full temp MP4 — crashes can
  // orphan gigabytes here. Active sessions clean themselves (cancelHls/cancelRemux); this clears the
  // dead ones. Safe at construction: nothing is streaming yet.
  // THIS instance's temp media roots. Everything this lanserver produces lives under one of them,
  // and they are the only things this lanserver ever deletes.
  //
  // It used to be that every instance wrote sessions directly into VOD_DIR and wiped that whole
  // directory both at construction and at teardown. Nothing about either wipe asked whose media it
  // was removing, and the answer was regularly "somebody else's": quitting one Spritz deleted a
  // second running Spritz's active segments, and the television reported
  // MEDIA_ERR_SRC_NOT_SUPPORTED — which reads like a codec fault and was a 404. The same shape
  // deleted one test file's live session from another under `node --test` concurrency.
  //
  // pid FIRST so the owner is identifiable, and random bytes after it because one process can hold
  // more than one lanserver and a pid alone would have them share a root — the in-process half of
  // exactly the same bug.
  const ownerId = process.pid + '-' + crypto.randomBytes(4).toString('hex');
  const vodRoot = path.join(VOD_DIR, ownerId);
  const hlsRoot = path.join(HLS_DIR, ownerId);
  const remuxRoot = path.join(REMUX_DIR, ownerId);
  // One id across all three, so a crash leaves one owner's artifacts identifiable everywhere rather
  // than three unrelated names that have to be correlated to be cleaned up.
  // Recover disk from owners that are gone. Replaces the global wipes that used to run here and
  // took live siblings' media with them.
  for (const parent of [VOD_DIR, HLS_DIR, REMUX_DIR]) sweepDeadOwners(parent);
  let server = null, port = 0;
  let hlsWatch = null, hlsWarned = false; // disk watchdog for the live-HLS temp dir
  let receiverSubtitles = null;
  let hlsSubTasks = new Map();          // vtt filename -> extraction task, for extraction-on-selection
  let airplayPos = 0;                   // where the AVPlayer is, pushed in from the orchestrator
  let startSubExtract = () => {};       // set by extractSubs for the CURRENT session
  let hlsStartedAt = 0, hlsAnnounced = false; // diagnostics for the session-churn investigation
  const files = new Map();  // token → absolute path  (/file/, originals + remuxed temp files)
  const proxyRequests = new Set();
  const proxyHeaderTimeoutMs = opts && opts.proxyHeaderTimeoutMs || 15000;
  function cancelProxyRequests() {
    for (const cancel of [...proxyRequests]) cancel();
  }
  const dlnaProxies = new Map(); // token → { url, type }  (/dlna/ DLNA-compliant proxy → webtorrent)
  let remuxProc = null, remuxOut = null; // current ffmpeg remux + its temp file
  let hlsPreparation = null, hlsGeneration = 0;
  let hlsProducer = null;
  let hlsProc = null, hlsDir = null, hlsToken = null; // current live HLS remux
  let subProcs = []; // background WebVTT sidecar-extraction ffmpegs (one per text sub track)
  let mkvProc = null, mkvEntry = null, mkvRes = null; // current single-stream cast (Chromecast transport)
  let mkvSubProcs = [];  // on-demand WebVTT extractions for that cast — tracked so they can be killed
  const newToken = () => crypto.randomBytes(16).toString('hex'); // unguessable (LAN-exposed)

  // Start the LAN server if it is not up, and call back once it is.
  //
  // RE-ENTRANT ON PURPOSE. listen() is asynchronous, so the old `if (server && server.listening)`
  // test was false for BOTH of two callers arriving in the same tick, and both created a server.
  // Two callers at once is ordinary — resolving an AirPlay URL and a DLNA URL for one file, or a
  // source change landing while the previous resolve is still in flight — and the damage is not
  // cosmetic: the first server was never closed, because teardown only knows about the variable
  // that now holds the second, so it stayed bound for the life of the process; and `port` was
  // written by whichever listen finished last, while a caller may already have built a URL from the
  // other. A cast URL naming a port nothing is listening on is a receiver that cannot fetch,
  // from a Spritz that believes it is serving.
  //
  // Measured with three concurrent serveDlna calls: three servers created, one closed.
  let pendingListen = null; // callbacks waiting on a listen already in flight
  let binding = null;       // the server whose listen is in flight, so teardown can close it
  // Subscribers wanting the HTTP server ITSELF, rather than a URL served by it.
  //
  // The receiver control channel is a WebSocket that shares this port through `upgrade`, so it needs
  // the server object. It is a subscription rather than a getter because the server is created
  // lazily and is REPLACED when lanserver relists after a teardown: a caller holding the old
  // instance would keep an upgrade handler on a socket nobody is listening to any more, and the
  // television would simply never connect, with nothing in any log to say why.
  const serverSubs = [];
  function onServer(fn) {
    if (typeof fn !== 'function') return () => {};
    serverSubs.push(fn);
    // A late subscriber gets the running server at once, so registration order cannot matter.
    if (server && server.listening) { try { fn(server); } catch (e) {} }
    return () => { const i = serverSubs.indexOf(fn); if (i >= 0) serverSubs.splice(i, 1); };
  }
  function announceServer(s) { for (const fn of serverSubs.slice()) { try { fn(s); } catch (e) {} } }

  function ensure(cb) {
    if (server && server.listening) return cb();
    if (pendingListen) { pendingListen.push(cb); return; }
    pendingListen = [cb];
    const s = http.createServer(handle);
    s.on('error', (e) => console.error('[lan] server err', e.message));
    const flush = () => {
      const waiting = pendingListen || [];
      pendingListen = null;
      for (const w of waiting) { try { w(); } catch (e) {} }
    };
    // A listen that FAILS must still release its waiters, or every path that needed the server
    // hangs silently — which from the couch is a cast button that does nothing, forever.
    s.once('error', () => { if (server === s) server = null; if (binding === s) binding = null; flush(); });
    // Remembered while the listen is in flight, so a teardown arriving before it completes — the
    // application quitting at once, or a caller that never yields — can still close it. Recording
    // the server only in the listen callback left that teardown with nothing to close, and the
    // callback then produced a live listener nobody owned: the process could not exit.
    binding = s;
    s.listen(0, '0.0.0.0', () => {
      if (binding !== s) { try { s.close(); } catch (e) {} flush(); return; }   // torn down while binding
      binding = null;
      server = s; port = s.address().port; announceServer(s); flush();
    });
  }

  function handle(req, res) {
    // "Is a Spritz here?" — the ONLY thing an unpaired television may ask.
    //
    // A receiver cannot use mDNS to find the Mac: a webOS web application has no multicast and no
    // raw sockets. So it probes LAN addresses on this port, and this answers. Because it is
    // reachable by anything on the network before any trust exists, its restraint is the design: a
    // marker, a human-readable machine name so the person pairing can tell which Mac this is, and
    // the protocol version. No receiver list, no media, no library, nothing that could be used to
    // enumerate anything. Everything else on this route requires pairing.
    if (req.url === '/spritz/hello') {
      const body = JSON.stringify({ spritz: true, name: os.hostname().replace(/\.local$/, ''), protocol: 1 });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body),
        'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
      return res.end(req.method === 'HEAD' ? undefined : body);
    }
    // CORS preflight — the Google Cast receiver sends one before GETting a sideloaded WebVTT track
    // (its Range header isn't CORS-safelisted). Answer it so the subtitle track loads.
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Range', 'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS', 'Access-Control-Max-Age': '86400' });
      return res.end();
    }
    const hm = /^\/hls\/([^/]+)\/([^?]+)/.exec(req.url || '');
    if (hm) return serveHlsFile(req, res, hm[1], hm[2]);
    const km = /^\/mkv\/([^/?]+)/.exec(req.url || '');
    if (km) return serveMkvStream(req, res, km[1]);
    const sm = /^\/sub\/([^/]+)\/([^/?]+)/.exec(req.url || '');
    if (sm) return serveMkvSub(req, res, sm[1], decodeURIComponent(sm[2]));
    const dm = /^\/dlna\/([^/]+)/.exec(req.url || '');
    if (dm) return serveDlnaProxy(req, res, dm[1]);
    const vm = /^\/vod\/([^/]+)\/((?:epoch-[A-Za-z0-9_-]+\/)?[^/?]+)/.exec(req.url || ''); // epoch-N/ is the one nested level
    if (vm) return serveVodFile(req, res, vm[1], vm[2]);
    const fm = /^\/file\/([^/]+)/.exec(req.url || '');
    return serveFile(req, res, fm && files.get(fm[1]));
  }

  // ---- DLNA-aware proxy (for torrent streams) ----------------------------------------------------
  // webOS DLNA renderers are strict: before playing they send a HEAD and expect DLNA response
  // headers (contentFeatures.dlna.org / TransferMode) + range support. webtorrent's own HTTP server
  // emits none of that, so the TV reports "device is disconnected". This proxy sits in front of the
  // webtorrent localhost server, speaks DLNA to the TV, and forwards ranged GETs underneath — so the
  // LG connects, plays the original MKV/HEVC/HDR natively, and seeks via byte-range.
  // 4th protocolInfo field. MUST match the DIDL protocolInfo in dlna.js byte-for-byte (strict webOS
  // compares the HTTP contentFeatures.dlna.org header against the SOAP DIDL and rejects on mismatch)
  // — which is now guaranteed rather than remembered: both sites call the same flagsFor(). What the
  // profiles are, and when the torrent proxy is allowed to claim seekability, is in dlna-flags.js.
  // serveDlna(upstreamLocalhostUrl, contentType, cb) → cb(proxyLanUrl|null)
  const tokenRegistrations = new Set();
  function cancelTokenRegistrations() {
    for (const cancel of [...tokenRegistrations]) cancel();
  }
  function tokenReady(cb, publish) {
    let settled = false;
    const cancel = () => {
      if (settled) return;
      settled = true;
      tokenRegistrations.delete(cancel);
      try { cb(null); } catch (e) {}
    };
    tokenRegistrations.add(cancel);
    ensure(() => {
      if (settled) return;
      settled = true;
      tokenRegistrations.delete(cancel);
      publish();
    });
    return cancel;
  }
  function serveDlna(upstreamUrl, type, cb) {
    const lan = lanAddress();
    if (!lan || !upstreamUrl) return cb(null);
    return tokenReady(cb, () => {
      const token = newToken();
      dlnaProxies.set(token, { url: upstreamUrl, type: type || 'video/mp4' });
      const name = (String(upstreamUrl).split('?')[0].split('/').pop()) || 'video';
      cb(`http://${lan}:${port}/dlna/${token}/${name}`);
    });
  }
  // The same proxy, for the PACKAGER. ffmpeg reads a torrent-backed source through this so that its
  // reads are observable (onSourceRead) and prioritisable (onSeekBytes) — the two things a file path
  // straight into webtorrent's own server would not give us. Loopback, because the only reader is an
  // ffmpeg on this machine: it is never handed to a television, and serveDlnaProxy refuses it from
  // anywhere else.
  function serveSource(upstreamUrl, cb) {
    if (!upstreamUrl) return cb(null);
    return tokenReady(cb, () => {
      const token = newToken();
      dlnaProxies.set(token, { url: upstreamUrl, type: 'application/octet-stream', reader: 'producer' });
      const name = (String(upstreamUrl).split('?')[0].split('/').pop()) || 'source';
      cb(`http://127.0.0.1:${port}/dlna/${token}/${name}`);
    });
  }
  function createOwnedSource(input) {
    const lease = registerSourceProducer(input);
    if (!lease) return null;
    const token = newToken();
    const entry = { url: input, type: 'application/octet-stream', reader: 'producer', producerOwner: lease, cancelReads: new Set() };
    dlnaProxies.set(token, entry);
    let disposed = false;
    return {
      url: 'http://127.0.0.1:' + port + '/dlna/' + token + '/source',
      setActive: active => { if (!disposed) lease.setActive(active); },
      dispose: () => {
        if (disposed) return;
        disposed = true; lease.dispose(); dlnaProxies.delete(token);
        for (const cancel of [...entry.cancelReads]) cancel();
      }
    };
  }
  function serveDlnaProxy(req, res, token) {
    const ent = dlnaProxies.get(token);
    if (!ent) { res.writeHead(404); res.end(); return; }
    const reader = ent.reader || 'viewer';
    // A producer URL answers only the machine it was issued on. It exists to be read by a local
    // ffmpeg; a television that somehow learned it would otherwise get an undescribed byte stream
    // and, worse, its reads would be attributed to the packager and steer the swarm.
    if (reader === 'producer') {
      const ra = req.socket && req.socket.remoteAddress;
      if (ra !== '127.0.0.1' && ra !== '::1' && ra !== '::ffff:127.0.0.1') { res.writeHead(403); res.end(); return; }
    }
    let u; try { u = new URL(ent.url); } catch (e) { res.writeHead(404); res.end(); return; }
    const upReq = (method, headers, onRes) => {
      let upstream = null, settled = false, timer;
      const cancel = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        proxyRequests.delete(cancel);
        if (ent.cancelReads) ent.cancelReads.delete(cancel);
        req.removeListener('aborted', cancel);
        res.removeListener('close', cancel);
        r.destroy();
        if (upstream) upstream.destroy();
        if (!res.writableEnded) res.destroy();
      };
      const r = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method, headers }, (ur) => {
        clearTimeout(timer);
        if (settled || dlnaProxies.get(token) !== ent || res.destroyed) { ur.destroy(); return; }
        upstream = ur;
        onRes(ur);
      });
      proxyRequests.add(cancel);
      if (ent.cancelReads) ent.cancelReads.add(cancel);
      req.once('aborted', cancel);
      res.once('close', cancel);
      timer = setTimeout(() => {
        if (!res.headersSent) { res.writeHead(504); res.end(); }
        cancel();
      }, proxyHeaderTimeoutMs);
      r.on('error', () => {
        if (settled) return;
        if (!res.headersSent) { res.writeHead(502); res.end(); }
        cancel();
      });
      return r;
    };
    const dlnaHdrs = (extra) => Object.assign({
      'Content-Type': ent.type,
      'Accept-Ranges': 'bytes',
      // The proxy only ever fronts a (possibly still-downloading) torrent, so this is the one URL
      // whose profile depends on whether seeking has been opted into.
      'contentFeatures.dlna.org': flagsFor(req.url),
      'transferMode.dlna.org': req.headers['transfermode.dlna.org'] || 'Streaming'
    }, extra || {});
    // HEAD: webtorrent's server may not answer HEAD, so probe the total size with a 1-byte ranged
    // GET (→ 206 Content-Range: bytes 0-0/TOTAL) and reply with DLNA headers + the full length.
    if (req.method === 'HEAD') {
      const probe = upReq('GET', { Range: 'bytes=0-0' }, (ur) => {
        let total = 0;
        const cr = ur.headers['content-range'];
        if (cr) { const m = /\/(\d+)\s*$/.exec(cr); if (m) total = parseInt(m[1], 10); }
        else if (ur.headers['content-length']) total = parseInt(ur.headers['content-length'], 10);
        ur.destroy();
        res.writeHead(200, dlnaHdrs(total ? { 'Content-Length': String(total) } : {}));
        res.end();
      });
      probe.end();
      return;
    }
    // GET (ranged or whole): forward to webtorrent, relay its status + range headers, add DLNA ones.
    //
    // A ranged GET into a torrent may be asking for bytes that have not downloaded yet. webtorrent
    // will serve it regardless — it selects the pieces and blocks — but unprioritised that read
    // queues behind the sequential readahead and the television gives up first. So tell the torrent
    // engine where the receiver just jumped to, and let it aim the critical window there.
    //
    // Deliberately NOT waited on. The request is forwarded immediately so webtorrent answers with
    // its 206 and Content-Range at once: a renderer tolerates a slow BODY (that is what the
    // CONNECTION_STALL flag asks of it) far better than slow HEADERS, and blocking here to poll the
    // bitfield would turn a seek into a silent multi-second hang before the TV heard anything at
    // all. Prioritising and serving happen in parallel; the wait is where it was always going to be.
    //
    // VIEWER reads only. onSeekBytes leads to torrent.ensureBytes, which moves the viewer's playhead
    // — correct for a television, and precisely wrong for the packager, whose reads would otherwise
    // impersonate the viewer. A producer's demand goes out through onSourceRead below instead.
    if (reader === 'viewer' && SEEK_ENABLED() && req.headers.range) {
      const m = /^bytes=(\d+)-/.exec(String(req.headers.range));
      // Only a seek. bytes=0- is the opening request of ordinary linear playback and needs nothing.
      if (m && Number(m[1]) > 0) { try { onSeekBytes(Number(m[1])); } catch (e) {} }
    }
    const headers = {};
    if (req.headers.range) headers.Range = req.headers.range;
    // The demand this read expresses. The range START is exact — measured against a real ffmpeg, a
    // seek is a fresh request that begins precisely at the bytes it wants. What follows is one
    // response held open for as long as the reader keeps consuming, so the ongoing position is only
    // visible as bytes relayed through it: that is what the progress reports below carry. Delivered
    // runs AHEAD of what the reader has consumed by the socket buffers, so the position is an upper
    // bound in the ahead direction — the harmless direction for aiming a swarm.
    const rm = /^bytes=(\d+)-/.exec(String(req.headers.range || ''));
    const readStart = rm ? Number(rm[1]) : 0;
    let relayed = 0, lastReport = 0;
    const observe = (event, extra) => { try {
      const observation = Object.assign({ reader, token, event, byteStart: readStart, position: readStart + relayed }, extra || {});
      if (ent.producerOwner) ent.producerOwner.noteSourceRead(observation);
      else onSourceRead(observation);
    } catch (e) {} };
    observe('open');
    res.once('close', () => observe('close', { complete: !!res.writableEnded }));
    const up = upReq('GET', headers, (ur) => {
      const h = dlnaHdrs();
      if (ur.headers['content-range']) h['Content-Range'] = ur.headers['content-range'];
      if (ur.headers['content-length']) h['Content-Length'] = ur.headers['content-length'];
      res.writeHead(ur.statusCode || 200, h);
      ur.on('data', (c) => {
        relayed += c.length;
        if (relayed - lastReport >= SOURCE_READ_COALESCE_BYTES) { lastReport = relayed; observe('progress'); }
      });
      // A mid-body upstream failure (a webtorrent read aborts, a peer is lost) must NOT be relayed as a
      // clean FIN: a DLNA renderer reads a clean end-of-body as "stream finished" and STOPS instead of
      // resuming. Reset the socket (RST) so the LG re-issues the ranged GET and reconnects. Fire only on
      // an INCOMPLETE body — ur.pipe() calls res.end() on normal completion (writableEnded → true).
      const fatal = () => { try { res.destroy(); } catch (e) {} try { ur.destroy(); } catch (e) {} };
      ur.on('error', fatal);
      ur.on('aborted', fatal);
      ur.on('close', () => { if (!res.writableEnded) fatal(); });
      ur.pipe(res);
    });
    up.end();
  }

  // Serve a file from the live-HLS temp dir (master/media .m3u8, fMP4 segments, .vtt subs).
  // Nested subdirs are allowed (multi-rendition output: stream_0/…, stream_1/…), but no `..`.
  // How master.m3u8 must be shaped for the CURRENT session (set when it is announced). Null = serve as written.
  let hlsMasterShape = null;
  // Set when the current session's producer exits: lets the media playlists be served as FINISHED (see hls-finish).
  let hlsFinish = null;
  function serveHlsFile(req, res, token, name) {
    try { name = decodeURIComponent(name); } catch (e) { res.writeHead(404); res.end(); return; }
    // This server is bound to 0.0.0.0 so televisions can reach it, and `name` is whatever the
    // receiver asked for. Containment is proved by resolving, rather than by scanning for '..' —
    // the old check happened to hold, but it answers "does this look dangerous" when the question
    // is "does this land inside hlsDir". Access still requires the 128-bit token above.
    // Three different reasons produced an identical silent 404, and telling them apart matters: a
    // stale token means the session moved on under a live AVPlayer, a missing file means ffmpeg has
    // not written it yet, and a containment failure means the receiver asked for something odd.
    // Observed a 404 on index.m3u8 for a session the cast log said was current and undestroyed —
    // unexplainable precisely because the 404 never said which of the three it was.
    if (token !== hlsToken) {
      clog('GET /hls 404: STALE TOKEN ' + String(token).slice(0, 8) + ' (current is ' +
        (hlsToken ? String(hlsToken).slice(0, 8) : 'none') + ') for ' + name);
      res.writeHead(404); res.end(); return;
    }
    const f = hlsDir ? containedPath(hlsDir, name) : null;
    if (!f) { clog('GET /hls 404: ' + (hlsDir ? 'path escapes the session dir' : 'no session dir') + ' for ' + name); res.writeHead(404); res.end(); return; }
    const query = new URL(req.url, 'http://localhost').searchParams;
    if (receiverSubtitles && receiverSubtitles.has(name)) {
      if (query.get('spritzSubPrepare') === '1' || query.get('spritzSubCancel') === '1') {
        const owner = query.get('spritzSubOwner') || '';
        const body = query.get('spritzSubCancel') === '1'
          ? { cancelled: receiverSubtitles.cancel(name, owner) }
          : receiverSubtitles.prepare(name, owner, Number(query.get('spritzSubPosition')));
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify(body)); return;
      }
    }
    const stat = safeStat(f);
    if (!stat) { clog('GET /hls 404: NOT WRITTEN YET — ' + name); res.writeHead(404); res.end(); return; }
    clog('GET /hls ' + name + ' size=' + stat.size + (req.headers.range ? ' range=' + req.headers.range : '') + ' from=' + (req.socket && req.socket.remoteAddress));
    if (name === 'master.m3u8' && hlsMasterShape && hlsMasterShape.token === token) {
      // ffmpeg writes this file in place; a read can land mid-write. Wait briefly for a whole one rather than
      // hand AVFoundation a fragment, which it refuses outright.
      const shape = hlsMasterShape;
      const attempt = (n) => {
        let raw = '';
        try { raw = fs.readFileSync(f, 'utf8'); } catch (e) { /* retried below */ }
        if (canSynthesizeMaster(raw)) {
          const body = servedMaster(raw, shape);
          res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache', 'Content-Length': Buffer.byteLength(body) });
          res.end(req.method === 'HEAD' ? undefined : body);
        } else if (n < 40) setTimeout(() => attempt(n + 1), 25);
        else { clog('master.m3u8 never became whole'); res.writeHead(503, { 'Retry-After': '1' }); res.end(); }
      };
      attempt(0);
      return;
    }
    // The receiver asking for a subtitle rendition IS the viewer selecting that track — there is no
    // other signal, and it is the only one that also catches a choice made on the TV's remote.
    if (/^sub_.*\.vtt$/.test(name)) {
      const requested = new URL(req.url, 'http://localhost').searchParams.get('spritzSubPosition');
      const position = requested === null ? null : Number(requested);
      const task = hlsSubTasks.get(name);
      try { startSubExtract(name, Number.isFinite(position) && position >= 0 ? position : null); } catch (e) {}
      // AVPlayer requests plain rendition URLs, without Spritz's position query.
      // Those requests must also wait: an empty successful segment is cached as
      // the selected track and never gains the cues published by extraction.
      if (task) {
        require('./subtitle-ready-response').waitForSubtitle({ response: res,
          timeoutMs: SUB_RENDITION_BUDGET_MS + SUB_GRACE_MS + 1000,
          state: () => token !== hlsToken ? 'stale' : task.status === 'ready' ? 'ready' : task.status === 'failed' ? 'failed' : 'pending',
          finish: status => {
            clog('subtitle response ' + name + ': ' + status + ', queued=' + (task.startedAt ? task.startedAt - task.queuedAt : Date.now() - task.queuedAt) + 'ms');
            const currentStat = status === 'ready' && safeStat(f);
            if (currentStat) return deliverFile(req, res, f, currentStat.size, 'text/vtt', { 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
            res.writeHead(status === 'stale' ? 404 : 503, { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store', ...(status === 'stale' ? {} : { 'Retry-After': '1' }) }); res.end();
          }
        });
        return;
      }
    }
    const type = name.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl'
      : name.endsWith('.vtt') ? 'text/vtt' : 'video/mp4'; // fMP4 segments / WebVTT subs
    const startParam = new URL(req.url, 'http://localhost').searchParams.get('spritzStart');
    const start = startParam === null ? NaN : Number(startParam);
    if (hlsFinish && hlsFinish.token === token && /^(stream_\d+\/)?index\.m3u8$/.test(name) && !(Number.isFinite(start) && start >= 0)) {
      try {
        const done = require('./hls-finish').finishedVariant(fs.readFileSync(f, 'utf8'), hlsFinish.duration, hlsFinish.code, hlsFinish.signal);
        if (done) {
          res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache', 'Content-Length': Buffer.byteLength(done) });
          res.end(req.method === 'HEAD' ? undefined : done);
          return;
        }
      } catch (e) { /* fall through to the file as written */ }
    }
    if (name.endsWith('.m3u8') && Number.isFinite(start) && start >= 0) {
      try {
        const body = require('./hls-start-position').playlist(fs.readFileSync(f, 'utf8'), start);
        res.writeHead(200, { 'Content-Type': type, 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache', 'Content-Length': Buffer.byteLength(body) });
        res.end(req.method === 'HEAD' ? undefined : body);
      } catch (e) { res.writeHead(503); res.end(); }
      return;
    }
    deliverFile(req, res, f, stat.size, type, { 'Cache-Control': 'no-cache', 'Access-Control-Allow-Origin': '*' });
  }

  function deliverFile(req, res, file, size, type, extra) {
    const range = byteRange(req.headers.range, size, req.method);
    if (range.kind === 'unsatisfiable') {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` });
      res.end(); return;
    }
    const partial = range.kind === 'partial';
    const start = partial ? range.start : 0;
    const end = partial ? range.end : size - 1;
    const headers = Object.assign({ 'Content-Type': type, 'Content-Length': partial ? end - start + 1 : size,
      'Accept-Ranges': 'bytes' }, extra);
    if (partial) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
    res.writeHead(partial ? 206 : 200, headers);
    if (req.method === 'HEAD' || size === 0) { res.end(); return; }
    // Bound growing files to the bytes promised and close readers when the client leaves.
    pipeFile(res, fs.createReadStream(file, { start, end }));
  }

  function serveFile(req, res, file) {
    const stat = file && safeStat(file);
    if (!stat) { res.writeHead(404); res.end(); return; }
    const dlna = { 'contentFeatures.dlna.org': flagsFor(req.url), // a /file/ URL is always the complete, seekable article
      'transferMode.dlna.org': req.headers['transfermode.dlna.org'] || 'Streaming',
      'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Range', 'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS' };
    deliverFile(req, res, file, stat.size, mimeFor(file), dlna);
  }

  function cancelRemux() {
    const child = remuxProc, output = remuxOut;
    remuxProc = null; remuxOut = null;
    if (child) { try { child.kill('SIGKILL'); } catch (e) {} }
    if (output) { try { fs.unlinkSync(output); } catch (e) {} }
  }
  function cancelHls() {
    if (typeof hlsProducer !== 'undefined' && hlsProducer) {
      const owned = hlsProducer; hlsProducer = null;
      owned.dispose();
    }
    if (receiverSubtitles) { receiverSubtitles.destroy(); receiverSubtitles = null; }
    ++hlsGeneration;
    const pending = hlsPreparation; hlsPreparation = null;
    // Diagnostic only. An AirPlay HLS session torn down while AVPlayer is still loading it produces
    // -16839 ("unable to get playlist") or -12312 (404) with nothing in the log to say the ground had
    // moved. Observed three sessions created in quick succession, the first two destroyed under a
    // live item. This says WHICH token died, how old it was, and who asked.
    if (hlsToken) {
      clog('cancelHls: destroying session ' + String(hlsToken).slice(0, 8) +
        ' after ' + (Date.now() - (hlsStartedAt || Date.now())) + 'ms' +
        (hlsAnnounced ? ' (ANNOUNCED — an AVPlayer item may be bound to it)' : ' (never announced)') +
        ' — asked by ' + whoCalled());
    }
    if (hlsProc) { try { hlsProc.kill('SIGKILL'); } catch (e) {} hlsProc = null; }
    for (const p of subProcs) { try { p.kill('SIGKILL'); } catch (e) {} }
    subProcs = [];
    if (hlsWatch) { clearInterval(hlsWatch); hlsWatch = null; } hlsWarned = false;
    if (hlsDir) { try { fs.rmSync(hlsDir, { recursive: true, force: true }); } catch (e) {} hlsDir = null; }
    hlsSubTasks = new Map(); startSubExtract = () => {}; // a dead session must not start extractors
    const had = !!hlsToken;
    hlsToken = null; hlsMasterShape = null; hlsFinish = null;
    // Announce the demolition. The URL handed out for this session is dead the moment the directory
    // goes, and an AVPlayer left bound to it fails at load with no way back.
    if (had) { try { onAirplayHlsGone(); } catch (e) {} }
    if (pending) pending();
  }
  // Pause the AirPlay preparation while another route is casting.
  //
  // The HLS remux is started at load time so the AirPlay picker has something ready the instant it
  // is tapped. It keeps running through a Chromecast or DLNA cast, for a route that cast is not
  // using — measured twice on real sessions at ~300-345% CPU (12m50s of CPU in 3m44s of wall on one
  // of them), with its own subtitle extractions, all reading the same torrent as the live cast. The
  // selections log showed it holding pieces at the front of the file at the same priority as the
  // cast's read head, so the swarm was being split between a stream someone is watching and one
  // nobody is.
  //
  // Suspended rather than cancelled, deliberately. cancelHls() is destructive — it SIGKILLs the
  // remux, deletes the temp directory and nulls the token — which leaves the AVPlayer bound to an
  // item that has stopped existing. That regression has been paid for once already: engaging AirPlay
  // in that window produced the OS "Could not connect" dialog. SIGSTOP costs the CPU and the reads
  // while keeping the token, the directory and every segment already written, so the item stays
  // valid and this is reversible by definition.
  function suspendAirplayPrep() {
    let n = 0;
    if (hlsProc) { try { process.kill(hlsProc.pid, 'SIGSTOP'); n++; } catch (e) {} }
    for (const p of subProcs) { try { process.kill(p.pid, 'SIGSTOP'); n++; } catch (e) {} }
    if (n) clog('suspended ' + n + ' AirPlay preparation process(es) for the duration of this cast');
    return n;
  }
  function resumeAirplayPrep() {
    let n = 0;
    if (hlsProc) { try { process.kill(hlsProc.pid, 'SIGCONT'); n++; } catch (e) {} }
    for (const p of subProcs) { try { process.kill(p.pid, 'SIGCONT'); n++; } catch (e) {} }
    if (n) clog('resumed ' + n + ' AirPlay preparation process(es)');
    return n;
  }

  // Only hold a completed preparation: an unannounced producer still has a
  // startup watchdog. Capture ownership so release cannot resume a newer source.
  function holdReadyAirplayPrep() {
    if (!hlsAnnounced || !hlsToken || !hlsProc) return null;
    const token = hlsToken, generation = hlsGeneration;
    const held = [];
    for (const child of [hlsProc, ...subProcs]) {
      try { process.kill(child.pid, 'SIGSTOP'); held.push(child); } catch (e) {}
    }
    if (!held.length) return null;
    clog('held ' + held.length + ' ready AirPlay preparation process(es) during receiver handoff');
    let released = false;
    return (resume = true) => {
      if (released) return;
      released = true;
      if (!resume || token !== hlsToken || generation !== hlsGeneration) return;
      let resumed = 0;
      for (const child of held) {
        if (child !== hlsProc && !subProcs.includes(child)) continue;
        if (child.exitCode != null || child.signalCode != null) continue;
        try { process.kill(child.pid, 'SIGCONT'); resumed++; } catch (e) {}
      }
      if (resumed) clog('resumed ' + resumed + ' held AirPlay preparation process(es) after receiver handoff');
    };
  }

  // The HLS remux runs faster than playback and keeps every segment (a receiver may seek back),
  // so the temp dir grows to ~the whole movie. Warn once if it gets large rather than silently
  // filling the disk (it's reclaimed on cancelHls/teardown when the cast ends).
  function startHlsWatch(dir) {
    if (hlsWatch) clearInterval(hlsWatch);
    // This used to walk the directory SYNCHRONOUSLY, statSync-ing every file, every 30s, on the
    // main process — while the HLS dir grows to roughly one segment per few seconds of movie. That
    // is blocking I/O proportional to segment count, repeated for the whole cast, and it stalls
    // everything else main is doing (IPC, cast control, torrent bookkeeping) each time it runs.
    // Async now, so the walk never blocks the event loop, with a guard against overlapping runs on
    // a slow disk. Same one-shot warning behaviour.
    const fsp = fs.promises;
    let scanning = false;
    const scan = async () => {
      if (scanning || hlsWarned) return;
      scanning = true;
      let bytes = 0;
      try {
        const walk = async (d) => {
          let ents = [];
          try { ents = await fsp.readdir(d, { withFileTypes: true }); } catch (e) { return; }
          for (const e of ents) {
            if (hlsWatch === null) return; // cast ended mid-walk — stop early
            const f = path.join(d, e.name);
            if (e.isDirectory()) await walk(f);
            // `bytes` is function-local and scan() is single-flight behind the `scanning` guard,
            // so nothing else can interleave with this accumulation.
            // eslint-disable-next-line require-atomic-updates
            else { try { bytes += (await fsp.stat(f)).size; } catch (x) {} }
          }
        };
        await walk(dir);
      } catch (e) {}
      // Check-and-set mutex: `scanning` is read and set synchronously at the top of scan(),
      // before any await, so scan() cannot be double-entered and this release cannot race.
      // eslint-disable-next-line require-atomic-updates
      scanning = false;
      if (!hlsWarned && bytes > 6 * 1024 * 1024 * 1024) {
        hlsWarned = true;
        onWarn('Casting is using a lot of temp disk space (' + Math.round(bytes / 1e9) + ' GB). It frees up when you stop casting.');
      }
    };
    hlsWatch = setInterval(scan, 30000);
  }

  // Extract each text subtitle track to a standalone WebVTT sidecar (no libass, no broken HLS
  // sub-muxing). Runs in the background. Also writes a single-segment subtitle MEDIA playlist
  // (sub_N.m3u8) wrapping the .vtt — that's what an HLS player (AVPlayer / the cast receiver) needs
  // to expose a selectable subtitle rendition (a raw .vtt URL is not an HLS subtitle track). The
  // playlist starts as an OPEN EVENT list pointing at an empty-but-valid stub and is finalized to
  // VOD (ENDLIST) once cues are extracted — at the SAME stable URI (no _v2 swap; see RC-1 below).
  // Returns entries used to build the master.
  function extractSubs(input, subs, lan, token, dur, dir) {
    // Every emitted WebVTT carries X-TIMESTAMP-MAP so cue 0 aligns to media PTS 0 (our fMP4 video
    // starts at 0). ffmpeg's webvtt muxer omits this and some players then render nothing — cheap,
    // spec-safe to always include. (Investigation RC-3.)
    const VTT_HEAD = 'WEBVTT\nX-TIMESTAMP-MAP=MPEGTS:0,LOCAL:00:00:00.000\n\n';
    const span = dur > 0 ? Math.ceil(dur) : 36000; // single segment spans the whole track
    // The subtitle's segment URI is STABLE (always sub_N.vtt). Previously the stub was published
    // under one URI and the finalized cues under a NEW URI (sub_N_v2.vtt) with the playlist rewritten
    // to point at it — but mutating an existing segment's URI in an EVENT playlist violates RFC8216
    // §6.2.1, so AVPlayer (having cached the empty stub) would never pick up the cues. Instead we
    // overwrite the SAME .vtt in place and finalize the playlist as VOD; /hls/ sends Cache-Control:
    // no-cache so the player refetches the now-populated URL. (Investigation RC-1.)
    // Mirror the variant's leading discontinuity, read from whichever media playlist ffmpeg wrote.
    // Both exist by now: succeed() requires a playlist and a segment before extractSubs is called.
    let discoHead = false;
    try {
      const cand = [path.join(dir, 'stream_0', 'index.m3u8'), path.join(dir, 'index.m3u8')];
      for (const c of cand) {
        if (safeStat(c)) { discoHead = opensWithDiscontinuity(fs.readFileSync(c, 'utf8')); break; }
      }
    } catch (e) {}
    const writePl = (pl, vttName, ended) => {
      try {
        fs.writeFileSync(path.join(dir, pl),
          `#EXTM3U\n#EXT-X-VERSION:6\n#EXT-X-TARGETDURATION:${span}\n#EXT-X-MEDIA-SEQUENCE:0\n` +
          `#EXT-X-PLAYLIST-TYPE:${ended ? 'VOD' : 'EVENT'}\n` +
          (discoHead ? '#EXT-X-DISCONTINUITY\n' : '') +
          `#EXTINF:${span}.0,\n${vttName}\n` +
          (ended ? '#EXT-X-ENDLIST\n' : ''));
      } catch (e) {}
    };
    // Write every rendition's stub + open playlist up front (so the master/menu is complete), but
    // run the EXTRACTORS with bounded concurrency: each ffmpeg reads the whole (often multi-GB)
    // source to EOF, so a file with 20–30 sub tracks would otherwise spawn 20–30 full-file readers
    // at once — a disk-I/O storm that competes with the live video transcode and can stall the cast.
    const tasks = (subs || []).map((s, i) => {
      const baseN = `sub_${i}_${cleanName(s.lang)}`; // unique per rendition (idx OR external file)
      const vtt = `${baseN}.vtt`;       // stable URI — empty-but-valid stub now, real cues on close
      const work = `${baseN}.work.vtt`; // ffmpeg writes here, then we merge into `vtt` with the header
      const pl = `${baseN}.m3u8`;
      try { fs.writeFileSync(path.join(dir, vtt), VTT_HEAD); } catch (e) {} // valid empty rendition
      writePl(pl, vtt, false); // open EVENT playlist pointing at the stable URI
      return { id: s.path ? 'external-subtitle-' + crypto.createHash('sha1').update(String(s.path)).digest('hex').slice(0, 12) : 'source-subtitle-' + s.idx, idx: s.idx, path: s.path, vtt, work, pl, lang: s.lang, name: s.name };
    });
    // EXTRACTION ON SELECTION. Nothing is extracted up front any more. Each ffmpeg reads the source
    // to EOF, and on a torrent that is hours: eight tracks were measured producing 52-byte stubs and
    // nothing else for the entire life of a cast, because they were all competing with the live
    // remux and each other for the same swarm. Breadth where depth was needed.
    //
    // HLS makes the selection observable for free: the receiver only fetches a subtitle rendition's
    // .vtt when the viewer actually turns that track on. So the GET *is* the choice — including a
    // choice made on the TV's own remote, which never reaches our IPC. serveHlsFile calls
    // startSubExtract() on the way past, one track gets a real extractor, and the rest stay the
    // instant stubs they already were.
    hlsSubTasks = new Map();
    for (const t of tasks) hlsSubTasks.set(t.vtt, t);
    let running = 0;
    const queue = [];
    const pump = () => {
      if (hlsToken !== token) return; // superseded → stop launching extractors
      while (running < 2 && queue.length) {
        const t = queue.shift(); running++;
        t.startedAt = Date.now();
        const diagnostics = require('./subtitle-extraction-diagnostics').createDiagnostics([input, t.path, dir]);
        // Embedded track (-map 0:s:idx of the source) OR an external .srt/.ass file (charset-sniffed
        // so legacy Windows-1252 subs don't cast as mojibake). Both end up as clean UTF-8 WebVTT.
        // A little before the play head, so a cue already on screen is not missed.
        const seekTo = Math.max(0, Math.floor((Number.isFinite(t.position) ? t.position : airplayPos) - 15));
        clog('subtitle extraction ' + t.vtt + ': sourceOrdinal=' + (t.path ? 'external' : t.idx) + ', requested=' + (t.position == null ? 'AirPlay' : t.position.toFixed(1)) + ', seek=' + seekTo + ', queue=' + (t.startedAt - t.queuedAt) + 'ms');
        const ffArgs = t.path
          ? ['-loglevel', 'error', '-y', '-sub_charenc', sniffCharenc(t.path), '-i', t.path, '-c:s', 'webvtt', '-flush_packets', '1', '-f', 'webvtt', path.join(dir, t.work)]
          // SEEK to the play head instead of reading up to it. Subtitle packets are sparse and
          // interleaved through the file: on a measured release the first English cue is at 15:24, so
          // a linear read has to pull ~15 minutes of 4K video — gigabytes — before it sees one cue.
          // Over a torrent that never completes, which is exactly what "produced nothing (deadline)"
          // was: 25s of reading, zero subtitle packets, an empty track, and no way to tell from the
          // outside that the extractor was working perfectly on the wrong part of the file.
          //
          // -ss makes ffmpeg range-request straight to that region, and the bytes around the play head
          // are the ones already on disk from sequential download. -copyts keeps cue times file-
          // absolute so they line up with the video, whose HLS timeline is also file time.
          : ['-loglevel', 'error', '-y',
            ...(seekTo > 0 ? ['-ss', String(seekTo), '-copyts'] : []),
            '-i', input, '-map', '0:s:' + t.idx, '-c:s', 'webvtt', '-flush_packets', '1', '-f', 'webvtt', path.join(dir, t.work)];
        const ff = spawn(FFMPEG, ffArgs);
        ff.stderr.on('data', chunk => diagnostics.capture(chunk));
        let firstOutputMs = null;
        const sample = setInterval(() => {
          if (firstOutputMs !== null) return;
          try {
            if (fs.statSync(path.join(dir, t.work)).size > 7) {
              firstOutputMs = Date.now() - t.startedAt;
              clog('subtitle extraction ' + t.vtt + ': first output after ' + firstOutputMs + 'ms');
            }
          } catch (e) {}
        }, 250);
        ff.on('error', error => { diagnostics.capture(error.message); t.status = 'failed'; clearInterval(sample); clearTimeout(budget); clearTimeout(grace); });
        // A DEADLINE, and partial cues on the way out. Collecting every cue means reading the source
        // to EOF because subtitle packets are interleaved throughout it; on a torrent that is hours,
        // and the viewer has already asked for the track. Observed exactly that: the extractor still
        // running with a 0-byte work file while the receiver showed nothing, because cues were only
        // ever published on a clean exit that was never going to come.
        //
        // SIGTERM, emphatically not SIGKILL — ffmpeg flushes its buffered output and writes the
        // trailer on the way out, and a killed run loses everything it had. The cast path learned
        // this the hard way ("every track came back size=0"); this is the same lesson, applied to the
        // AirPlay renditions that never got it.
        let timedOut = false, grace = null;
        const budget = setTimeout(() => {
          if (ff.exitCode === null && !ff.killed) {
            timedOut = true;
            clog('sub rendition ' + t.vtt + ': deadline reached, asking ffmpeg to publish what it has');
            try { ff.kill('SIGTERM'); } catch (x) {}
            grace = setTimeout(() => { try { ff.kill('SIGKILL'); } catch (x) {} }, SUB_GRACE_MS);
          }
        }, SUB_RENDITION_BUDGET_MS);
        ff.on('close', (code, signal) => {
          running--;
          clearInterval(sample); clearTimeout(budget); clearTimeout(grace);
          let bytes = 0; try { bytes = fs.statSync(path.join(dir, t.work)).size; } catch (e) {}
          const summary = diagnostics.summarize({ code, signal, bytes, timedOut });
          clog('subtitle extraction ' + t.vtt + ': exit=' + code + ', signal=' + (signal || 'none') + ', elapsed=' + (Date.now() - t.startedAt) + 'ms, firstOutput=' + (firstOutputMs == null ? 'none' : firstOutputMs) + ', bytes=' + bytes + ', reason=' + summary.category + (summary.stderr ? ', stderr=' + summary.stderr : ''));
          t.status = 'failed';
          if (hlsToken === token) {
            // A timed-out run exits non-zero but has still flushed real cues, so size — not the exit
            // code — is what says whether there is anything worth publishing.
            let ok = false; try { ok = fs.statSync(path.join(dir, t.work)).size > 12; } catch (e) {}
            if (!ok) clog('sub rendition ' + t.vtt + ' produced nothing' + (timedOut ? ' (deadline)' : ' (code=' + code + ')'));
            if (ok) {
              try {
                const raw = require('./vtt-window').trimToCompleteCues(fs.readFileSync(path.join(dir, t.work), 'utf8').replace(/^﻿/, ''));
                if (!raw) { clog('subtitle extraction ' + t.vtt + ': no complete cues to publish'); pump(); return; }
                const i = raw.indexOf('\n\n'); // strip ffmpeg's header block, keep cues
                const cues = i >= 0 ? raw.slice(i + 2) : raw.replace(/^WEBVTT[^\n]*\n?/, '');
                fs.writeFileSync(path.join(dir, t.vtt), VTT_HEAD + cues);
                try { fs.unlinkSync(path.join(dir, t.work)); } catch (e) {}
                writePl(t.pl, t.vtt, true); // same URI, now VOD + ENDLIST
                // How many cues, and WHEN. "published" alone is true of a file holding one cue at
                // 04:11 that the viewer will never reach — correctly populated and still invisible.
                t.status = cues.includes('-->') ? 'ready' : 'failed';
                const times = cues.match(/(\d{2}:)?\d{2}:\d{2}\.\d{3}(?= --> )/g) || [];
                clog('sub rendition ' + t.vtt + ' PUBLISHED: ' + times.length + ' cues' +
                  (times.length ? ', first ' + times[0] + ' last ' + times[times.length - 1] : ' — NOTHING WILL RENDER') +
                  (timedOut ? ' (deadline)' : ' (complete)'));
              } catch (e) {
                // NEVER silent. This catch swallowed the entire publish step, so a failed write and a
                // successful one were indistinguishable in the log.
                clog('sub rendition ' + t.vtt + ' FAILED TO PUBLISH: ' + (e && e.message ? e.message : String(e)));
              }
            }
          }
          pump(); // free slot → start the next extractor
        });
        subProcs.push(ff);
      }
    };
    startSubExtract = (vttName, position) => {
      if (hlsToken !== token) return;
      const t = hlsSubTasks.get(vttName);
      if (!t || t.started && t.status !== 'failed') return;
      t.position = Number.isFinite(position) ? position : null; t.status = 'pending'; t.queuedAt = Date.now();
      t.started = true;
      clog('sub rendition ' + vttName + ' was requested by the receiver — extracting it for real' +
        (running >= 2 ? ' (queued behind ' + running + ')' : ''));
      queue.push(t);
      pump();
    };
    return tasks.map((t) => ({ id: t.id, vtt: t.vtt, pl: t.pl, lang: t.lang, name: t.name, url: `http://${lan}:${port}/hls/${token}/${t.vtt}` }));
  }

  // Build/patch the master playlist so it carries the subtitle renditions, making them a
  // selectable Legible group in AVPlayer (AirPlay) and a TEXT track on the cast receiver.
  //   • multi-audio: ffmpeg already wrote master.m3u8 → inject EXT-X-MEDIA:SUBTITLES lines and
  //     tag every EXT-X-STREAM-INF with SUBTITLES="subs".
  //   • single-audio: ffmpeg only wrote the media playlist (index.m3u8) → wrap it in a fresh
  //     master that references it as the one variant plus the subtitle group.
  // Returns the master playlist filename to hand back to the caller.
  function buildMaster(dir, playlist, multi, subEntries) {
    // AUTOSELECT=NO (and DEFAULT=NO): AVPlayer must NOT auto-pick any subtitle rendition on load —
    // with many tracks (forced/SDH) it would otherwise auto-load one whose sidecar may still be a
    // slow stub and stall playback. The user explicitly selecting a track still works regardless.
    // NOTE: deliberately NO RESOLUTION/FRAME-RATE/VIDEO-RANGE attrs — adding them (A6) broke AirPlay (a
    // RESOLUTION that didn't match the scaled output, or VIDEO-RANGE=PQ without CODECS, made AVPlayer
    // reject the master). The proven master is just BANDWIDTH + SUBTITLES. (reverted A6)
    const media = subEntries.map((e) =>
      `#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="${(e.name || e.lang).replace(/"/g, '')}",` +
      `LANGUAGE="${e.lang}",AUTOSELECT=NO,DEFAULT=NO,URI="${e.pl}"`).join('\n');
    const masterPath = path.join(dir, 'master.m3u8');
    try {
      if (multi) return 'master.m3u8'; // ffmpeg's master is shaped when it is SERVED (servedMaster); patching the file here read it half-written
      fs.writeFileSync(masterPath,
        `#EXTM3U\n#EXT-X-VERSION:6\n${media}\n` +
        `#EXT-X-STREAM-INF:BANDWIDTH=4000000,SUBTITLES="subs"\n${playlist}\n`);
      return 'master.m3u8';
    } catch (e) { return playlist; } // patch failed → fall back to the plain playlist
  }

  // Probe audio + text-subtitle tracks (bounded read so a torrent's header is enough, no stall).
  // A probe that returns nothing sends the planner to a full re-encode, so it is worth trying again
  // rather than accepting it. Only failures pay for this; the common case is unchanged.
  function probeTracks(input, cb) {
    return memoProbe('tracks', input, (done) => {
      return probeWithRetries(
        (timeoutMs, next) => probeTracksRaw(input, timeoutMs, next),
        (info, attempts) => {
          if (!info) clog('probe gave up after ' + attempts + ' attempts — the plan will re-encode blind');
          else if (attempts > 1) clog('probe succeeded on attempt ' + attempts);
          done(info);
        },
        { onAttempt: (n, ms) => { if (n > 1) clog('probe retry ' + n + ' (timeout ' + ms + 'ms)'); } }
      );
    }, cb);
  }
  function probeTracksRaw(input, timeoutMs, cb) {
    cb = onceProbe(cb);
    let out = '';
    // 4M/5s: a standard MKV front-loads all track headers, so this still sees every audio/sub
    // stream + the video codec, but resolves in ~1–3s instead of stalling toward a 12s timeout
    // (which delayed the cast button). Inconclusive probe → vcodec null → serveHls proceeds anyway.
    const ps = spawn(FFPROBE, ['-v', 'error', '-probesize', '4M', '-analyzeduration', '4M',
      '-show_entries', PROBE_ENTRIES, '-of', 'json', input],
      { timeout: timeoutMs || 5000 });
    ps.stdout.on('data', (d) => { out += d; });
    ps.on('error', () => cb(null));
    ps.on('close', () => {
      try {
        const parsed = JSON.parse(out);
        const streams = parsed.streams || [];
        const dur = parseFloat(parsed.format && parsed.format.duration) || 0;
        const audio = [], subs = []; let aN = 0, sN = 0, vcodec = null, width = 0, height = 0, hdr = false, fps = 0, dovi = false, doviProfile = null, doviCompat = null;
        const langCount = {}; // disambiguate duplicate languages in the menu (eng, eng → "English 2")
        for (const s of streams) {
          const tg = s.tags || {}, lang = tg.language || 'und';
          if (s.codec_type === 'video' && !vcodec) {
            vcodec = s.codec_name || null; width = +s.width || 0; height = +s.height || 0;
            const fr = /^(\d+)\/(\d+)$/.exec(s.r_frame_rate || ''); // "24000/1001" → 23.976
            fps = fr && +fr[2] ? (+fr[1] / +fr[2]) : (parseFloat(s.r_frame_rate) || 0);
            hdr = /smpte2084|arib-std-b67/i.test(s.color_transfer || ''); // HDR10/HLG (DoVi base layer reports PQ too)
            // Dolby Vision. Detected two ways because releases differ: the sample-entry codec tag
            // (dvh1/dvhe mark a DV track in MP4) and a DOVI configuration record in the stream's
            // side data (what an MKV carries). Either is enough.
            //
            // This matters because DV is the one thing the DLNA route cannot simply hand over. That
            // route's whole value is sending the file untouched, but webOS's DLNA player is far
            // stricter than its app-side decoder — a set that plays DV from a streaming app will
            // still answer "this file cannot be recognized" over UPnP. Until now nothing detected
            // DV at all: `dovi` existed only as a receiver capability flag, hardcoded false, and was
            // never read from the media, so the file was offered to the TV and the TV refused it.
            const ctag = String(s.codec_tag_string || '').toLowerCase();
            const sdl = Array.isArray(s.side_data_list) ? s.side_data_list : [];
            const doviSd = sdl.find((x) => /dovi|dolby[ _]?vision/i.test(String((x && x.side_data_type) || '')));
            dovi = ctag === 'dvh1' || ctag === 'dvhe' || !!doviSd;
            // The PROFILE decides whether this is recoverable cheaply. Profile 8 is single-layer
            // with a base layer that is already valid HDR10, so dropping the DV metadata leaves a
            // stream any HDR10 receiver plays — no re-encode. Profile 5 has no such fallback (its
            // base layer is IPT-PQ-C2 and looks badly wrong decoded as HDR10), and profile 7 is
            // dual-layer, so both still need the encode. A file detected only by its MP4 codec tag
            // carries no profile here; left null, and null is treated as "not known to be safe".
            doviProfile = doviSd && Number.isFinite(+doviSd.dv_profile) ? +doviSd.dv_profile : null;
            // Profile 8's sub-variants differ in what the base layer actually is: compatibility id 1
            // is HDR10, 2 is SDR, 4 is HLG. Carried so the plan can describe the result honestly
            // rather than announcing HDR10 for all of them.
            doviCompat = doviSd && Number.isFinite(+doviSd.dv_bl_signal_compatibility_id) ? +doviSd.dv_bl_signal_compatibility_id : null;
          } else if (s.codec_type === 'audio') {
            langCount[lang] = (langCount[lang] || 0) + 1;
            const name = tg.title || (lang === 'und' ? 'Audio ' + (aN + 1) : lang.toUpperCase()) + (langCount[lang] > 1 ? ' ' + langCount[lang] : '');
            audio.push({ idx: aN, lang, name, codec: (s.codec_name || '').toLowerCase(), channels: +s.channels || 2 }); aN++;
          } else if (s.codec_type === 'subtitle') {
            const bitmap = /pgs|hdmv|dvd_sub|dvdsub|dvb_sub|xsub/i.test(s.codec_name || '');
            if (/subrip|srt|ass|ssa|mov_text|webvtt|text/i.test(s.codec_name || '')) subs.push({ idx: sN, lang, name: tg.title || (lang === 'und' ? 'Subtitle ' + (sN + 1) : lang.toUpperCase()), codec: s.codec_name, forced: !!(s.disposition && s.disposition.forced), default: !!(s.disposition && s.disposition.default), sdh: !!(s.disposition && s.disposition.hearing_impaired) });
            else if (bitmap) subs.push({ idx: sN, lang, name: tg.title || lang.toUpperCase(), bitmap: true }); // tracked but only renderable via DLNA/burn-in
            sN++; // count ALL subtitle streams so idx maps to 0:s:<idx> correctly
          }
        }
        cb({ audio, subs, vcodec, dur, width, height, hdr, dovi, doviProfile, doviCompat, fps });
      } catch (e) { cb(null); }
    });
    return () => { cb = () => {}; try { ps.kill('SIGKILL'); } catch (e) {} };
  }
  const cleanName = (s) => String(s).replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 24) || 'Track';

  // Live HLS remux/transcode. AVPlayer plays HLS natively, so this casts MKV/AVI/TS releases AND
  // streams as a torrent downloads. Builds a MULTI-rendition master (all audio languages + text subs
  // as selectable renditions) when probing succeeds, else a simple single-audio playlist.
  //
  // opts = { caps, extraSubs }:
  //   • caps — receiver capability profile (any loose shape; device-profile.normalise() via
  //     planPlayback() fills the gaps conservatively). A capability-confirmed TV (LG NANO80T6A /
  //     webOS-24 / Cast-built-in) COPIES 4K HEVC + HDR10 and passes AC3/EAC3 through losslessly;
  //     an unknown receiver downscales to 1080p + AAC. (Capability-negotiated; see cast.js.)
  //   • extraSubs — [{path,lang,name}] external .srt/.ass files to convert + attach as renditions.
  // cb(masterOrIndex m3u8 LAN url, subTracks).
  function serveHls(input, cb, opts) {
    const lan = lanAddress();
    if (!lan || !input) return cb(null);
    cancelHls(); cancelRemux();
    const generation = hlsGeneration;
    const complete = cb;
    let finished = false, cancelled = false, cancelTracks = null;
    const cancel = () => {
      if (finished) return;
      cancelled = true;
      cb(null);
      if (typeof cancelTracks === 'function') { try { cancelTracks(); } catch (e) {} }
      cancelTracks = null;
      if (generation === hlsGeneration) cancelHls();
    };
    cb = (url, subs, metadata) => {
      if (finished) return;
      finished = true;
      if (hlsPreparation === cancel) hlsPreparation = null;
      try { complete(url, subs, metadata); } catch (e) {}
    };
    hlsPreparation = cancel;
    // Every entry, with its caller. This is the line that turns "three sessions appeared" into
    // "these three call sites asked for them" — the open question behind the AirPlay -16839/-12312.
    clog('serveHls: REQUESTED for ' + String(input).slice(0, 90) + ' — by ' + whoCalled() +
      (hlsToken ? ' (this will destroy live session ' + String(hlsToken).slice(0, 8) + ')' : ''));
    const capsRaw = (opts && opts.caps) || null;
    // Optional proven profile to retreat to when `caps` is ambitious and the source doesn't earn it.
    // Absent for every caller but the AirPlay local-file path, and absent means "behave as before".
    const capsFallback = (opts && opts.capsFallback) || null;
    const extraSubs = (opts && Array.isArray(opts.extraSubs)) ? opts.extraSubs : [];
    ensure(() => {
      if (cancelled || generation !== hlsGeneration) return cb(null);
      const myToken = hlsToken = newToken();
      hlsStartedAt = Date.now(); hlsAnnounced = false; // diagnostics: session age + whether an item is bound
      hlsDir = path.join(hlsRoot, hlsToken);
      try { fs.mkdirSync(hlsDir, { recursive: true }); } catch (e) {}
      cancelTracks = probeTracks(input, (info) => {
        // Bail if a newer serveHls superseded us while probing. Comparing the captured token (not
        // `== null`) is essential — a second call sets a NEW non-null token, and proceeding here
        // would spawn orphan ffmpegs into the new session's dir.
        if (cancelled || hlsToken !== myToken) return cb(null);
        const probeFinishedMs = Date.now() - hlsStartedAt;
        let sourceAudio = null;
        if (opts && opts.sourceSelectedAudio) {
          try { sourceAudio = require('./receiver-audio-plan').selectSourceAudio(info, opts.audioTrack, opts.audioHint); }
          catch (e) { clog('serveHls: ' + e.message); return cb(null); }
          info = sourceAudio.info;
        }
        let producerInput = input;
        if (sourceAudio && typeof registerSourceProducer === 'function' &&
            /^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?\/webtorrent\//i.test(input)) {
          hlsProducer = createOwnedSource(input);
          if (!hlsProducer) { cancel(); return; }
          producerInput = hlsProducer.url;
        }
        // Subtitles → WebVTT sidecars (embedded text tracks + external files), wrapped in subtitle
        // media playlists and attached to the master as a SUBTITLES rendition group (buildMaster) so
        // AVPlayer (AirPlay) exposes a Legible group and the cast receiver a TEXT track — both
        // selectable mid-cast. Bitmap subs (PGS/VOBSUB) can't become WebVTT and the bundled ffmpeg
        // has no libass → they're skipped here (use the DLNA route, where the TV renders them).
        const embeddedTextSubs = (info && info.subs ? info.subs.filter((s) => !s.bitmap) : []);
        const everySubSource = embeddedTextSubs.map((s) => ({ ...s }))
          .concat(extraSubs.map((s, i) => ({ path: s.path, lang: s.lang || 'und', name: s.name || ('Subtitle ' + (embeddedTextSubs.length + i + 1)) })));
        // AVPlayer will not start until it has fetched EVERY subtitle rendition named in the master,
        // so the rendition count sits on the critical path to the first frame. Measured on a release
        // with 18 text tracks: the load failed with CoreMedia -16839, "Unable to get playlist before
        // long download timer", while the same master loaded fine once the session had settled. It is
        // the same eager-fetch behaviour that already forced MAX_REMOTE_SIDELOAD_SUBS on the cast
        // path, so a STREAMED source is capped identically here. A local file is a disk read and
        // keeps every track.
        // Every text track, streamed or not. The one-per-language cap existed because each rendition
        // cost a full-file ffmpeg read up front; extraction-on-selection means an unselected rendition
        // costs a 52-byte stub and nothing else, so there is no longer a reason to choose FOR the
        // viewer — and choosing badly is exactly what the cap did. Measured on a real release: three
        // English tracks, and "first occurrence wins" picked the 103-cue SIGNS track while the two
        // real dialogue tracks (903 and 1257 cues) never reached the menu. No metadata separates them
        // — forced=0 on all three, no titles, and default=1 is set on the signs track — so the only
        // honest answer is to list them all and let the remote decide.
        let allSubSources;
        try { allSubSources = opts && opts.receiverSubtitles === true
          ? require('./receiver-subtitle-catalog').buildReceiverSubtitleCatalog(everySubSource)
          : capSubSources(everySubSource); }
        catch (error) { clog('receiver subtitle catalog: ' + error.message); return cb(null); }
        if (allSubSources.length < everySubSource.length) {
          clog('AirPlay HLS: offering ' + allSubSources.length + ' of ' + everySubSource.length + ' subtitle renditions (' +
            (everySubSource.length - allSubSources.length) + ' dropped: duplicate languages or past the cap for a streamed source)');
        }
        // Subtitle sidecars are extracted only once a video launch SUCCEEDS (see succeed()), not up
        // front — so a hw→sw fallback that wipes+recreates the dir can't orphan extractor ffmpegs or
        // leave the master pointing at deleted stubs. (Audit H1/M8.)
        let subEntries = [], subTracks = [];

        // ---- video copy-vs-transcode decision (capability-negotiated) ----
        // Decided by playback-planner.js. The rules it applies are the ones that used to be written
        // out here — can this receiver decode HEVC / 4K, is the source HDR and can the receiver show
        // HDR10, is VP9/AV1/Xvid/VC-1/WMV muxable into fMP4 (never: use DLNA for native passthrough).
        //
        // TWO plans, because this site has two questions. `plan` is what happens on the PRIMARY
        // attempt. `encPlan` is the same decision with the copy taken off the table, which is what
        // the videotoolbox/software encoder branches need: the sw fallback re-encodes a source the
        // primary was copying, so its HDR/scale answers must be the ENCODE's, not the copy's.
        //
        // capsFallback (AirPlay only, local files only) means the caller offered an AMBITIOUS profile
        // and a proven one to retreat to. Try the ambitious plan, keep it only if it buys a real 4K
        // copy, and otherwise recompute with the fallback so the shipped behaviour is reproduced
        // exactly rather than approximated. Every cast path passes no capsFallback and skips all of it.
        let plan = planPlayback(info || {}, capsRaw, { canTonemap: CAN_TONEMAP });
        let capsUse = capsRaw;
        let took4k = false;
        if (capsFallback) {
          const d = decide4k(plan, info && info.height);
          clog('AirPlay 4K profile: ' + (d.take ? 'ACCEPTED — ' : 'declined, ') + d.why);
          if (d.take) took4k = true;
          else { capsUse = capsFallback; plan = planPlayback(info || {}, capsUse, { canTonemap: CAN_TONEMAP }); }
        }
        let encPlan = planPlayback(info || {}, capsUse, { canTonemap: CAN_TONEMAP, forceTranscode: true });
        // The ambitious profile is only ever a COPY (decide4k refuses anything else), so its ENCODE
        // plan describes a re-encode nobody sanctioned: 3840x1920 10-bit HEVC. The software retry uses
        // exactly that, and libx265 at 4K cannot hold realtime — it emits no first segment, the launch
        // ladder ends at cb(null), and the source becomes uncastable. That turns "plays at 1080p" into
        // "no AirPlay button at all", which is strictly worse than the problem 4K was meant to solve.
        // So retreating from a failed 4K copy means retreating to the PROVEN PROFILE, not to a 4K encode.
        const retreatFrom4k = () => {
          if (!took4k || !capsFallback) return false;
          took4k = false;
          capsUse = capsFallback;
          plan = planPlayback(info || {}, capsUse, { canTonemap: CAN_TONEMAP });
          encPlan = planPlayback(info || {}, capsUse, { canTonemap: CAN_TONEMAP, forceTranscode: true });
          clog('AirPlay 4K copy did not produce a segment in time — retreating to the proven 1080p profile');
          return true;
        };

        // A 4K HEVC copy CANNOT be delivered behind a master playlist. Measured against a live
        // session: the variant playlist on its own loads READY in AVFoundation, while a master --
        // any master, right down to a bare `#EXT-X-STREAM-INF:BANDWIDTH=n` pointing at that same
        // variant URL -- is refused with -12927. Stripping RESOLUTION/CODECS/VIDEO-RANGE, correcting
        // the hvc1 codec string, and removing the audio and subtitle groups made no difference; only
        // the ABSENCE of the master does. It is the shape this project already recorded as the one
        // that works: "one audio track and no text subs produces no master playlist at all".
        //
        // A master is unavoidable once there are multiple audio renditions or sideloaded subtitles, so
        // taking 4K means giving both up: one muxed audio track, no subtitle renditions, bare media
        // playlist. That is why the ambitious profile stays opt-in — it buys native 2160p HDR10 at a
        // fraction of the CPU, and it costs the track menus. The default path is untouched.
        // NOTE the finding this was built on is now suspect. "A master playlist is always refused for
        // a 4K HEVC copy (-12927)" was measured while EVERY playlist still carried the spurious
        // leading #EXT-X-DISCONTINUITY that append_list emitted — the same defect that produced -12312
        // everywhere else. With that gone the master may well be fine, and a master is what carries
        // the audio and subtitle renditions the TV remote switches between. So 4K now keeps its
        // renditions by default; SPRITZ_AIRPLAY_BARE=1 restores the stripped-down playlist if the
        // receiver really does refuse the master.
        // CONFIRMED by A/B on hardware, after the append_list discontinuity bug was fixed and could no
        // longer be the explanation: a 4K HEVC copy behind a master playlist is refused at load
        // (status=failed, EMPTY error log — nothing fetched), while the SAME copy served as a bare
        // media playlist loads and plays. Eight renditions or forty makes no difference; the master
        // itself is what it will not take.
        //
        // A master is what carries the audio and subtitle renditions the TV remote switches between,
        // so 4K and the track menus are mutually exclusive on this receiver. That is a real tradeoff,
        // not a bug to fix: SPRITZ_AIRPLAY_4K=1 buys native 2160p HDR10 at a fraction of the CPU and
        // costs the menus; the default 1080p path keeps them. SPRITZ_AIRPLAY_MASTER4K=1 forces a
        // master anyway, for re-testing this against a future receiver or firmware.
        const bare4k = took4k && process.env.SPRITZ_AIRPLAY_MASTER4K !== '1';
        if (bare4k && (info && info.audio.length > 1 || allSubSources.length)) {
          clog('AirPlay 4K: serving a bare media playlist — one audio track, no subtitle renditions ' +
            '(a master playlist is refused for a 4K HEVC copy; the variant alone plays)');
        }
        const multi = !bare4k && !!(info && info.audio.length > 1);
        // Container detail, not a decision: HEVC copied into fMP4 must carry the hvc1 tag.
        const isHevc = !!(info && info.vcodec === 'hevc');
        // info==null (inconclusive probe, e.g. a just-started torrent): assume copy; the software
        // fallback below rescues us if the real codec turns out to be uncopyable (VP9/AV1). That is
        // exactly plan.speculative, and it is why the speculative plan is not allowed to ask for a
        // transcode here — the shipped code started an unprobed source in copy mode unconditionally.
        const transcode = !plan.speculative && plan.video === 'transcode';

        const inOpts = /^https?:\/\//i.test(input)
          ? ['-reconnect', '1', '-reconnect_at_eof', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5', '-rw_timeout', String(HTTP_READ_TIMEOUT_US)]
          : [];
        const finalizeReceiver = !!(sourceAudio && opts && opts.receiverSubtitles === true);
        const inputStart = sourceAudio && opts ? require('./receiver-audio-plan').nearInputStart(opts.receiverInputStartSec, info && info.dur, transcode) : 0;
        if (inputStart > 0) inOpts.push('-ss', String(inputStart), '-copyts');
        if (finalizeReceiver) inOpts.unshift('-xerror');
        const hlsOpts = [...(inputStart > 0 ? ['-avoid_negative_ts', 'disabled'] : []), '-hls_segment_type', 'fmp4', '-hls_time', '2', '-hls_list_size', '0',
          // NO append_list. Measured against the bundled ffmpeg: on a COMPLETELY FRESH directory,
          // append_list emits a leading #EXT-X-DISCONTINUITY before segment 0, where omit_endlist
          // alone emits none. That tag sets segment 0's discontinuity sequence to 1, and AVFoundation
          // rejects the stream with -12312 "Media Entry discontinuity value does not match previous
          // playlist for MEDIA-SEQUENCE 0" — the single most persistent AirPlay failure here, seen on
          // subtitle renditions, on variant playlists, and finally on a bare single media playlist
          // with no master and no subtitles at all, which is what ruled everything else out.
          // append_list exists to continue an EXISTING playlist, and nothing here ever does: the
          // software fallback WIPES the directory before relaunching, so there is never anything to
          // append to — only the spurious discontinuity it brings with it.
          '-hls_playlist_type', 'event', '-hls_flags', 'omit_endlist', '-hls_fmp4_init_filename', 'init.mp4'];

        // Per-audio-stream codec: COPY a passthrough-capable codec (AAC/AC3/EAC3 → surround intact),
        // else encode to AAC PRESERVING the channel layout (no forced -ac 2 stereo downmix). bitrate
        // scales with channel count so 5.1/7.1 isn't starved.
        function audioArgs() {
          if (!plan.audioTracks.length) return ['-c:a', 'aac'];
          const out = [];
          plan.audioTracks.forEach((a, i) => {
            if (a.action === 'copy') out.push(`-c:a:${i}`, 'copy');
            else out.push(`-c:a:${i}`, 'aac', `-b:a:${i}`, a.bitrate);
          });
          return out;
        }

        // Build the video args for a given encoder MODE: 'copy' (primary, when allowed), 'hw'
        // (videotoolbox transcode), or 'sw' (libx264/libx265 — the fallback that always works,
        // and the path that can decode VP9/AV1/Xvid the hardware-copy can't).
        function videoArgs(mode) {
          // HDR10 output is HEVC, so keep it ONLY if the receiver displays HDR10 AND decodes HEVC.
          // A receiver that does HDR10 but is H.264-only (a plain Cast dongle: hdr10=true, hevc=false)
          // must get H.264 — otherwise it gets an undecodable HEVC stream with no fallback. (Audit H5.)
          // That rule is now encPlan.hdr; the ENCODE plan, because this is an encoder constraint —
          // an H.264 HDR source COPIED to that same dongle passes through untouched and is fine.
          const hdr = encPlan.hdr === 'preserve';
          // Downscale only ABOVE the receiver's max height, and scale TO that height — a 4K-capable
          // receiver (maxHeight 2160) keeps 4K instead of being forced to 1080p. (Audit M9.)
          // encPlan.targetHeight is that height when scaling and the source height when not.
          const cap = encPlan.targetHeight || 0;
          // Bound WIDTH as well as height. `scale=-2:1080` only constrains height, so anything wider
          // than 16:9 keeps its full width: a 3840x1920 (2:1) release came out 2160x1080 — a
          // non-standard width, 240px wider than the 1920 panel the LG reports, and wide enough to
          // push H.264 from Level 4.0 to 5.0. Measured on that exact file: the TV took the stream,
          // then refused it with -11870 the instant the route engaged, with an EMPTY
          // AVPlayerItemErrorLog — every byte delivered, nothing decodable.
          //
          // Fitting inside a capW x cap box instead yields 1920x960 at Level 4.0. Verified against the
          // bundled ffmpeg across shapes: 16:9 (4K, 1080p, 720p) and PORTRAIT sources are byte-for-byte
          // unchanged, because they were never the ones exceeding the width. Only wider-than-16:9
          // content moves, which is exactly the broken set.
          // From the RECEIVER's ceiling, never from encPlan.targetHeight. targetHeight is the SOURCE
          // height whenever no downscale is needed, so deriving the width bound from it made the box
          // shrink with the content: a 1920x800 scope release (the commonest 1080p shape) got a capW
          // of 1422 and was re-encoded to 1422x592 — 45% of its pixels thrown away for no reason.
          // The receiver's limit does not move with the source, which is the whole point of a cap.
          const capH = (capsUse && capsUse.maxHeight) || 1080;
          const capW = Math.round((capH * 16 / 9) / 2) * 2;   // 1080 -> 1920, 2160 -> 3840
          // ...and scale when EITHER bound is exceeded. Height alone missed 2560x1080 ultrawide, which
          // is already at the height cap yet 640px too wide, so it was passed through untouched.
          const needScale = !!(info && info.height && cap &&
            (cap < info.height || (info.width && capW && info.width > capW)));
          // force_original_aspect_ratio=decrease fits inside the box without distorting;
          // force_divisible_by=2 keeps both dimensions even for yuv420p.
          const scaleExpr = 'scale=w=' + capW + ':h=' + cap + ':force_original_aspect_ratio=decrease:force_divisible_by=2';
          const scale = needScale ? ['-vf', scaleExpr] : [];
          if (mode === 'copy') return ['-c:v', 'copy', ...(isHevc ? ['-tag:v', 'hvc1'] : []), ...(plan.stripDovi ? DOVI_STRIP : [])];
          if (hdr) { // HDR10 (HEVC) — hardware or software
            const enc = mode === 'sw' ? ['-c:v', 'libx265', '-preset', 'fast', '-crf', '20'] : ['-c:v', 'hevc_videotoolbox', '-prio_speed', '1', '-b:v', '10M', '-maxrate', '14M', '-bufsize', '20M'];
            return [...scale, ...enc, '-tag:v', 'hvc1', '-pix_fmt', 'p010le',
              '-color_primaries', 'bt2020', '-color_trc', 'smpte2084', '-colorspace', 'bt2020nc', '-color_range', 'tv'];
          }
          // SDR output (incl. HDR→SDR when the receiver can't take HDR10 OR can't decode HEVC). Proper
          // tonemap needs zscale; without it (shipped build) fall back to a plain scale — slightly
          // washed-out but watchable and, crucially, DECODABLE H.264.
          const needTonemap = encPlan.tonemap;
          const vf = needTonemap && CAN_TONEMAP
            ? ['-vf', (needScale ? scaleExpr + ',' : '') + 'zscale=t=linear:npl=100,format=gbrpf32le,tonemap=tonemap=hable:desat=0,zscale=p=bt709:t=bt709:m=bt709:r=tv,format=yuv420p']
            : scale;
          // AirPlay 1080p H.264 bitrate (AP1): bumped 8M/12M → 16M/24M. The receiver is capped at H.264/SDR
          // 1080p (4K/HDR over AirPlay-2 to this LG doesn't play), so resolution can't improve — bitrate is
          // the only quality lever, and 8 Mbit/s was visibly soft on a large panel. Quantizer-only change
          // (same codec/profile/container/handoff) so it can't trigger the "enters AirPlay, never plays".
          const enc = mode === 'sw' ? ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20'] : ['-c:v', 'h264_videotoolbox', '-prio_speed', '1', '-b:v', '16M', '-maxrate', '24M', '-bufsize', '32M'];
          return [...vf, ...enc, '-pix_fmt', 'yuv420p', '-profile:v', 'high'];
        }

        function buildArgs(mode) {
          const vArgs = videoArgs(mode), aArgs = audioArgs();
          if (multi) {
            const args = ['-loglevel', 'error', '-y', ...inOpts, '-i', producerInput, '-map', '0:v:0'];
            info.audio.forEach((a) => args.push('-map', '0:a:' + a.idx));
            args.push(...vArgs, ...aArgs, ...hlsOpts);
            const vm = ['v:0,agroup:aud'];
            info.audio.forEach((a, i) => vm.push(`a:${i},agroup:aud,language:${a.lang}` + (i === 0 ? ',default:yes' : '')));
            args.push('-var_stream_map', vm.join(' '), '-f', 'hls', '-master_pl_name', 'master.m3u8',
              '-hls_segment_filename', path.join(hlsDir, 'stream_%v/seg%05d.m4s'), path.join(hlsDir, 'stream_%v/index.m3u8'));
            return args;
          }
          // single audio. EXPLICIT maps so ffmpeg doesn't also segment a subtitle stream as junk
          // per-segment WebVTT (we carry subs via sidecar renditions). NO -ac 2 → channel layout survives.
          return ['-loglevel', 'error', '-y', ...inOpts, '-i', producerInput, '-map', '0:v:0', '-map', '0:a:' + (sourceAudio ? sourceAudio.index : 0),
            ...vArgs, ...aArgs, ...hlsOpts, '-f', 'hls',
            '-hls_segment_filename', path.join(hlsDir, 'seg%05d.m4s'), path.join(hlsDir, 'index.m3u8')];
        }

        const playlist = multi ? 'master.m3u8' : 'index.m3u8';
        const myDir = hlsDir, tok = myToken, m3u8 = path.join(myDir, playlist);
        const primaryMode = transcode ? 'hw' : 'copy';
        let settled = false, triedFallback = false;
        let timelineOrigin = inputStart > 0 ? null : 0, originPending = false, producerExit = null;
        const finalizePlaylist = () => {
          if (!finalizeReceiver || !producerExit || timelineOrigin === null || hlsToken !== tok) return;
          try {
            const complete = require('./receiver-hls-finalize').completedPlaylist(fs.readFileSync(m3u8, 'utf8'), info.dur - timelineOrigin, producerExit.code, producerExit.signal);
            if (complete) { fs.writeFileSync(m3u8 + '.complete', complete); fs.renameSync(m3u8 + '.complete', m3u8); }
          } catch (e) { clog('receiver HLS finalization skipped: ' + e.message); }
        };
        startHlsWatch(myDir);

        const ready = () => {
          if (!(countSegs(myDir) > 0 && safeStat(m3u8))) return false;
          if (timelineOrigin === null) {
            if (!originPending) {
              originPending = true;
              cancelTracks = probeFirstPts('concat:' + path.join(myDir, 'init.mp4') + '|' + path.join(myDir, 'seg00000.m4s'), pts => {
                if (cancelled || finished || hlsToken !== tok) return;
                if (!Number.isFinite(pts) || pts < 0 || pts > inputStart + 2) { cancel(); return; }
                timelineOrigin = pts; finalizePlaylist();
              });
            }
            return false;
          }
          finalizePlaylist();
          if (!opts || typeof opts.receiverStartSec !== 'function') return true;
          try { return require('./hls-start-position').coversPosition(fs.readFileSync(m3u8, 'utf8'), opts.receiverStartSec() - timelineOrigin); }
          catch (e) { return false; }
        };

        // Spawn ffmpeg for a mode and watch for readiness. On a failure BEFORE the stream is ready
        // (videotoolbox session error, or an uncopyable codec the primary tried to copy), retry ONCE
        // with the software transcoder — which both fixes hardware hiccups AND decodes VP9/AV1/Xvid.
        // Every failure/wedge path routes through fail() so the caller ALWAYS gets a cb (never hangs).
        function launch(mode) {
          const ff = hlsProc = spawn(FFMPEG, buildArgs(mode));
          if (typeof hlsProducer !== 'undefined' && hlsProducer) hlsProducer.setActive(true);
          const producerStartedMs = Date.now() - hlsStartedAt;
          let firstSegmentMs = null;
          const preparationDiagnostics = require('./subtitle-extraction-diagnostics').createDiagnostics([input, myDir]);
          let lastSegs = 0, lastProgressAt = Date.now(), waitingLogged = false;
          const succeed = () => {
            settled = true; clearInterval(tick);
            // Dir is now stable (no further fallback wipes) → safe to spawn the subtitle extractors. (H1/M8)
            if (allSubSources.length && (!bare4k || opts && opts.sideloadSubs)) {
              if (opts && opts.receiverSubtitles === true) {
                receiverSubtitles = require('./receiver-subtitles').createReceiverSubtitles({ input, tracks: allSubSources,
                  ...(typeof hlsProducer !== 'undefined' && hlsProducer ? { acquireInput: () => createOwnedSource(input) } : {}),
                  dir: myDir, baseUrl: `http://${lan}:${port}/hls/${tok}/`, ffmpeg: FFMPEG,
                  duration: (info && info.dur) || 0, sniffCharenc, log: clog });
                subEntries = receiverSubtitles.entries;
              } else subEntries = extractSubs(input, allSubSources, lan, tok, (info && info.dur) || 0, myDir);
              subTracks = subEntries.map((e) => ({ id: e.id, url: e.url, lang: e.lang, name: e.name, ...(e.prepare ? { prepare: true, forced: e.forced, sdh: e.sdh, default: e.default, format: e.format } : {}) }));
            }
            // Wrap a master only when there are subtitle renditions to carry (single-audio no-subs serves the
            // bare media playlist, like the proven build). (reverted A6 always-wrap.)
            const finalPl = subEntries.length && !(opts && opts.sideloadSubs) ? buildMaster(myDir, playlist, multi, subEntries) : playlist;
            // Multi-audio: AVFoundation refuses ffmpeg's own master (it describes the picture) and ffmpeg
            // rewrites that file after the first segments, so the shape is applied each time it is served.
            hlsMasterShape = multi && !(opts && opts.sideloadSubs) ? { token: tok, subEntries } : null;
            hlsAnnounced = true;
            if (sourceAudio) clog('receiver HLS preparation ' + JSON.stringify({
              probeMs: probeFinishedMs, producerStartedMs, firstSegmentMs,
              readyMs: Date.now() - hlsStartedAt, audioIndex: sourceAudio.index,
              requestedSec: opts && typeof opts.receiverStartSec === 'function' ? opts.receiverStartSec() : null,
              mode
            }));
            clog('serveHls: session ' + String(tok).slice(0, 8) + ' ANNOUNCED after ' +
              (Date.now() - hlsStartedAt) + 'ms as ' + finalPl + ' (' + subEntries.length + ' sub renditions)');
            cb(`http://${lan}:${port}/hls/${tok}/${finalPl}`, subTracks, sourceAudio ? { audio: sourceAudio.catalog, selectedAudio: sourceAudio.index, ...(info && Number.isFinite(info.dur) && info.dur > 0 ? { timelineOrigin, sourceDuration: info.dur } : {}) } : undefined);
          };
          const fail = (reason, code, signal) => {
            if (settled || hlsToken !== tok) return;
            if (sourceAudio) clog('receiver HLS preparation failed ' + JSON.stringify({
              reason, mode, audioIndex: sourceAudio.index, inputStart,
              elapsedMs: Date.now() - hlsStartedAt, firstSegmentMs, segments: lastSegs,
              idleMs: Date.now() - lastProgressAt,
              ...preparationDiagnostics.summarize({ timedOut: reason === 'no-segment-progress', bytes: 0, code, signal })
            }));
            clearInterval(tick);
            if (inputStart > 0) {
              const failure = preparationDiagnostics.summarize({ code, signal, bytes: 0 });
              if (failure.category === 'timestamp-or-mux-error') {
                // Dispose this candidate before the caller starts the origin retry. The
                // receiver's previous producer belongs to a different transport instance.
                settled = true;
                if (hlsPreparation === cancel) hlsPreparation = null;
                cancelHls();
                cb(null, [], { retryFromOrigin: true });
              } else cancel();
              return;
            } // retain prior stream; no unmapped encoder fallback
            // A 4K copy that wedged must go back to the proven profile, NOT to a 4K software encode.
            // This retry re-plans first, so the relaunch is the ordinary 1080p H.264 path.
            if (retreatFrom4k()) {
              try { if (ff === hlsProc && hlsProc) hlsProc.kill('SIGKILL'); } catch (e) {}
              try { fs.rmSync(myDir, { recursive: true, force: true }); fs.mkdirSync(myDir, { recursive: true }); } catch (e) {}
              launch('hw');
              return;
            }
            if (!triedFallback && mode !== 'sw') { // retry once via the always-works software encoder
              triedFallback = true;
              try { if (ff === hlsProc && hlsProc) hlsProc.kill('SIGKILL'); } catch (e) {}
              try { fs.rmSync(myDir, { recursive: true, force: true }); fs.mkdirSync(myDir, { recursive: true }); } catch (e) {}
              launch('sw');
            } else { settled = true; cancelHls(); cb(null); }
          };
          const tick = setInterval(() => {
            if (settled) { clearInterval(tick); return; }
            if (hlsToken !== tok) { clearInterval(tick); return; } // superseded → caller already got cb(null)
            let segs = 0; try { segs = countSegs(myDir); } catch (e) {}
            if (segs > 0 && firstSegmentMs === null) firstSegmentMs = Date.now() - hlsStartedAt;
            if (segs > lastSegs) { lastSegs = segs; lastProgressAt = Date.now(); }
            if (ready()) succeed();
            else if (Date.now() - lastProgressAt > 25000) {
              const diagnostics = preparationDiagnostics.summarize({ bytes: 0 });
              let sourceWaiting = false;
              try { sourceWaiting = !!(sourceAudio && opts && typeof opts.receiverSourceWaiting === 'function' && opts.receiverSourceWaiting()); } catch (e) {}
              const action = require('./receiver-preparation-policy').stallAction({ sourceWaiting,
                category: diagnostics.category, elapsedMs: Date.now() - hlsStartedAt });
              if (action === 'wait') {
                if (!waitingLogged) { waitingLogged = true; clog('receiver HLS waiting for torrent data; retaining preparation within startup deadline'); }
              } else if (action === 'expire') {
                settled = true; cancelHls(); cb(null, [], { sourceWaiting: true });
              } else fail('no-segment-progress');
            }
          }, 250);
          ff.stderr.on('data', chunk => {
            if (ff !== hlsProc || settled || hlsToken !== tok) return;
            preparationDiagnostics.capture(chunk);
            // A failed mux thread can leave FFmpeg's input thread alive. Do not
            // wait for the progress watchdog when this candidate is already fatal.
            if (inputStart > 0 && preparationDiagnostics.hasTerminalMuxFailure()) fail('mux-error');
          });
          // A SUPERSEDED process (e.g. the hw ffmpeg SIGKILLed when launching the sw fallback) must NOT
          // re-enter fail()/cancelHls() — that would tear down the brand-new process. Gate on the event
          // belonging to the CURRENT hlsProc. Without this, the fallback kills itself. (Audit H1.)
          ff.on('error', error => { if (ff !== hlsProc) return; preparationDiagnostics.capture(error.message); hlsProc = null;
            if (typeof hlsProducer !== 'undefined' && hlsProducer) hlsProducer.setActive(false);
            if (!settled) fail('spawn-error'); });
          ff.on('close', (code, signal) => {
            if (ff !== hlsProc) return; // superseded process → its lifecycle is no longer ours
            hlsProc = null;
            if (typeof hlsProducer !== 'undefined' && hlsProducer) hlsProducer.setActive(false);
            producerExit = { code, signal }; finalizePlaylist();
            // A copy finishes in about a second, long before a TV asks. Record it so every media playlist is served
            // finished (ENDLIST + VOD): an LG AirPlay receiver treated an open EVENT playlist as live and refused it.
            if (hlsToken === tok && info && Number.isFinite(info.dur) && Number.isFinite(timelineOrigin)) {
              hlsFinish = { token: tok, duration: info.dur - timelineOrigin, code, signal };
            }
            if (settled || hlsToken !== tok) return;
            // ffmpeg exited before we observed readiness. If it actually finished writing (a short
            // clip), the segments exist → let the next tick settle it; otherwise it failed → fail().
            try { if (ready() || originPending && timelineOrigin === null) return; } catch (e) {}
            fail('producer-exit', code, signal);
          });
        }
        launch(primaryMode);
      });
      if (cancelled && typeof cancelTracks === 'function') { try { cancelTracks(); } catch (e) {} cancelTracks = null; }
    });
    return cancel;
  }

  // ---- Chromecast transport: ONE progressive Matroska stream over a single HTTP GET ----
  // This is the proven-reliable progressive Cast path (vs the fragile live-EVENT-fMP4-HLS that
  // Spritz fed the receiver before). The LG webOS receiver demuxes raw MKV natively (the same reason
  // DLNA-4K works), and a single continuous stream has no playlist/segment/ENDLIST state machine to
  // fail. One video (-c:v copy for castable H.264/HEVC, else videotoolbox transcode) + EXACTLY ONE
  // audio track (language switch = re-cast with a new audioTrack); subtitles are sideloaded separately
  // as WebVTT TEXT tracks (cast.js), not muxed in. Non-seekable pipe → the renderer re-casts on seek.
  // Fragmented MP4, not Matroska — the swap this line always anticipated. The Cast receiver does not
  // demux Matroska: it connected, pulled a couple of seconds, and hung up, identically for a 4K H.264
  // re-encode and a 4K HEVC copy. Two codecs, one behaviour, so the container was what it refused.
  //
  // delay_moov is load-bearing and not obvious. empty_moov alone writes the header up front, which
  // the muxer cannot do for E-AC-3 — "Cannot write moov atom before EAC3 packets parsed" — so the
  // whole stream fails at startup and the receiver sees the same silence as every other failure
  // here. delay_moov holds the header back until the first packets are parsed, which costs nothing
  // and keeps Atmos/surround on the copy path instead of forcing it down to stereo AAC.
  const MKV_CONTAINER = 'mp4', MKV_MIME = 'video/mp4';
  const MKV_MUXFLAGS = CAST_PIPE_MUXFLAGS;
  let mkvGeneration = 0, mkvPreparation = null;
  function cancelMkvPreparation() {
    ++mkvGeneration;
    const pending = mkvPreparation; mkvPreparation = null;
    if (pending) pending();
  }
  function cancelMkv(why, preservePreparation) {
    const pending = preservePreparation ? null : mkvPreparation;
    if (!preservePreparation) { ++mkvGeneration; mkvPreparation = null; }
    // Who ends a cast, and why, was unrecorded — so a stream that vanished mid-film was
    // indistinguishable from one the receiver dropped. The TV then plays out its buffer and stalls
    // with no request for more, which is exactly what "the cast got stuck" looks like.
    const retiredProc = mkvProc, retiredRes = mkvRes, retiredEntry = mkvEntry;
    const retiredSubs = mkvSubProcs;
    mkvProc = null; mkvRes = null; mkvEntry = null; mkvSubProcs = [];
    // Detach ownership before callbacks from queue abandonment or child termination can reenter.
    clearSubQueue();
    if (retiredProc || retiredRes) clog('cast stream ENDED by ' + (why || 'cancelMkv'));
    if (retiredProc) { try { retiredProc.kill('SIGKILL'); } catch (e) {} }
    for (const p of retiredSubs) { try { p.kill('SIGKILL'); } catch (e) {} }
    if (retiredRes) { try { retiredRes.destroy(); } catch (e) {} }
    if (retiredEntry && retiredEntry.subCache) {
      for (const f of Object.values(retiredEntry.subCache)) { try { fs.unlinkSync(f); } catch (e) {} }
    }
    if (pending) pending();
  }
  // Build the single-stream ffmpeg args. info from probeTracks; reuses the capability-negotiated
  // copy-vs-transcode decision (so a 4K-capable LG copies, an old dongle transcodes to 1080p H.264).
  // -loglevel warning, not error. At `error` ffmpeg SUPPRESSES its "Will reconnect at <offset> in N
  // second(s)" messages, so a stream that spends minutes fighting a stalled input and then gives up
  // records the giving-up and nothing about the fight. That is the difference between knowing a cast
  // died and knowing why.
  function mkvArgs(input, info, capsRaw, audioTrack, startSec, burnSub, swEncode) {
    // Same decision, same function as serveHls — that is the point of the extraction. `encPlan` (the
    // plan with the copy taken off the table) answers for the burn-in and transcode branches below,
    // which always re-encode.
    const plan = planPlayback(info || {}, capsRaw, { canTonemap: CAN_TONEMAP });
    const encPlan = planPlayback(info || {}, capsRaw, { canTonemap: CAN_TONEMAP, forceTranscode: true });
    const isHevc = !!(info && info.vcodec === 'hevc'); // hvc1 tag on the copy path, not a decision
    // Unlike serveHls, this path has NO software-encoder retry of its own, so an unprobed source is
    // NOT started optimistically in copy mode here: an uncopyable VP9/AV1 would hard-fail with
    // nothing to catch it. Shipped behaviour, preserved verbatim — plan.speculative is that case.
    const canCopyV = !plan.speculative && plan.video === 'copy';
    const cap = encPlan.targetHeight || 0;
    const needScale = !!(info && info.height && cap && cap < info.height);
    const at = plan.audioTracks[audioTrack];
    const aArgs = (at && at.action === 'copy') ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', (at && at.bitrate) || '160k'];
    // Video ENCODER for the transcode/burn-in paths: hardware videotoolbox normally, software libx264 as
    // the fallback when a videotoolbox encode of an exotic source (VP9/AV1/VC-1) fails to emit any output.
    const vEnc = swEncode
      ? ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-profile:v', 'high']
      : ['-c:v', 'h264_videotoolbox', '-prio_speed', '1', '-b:v', '8M', '-maxrate', '12M', '-bufsize', '16M', '-pix_fmt', 'yuv420p', '-profile:v', 'high'];
    const inOpts = /^https?:\/\//i.test(input)
      ? ['-reconnect', '1', '-reconnect_at_eof', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5', '-rw_timeout', String(HTTP_READ_TIMEOUT_US)]
      : [];
    // Resume/seek: input seek to the stream's origin. Position 0 → no seek (cleanest).
    // `startSec` here is the stream's ORIGIN (a keyframe, see castSeekArgs), not the position the viewer
    // asked for. No -copyts: the MP4 muxer zeroes the clock regardless.
    const seek = castSeekArgs(startSec);
    if (burnSub != null && burnSub >= 0) {
      // BURN-IN a BITMAP subtitle (PGS/VOBSUB) into the video — image-based subs can't be sideloaded
      // as WebVTT, so the only way to show them on the Cast receiver is to composite them onto the
      // frames. Forces a videotoolbox re-encode (overlay is incompatible with -c:v copy).
      const fc = `[0:v:0][0:s:${burnSub}]overlay` + (needScale ? `,scale=-2:${cap}` : '') + '[vo]';
      return ['-hide_banner', '-nostdin', '-loglevel', 'warning', ...seek, ...inOpts, '-i', input,
        '-filter_complex', fc, '-map', '[vo]', '-map', '0:a:' + audioTrack + '?',
        ...vEnc,
        ...aArgs, '-max_muxing_queue_size', '1024', ...CAST_HYGIENE, ...MKV_MUXFLAGS, '-f', MKV_CONTAINER, 'pipe:1'];
    }
    const vArgs = canCopyV
      ? ['-c:v', 'copy', ...(isHevc ? ['-tag:v', 'hvc1'] : []), ...(plan.stripDovi ? DOVI_STRIP : [])]
      : [...(needScale ? ['-vf', 'scale=-2:' + cap] : []), ...vEnc];
    return ['-hide_banner', '-nostdin', '-loglevel', 'warning', ...seek, ...inOpts, '-i', input,
      '-map', '0:v:0', '-map', '0:a:' + audioTrack + '?', '-sn',
      ...vArgs, ...aArgs, '-max_muxing_queue_size', '1024', ...CAST_HYGIENE, ...MKV_MUXFLAGS, '-f', MKV_CONTAINER, 'pipe:1'];
  }
  // The film time at which this stream's clock reads zero: the keyframe the stream starts on.
  // Computed once per start position and remembered on the entry, because the app adds it to every
  // position the receiver reports (castOrigin) and the subtitle extractor cuts from the same instant.
  // Falls back to the whole second at or below the start when the probe cannot answer — a wrong
  // origin is wrong by less than one GOP, where no origin is wrong by the whole resume position.
  function resolveOrigin(e, from, cb) {
    if (!(from > 0)) { e.origin = 0; e.originAt = from; return cb(0); }
    if (e.originAt === from && Number.isFinite(e.origin)) return cb(e.origin);
    let out = '', done = false, ps;
    const finish = (k) => {
      if (done) return; done = true;
      const o = k === null ? Math.floor(from) : k;
      if (Number.isFinite(e.origin) && e.origin !== o) e.subCache = {}; // cues cut for the old origin no longer line up
      e.origin = o; e.originAt = from;
      clog(k === null ? 'stream origin: probe gave no keyframe, assuming ' + o + 's for a start at ' + from + 's'
        : 'stream origin ' + o + 's for a start at ' + from + 's');
      cb(o);
    };
    try { ps = spawn(FFPROBE, keyframeProbeArgs(e.input, from), { timeout: 15000 }); } catch (x) { return finish(null); }
    ps.stdout.on('data', (d) => { out += d; });
    ps.stderr.on('data', () => {});
    ps.on('error', () => finish(null));
    ps.on('close', () => finish(lastKeyframeAtOrBefore(out, from)));
  }
  // serveMkv(input, opts, cb) → cb(url, sideloadSubs, audioTracks, audioTrack, dur, menuSubs).
  // opts = {caps, audioTrack, startSec, extraSubs, burnSub}
  //   • sideloadSubs = TEXT subs (embedded + external) as on-demand WebVTT for cast.js to sideload.
  //   • menuSubs = the FULL subtitle menu: text subs (burn:false, id=castv2 trackId) AND bitmap subs
  //     (burn:true, subIdx) which the receiver can't sideload → shown via a burn-in re-cast.
  function serveMkv(input, opts, cb) {
    const lan = lanAddress();
    if (!lan || !input) return cb(null);
    cancelMkvPreparation();
    const generation = mkvGeneration;
    const complete = cb;
    let finished = false, cancelled = false, cancelTracks = null, cancelFile = null, probeStarted = false, probeSettled = false;
    const cancel = () => {
      if (finished) return;
      cancelled = true;
      try { cb(null); } finally {
        for (const dispose of [cancelTracks, cancelFile]) {
          if (typeof dispose === 'function') { try { dispose(); } catch (e) {} }
        }
      }
    };
    cb = (...args) => {
      if (finished) return;
      finished = true;
      if (mkvPreparation === cancel) mkvPreparation = null;
      complete(...args);
    };
    mkvPreparation = cancel;
    const caps = (opts && opts.caps) || null;
    const startSec = (opts && opts.startSec) || 0;
    const extraSubs = (opts && Array.isArray(opts.extraSubs)) ? opts.extraSubs : [];
    const burnSub = (opts && opts.burnSub != null) ? opts.burnSub : null;
    const subDelay = (opts && opts.subDelay) || 0; // cast subtitle sync offset (seconds, +later/−earlier)
    // Which sideloaded track to actually extract, as an index into the offered text tracks (-1 =
    // none). Everything else is stubbed. Changing it requires a re-cast: EDIT_TRACKS_INFO carries
    // activeTrackIds and nothing else, so a track's URL cannot be swapped once the LOAD has gone.
    const subPick = (opts && opts.subPick != null) ? opts.subPick : -1;
    ensure(() => {
      if (finished || generation !== mkvGeneration) return cb(null);
      if (probeStarted) return;
      probeStarted = true;
      cancelTracks = probeTracks(input, (info) => {
        if (finished || generation !== mkvGeneration) return cb(null);
        if (probeSettled) return;
        probeSettled = true;
        // What the probe saw and what the plan decided, before anything acts on it. A probe that
        // silently returned nothing produces the same downstream behaviour as a healthy one until
        // ffmpeg fails, several steps later, for reasons that look unrelated.
        clog(info
          ? 'probe: ' + info.vcodec + ' ' + info.width + 'x' + info.height + ' hdr=' + info.hdr + ' dovi=' + info.dovi +
            (info.doviProfile ? ' profile=' + info.doviProfile : '') + ' dur=' + Math.round(info.dur || 0) +
            's audio=' + ((info.audio || []).length) + ' subs=' + ((info.subs || []).length)
          : 'probe: FAILED — ffprobe returned nothing for ' + String(input).slice(0, 120));
        const aN = info && Array.isArray(info.audio) ? info.audio.length : 0;
        let audioTrack = (opts && opts.audioTrack) || 0;
        if (!Number.isSafeInteger(audioTrack) || audioTrack < 0 || audioTrack >= aN) audioTrack = 0;
        const token = newToken();
        cancelMkv('a new cast being prepared', true);
        if (finished || generation !== mkvGeneration) return cb(null);
        const audioTracks = (info && info.audio) ? info.audio.map((a) => ({ idx: a.idx, name: a.name, lang: a.lang })) : [];
        const dur = (info && info.dur) || 0;
        // Build the subtitle menu. TEXT subs → on-demand WebVTT (sideloaded, toggled instantly); BITMAP
        // subs (PGS/VOBSUB) can't become WebVTT → offered as burn-in (a re-cast composites them onto
        // the frames). External .srt → sideloaded text. The menu appears immediately (probe-driven).
        const subDefs = [];
        (info && info.subs ? info.subs : []).forEach((s) => {
          if (s.bitmap) subDefs.push({ kind: 'burn', ref: s.idx, lang: s.lang, label: s.name });
          else subDefs.push({ name: 'e' + s.idx, kind: 'embedded', ref: s.idx, lang: s.lang, label: s.name });
        });
        extraSubs.forEach((s, i) => subDefs.push({ name: 'x' + i, kind: 'external', ref: s.path, lang: s.lang || 'und', label: s.name || ('Subtitle ' + (subDefs.length + 1)) }));
        // The receiver fetches EVERY sideloaded track the moment a cast starts, not when the viewer
        // picks one — and each fetch is an ffmpeg pass over the source. On a local file that is a
        // fast disk read and the count does not matter. On a torrent it does: a release with 41
        // subtitle tracks produced 41 serialised extractions, roughly eight minutes of continuous
        // reading competing with the stream itself, and about half of them yielded nothing because
        // the data had not arrived yet.
        //
        // The old player refused outright here — "Extracting subtitles from non-local containers is
        // not supported yet." Capping is more generous than that and keeps the common cases whole:
        // one language per track, first occurrence wins, and what gets dropped is logged rather than
        // silently disappearing.
        const remoteSource = /^https?:\/\//i.test(String(input));
        // EXTRACTION ON SELECTION. Every text track is offered; only the one the viewer actually
        // picked is extracted. The others answer instantly with a valid empty WebVTT stub, which is
        // all the receiver needs — it fetches every sideloaded track eagerly at load, 1.3s in and
        // before any user action, so the fetch cannot be avoided, only made cheap.
        //
        // What this replaces: one track per language, first occurrence wins. That rule cannot be
        // made correct. Measured on a release with three English tracks, the first is signs-only
        // (103 cues across 108 minutes) and the two real dialogue tracks (903 and 1257 cues) were
        // dropped before reaching the menu — so "English" played 103 scattered cues and read as
        // subtitles being broken. No metadata separates them: forced=0 on all three, no titles, and
        // default=1 is set on the SIGNS track, so preferring `default` picks the worst one on
        // purpose. Only the cue count tells them apart, and that needs the track read. So stop
        // choosing: show them all and let the viewer decide, which is what the cap took away.
        //
        // The cap existed because 41 tracks meant 41 serialised extractions — eight minutes of
        // continuous reading competing with the stream. Stubs cost nothing, so the reason is gone.
        const offer = subDefs;
        const sideloadSubs = [], menuSubs = []; let sideIdx = 0;
        offer.forEach((s) => {
          if (s.kind === 'burn') { menuSubs.push({ burn: true, subIdx: s.ref, name: s.label, lang: s.lang }); return; }
          sideloadSubs.push({ url: `http://${lan}:${port}/sub/${token}/${s.name}.vtt`, lang: s.lang, name: s.label });
          menuSubs.push({ burn: false, id: 1000 + sideIdx, name: s.label, lang: s.lang }); // cast.js assigns trackId 1000+i in this order
          sideIdx++;
        });
        // mkvEntry.subs = the on-demand-servable TEXT subs only (serveMkvSub looks them up by name).
        const textOffer = offer.filter((s) => s.kind !== 'burn');
        // Resolved here, by the same index the receiver's trackIds use (1000 + position), so the
        // renderer can name a track by the id it already has.
        const subActive = pickActiveSub(textOffer, subPick);
        clog('offering ' + textOffer.length + ' subtitle tracks as stubs; extracting ' + (subActive || 'none') + ' for real');
        mkvEntry = { token, input, info, caps, audioTrack, startSec, burnSub, subDelay, subs: textOffer, subCache: {}, livePos: 0, servedOnce: false, dur, subActive };
        resolveOrigin(mkvEntry, startSec, () => {}); // ready long before the first subtitle is requested
        // What is actually going out, as distinct from what the file is. Only this is evidence about
        // a receiver: a picture that was re-encoded or downscaled, or audio that was converted, says
        // nothing about what the device can decode. The caller records it if the stream plays.
        const plan = planPlayback(info || {}, caps, { canTonemap: CAN_TONEMAP });
        const chosenAudio = plan.audioTracks && plan.audioTracks[audioTrack];
        const burning = burnSub != null && burnSub >= 0;
        const videoCopied = !plan.speculative && plan.video === 'copy' && !burning;
        const srcAudio = info && info.audio && info.audio[audioTrack];
        const sent = {
          container: MKV_CONTAINER,
          videoCodec: videoCopied ? ((info && info.vcodec) || null) : 'h264',
          height: videoCopied ? ((info && info.height) || 0) : (plan.targetHeight || (info && info.height) || 0),
          // Width matters as much as height. A scope-framed 4K film is 3840x1606, which is every bit
          // a 4K stream to decode and nowhere near 2160 tall — judged on height alone it teaches
          // nothing about 4K support.
          width: videoCopied ? ((info && info.width) || 0) : 0,
          // A stripped DV stream is not DV, and a tonemapped picture is not HDR — so a receiver
          // playing either proves nothing about DV or HDR support.
          hdr: !!(info && info.hdr) && videoCopied && !plan.tonemap,
          dovi: !!(info && info.dovi) && videoCopied && !plan.stripDovi,
          videoCopied,
          audioCodec: (chosenAudio && chosenAudio.action === 'copy') ? ((srcAudio && srcAudio.codec) || null) : 'aac',
          audioCopied: !!(chosenAudio && chosenAudio.action === 'copy')
        };
        // If nothing has to be changed and the receiver reads this container, hand over the file
        // itself, with ranges. That makes the cast seekable and pausable by the receiver, which
        // removes the entire class of failure the live pipe brings with it. Subtitles still come
        // from the /sub/ route above, so the entry stays.
        const direct = canSendOriginal(plan, info, { input, remote: remoteSource, audioTrack, burnSub });
        if (direct.ok) {
          clog('sending the original file untouched — no ffmpeg in the path (seekable, pausable)');
          const directSent = Object.assign({}, sent, { container: (String(input).match(/\.([a-z0-9]+)$/i) || [])[1] || 'mp4', videoCopied: true });
          cancelFile = serve(input, (u) => {
            if (finished || generation !== mkvGeneration) return;
            if (!u) { clog('direct serve failed; falling back to the stream'); return cb(`http://${lan}:${port}/mkv/${token}/video.mkv`, sideloadSubs, audioTracks, audioTrack, dur, menuSubs, sent); }
            cb(u, sideloadSubs, audioTracks, audioTrack, dur, menuSubs, directSent, true);
          });
          if (cancelled && typeof cancelFile === 'function') { try { cancelFile(); } catch (e) {} }
          return;
        }
        clog('sending: ' + JSON.stringify(sent) + ' (streamed: ' + direct.why + ')');
        cb(`http://${lan}:${port}/mkv/${token}/video.mkv`, sideloadSubs, audioTracks, audioTrack, dur, menuSubs, sent);
      });
      if (cancelled && typeof cancelTracks === 'function') { try { cancelTracks(); } catch (e) {} }
    });
  }
  // On-demand WebVTT for a sideloaded MKV-cast subtitle. Extracts the one track to a temp file (cached),
  // then serves it via serveFile (range + CORS + text/vtt). The receiver fetches this only when the
  // user turns the subtitle on, so the cast itself never waits on subtitle extraction.
  // The receiver asks for every sideloaded track the moment a cast starts, not when the viewer picks
  // one. Run in parallel, four extractions then fight over the same torrent: measured on a real cast,
  // one produced usable cues and the other three were starved so thoroughly they could not even
  // respond to a signal, and were killed having written nothing. Each one alone reads at disk speed.
  // So they take turns — one extraction at a time, each with the bandwidth to actually finish.
  let subQueue = [], subRunning = false;
  function enqueueSub(job) {
    if (subQueue.length >= 32) return false;
    subQueue.push(job);
    pumpSubs();
    return true;
  }
  function pumpSubs() {
    if (subRunning) return;
    const job = subQueue.shift();
    if (!job) return;
    subRunning = true;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true; subRunning = false; pumpSubs();
    };
    try { job(finish); } catch (e) {
      if (!settled) {
        try { job.abandon && job.abandon(); } catch (x) {}
        finish();
      }
    }
  }
  function clearSubQueue() {
    // Queued work for a cast that is over should not run. The responses are already dead.
    const retired = subQueue; subQueue = [];
    for (const job of retired) { try { job.abandon && job.abandon(); } catch (e) {} }
  }

  function serveMkvSub(req, res, token, name) {
    if (!mkvEntry || mkvEntry.token !== token) { res.writeHead(404); res.end(); return; }
    const base = String(name).replace(/\.vtt$/i, '');
    const sub = mkvEntry.subs.find((s) => s.name === base);
    if (!sub) { res.writeHead(404); res.end(); return; }
    const cached = mkvEntry.subCache[base];
    if (cached && safeStat(cached)) return serveFile(req, res, cached);
    if (req.method === 'HEAD') {
      res.writeHead(200, { 'Content-Type': 'text/vtt; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
      res.end(); return;
    }
    // Not the selected track → answer immediately with an empty but VALID track. The receiver fetches
    // all of them at load whatever we do; this makes that free instead of eight minutes of ffmpeg
    // reading the torrent. A malformed body would make the receiver drop the track from its menu, so
    // the stub has to be real WebVTT — it just has no cues yet.
    if (mkvEntry.subActive !== base) return serveSubStub(res);
    if (subRunning || subQueue.length) clog('sub extract queued: ' + base + ' (' + (subQueue.length + 1) + ' waiting)');
    const detach = () => { req.removeListener('aborted', retireQueued); res.removeListener('close', retireQueued); };
    const retireQueued = () => {
      const index = subQueue.indexOf(job);
      if (index < 0) return;
      subQueue.splice(index, 1); detach();
    };
    const job = (finished) => { detach(); runSubExtract(req, res, token, name, finished); };
    job.abandon = () => { detach(); try { res.destroy(); } catch (e) {} };
    req.on('aborted', retireQueued); res.on('close', retireQueued);
    if (!enqueueSub(job)) {
      detach();
      try { res.writeHead(503, { 'Access-Control-Allow-Origin': '*', 'Retry-After': '1' }); res.end(); } catch (e) {}
    }
  }

  // A valid, cueless WebVTT. Served for every track the viewer has not selected.
  function serveSubStub(res) {
    try {
      res.writeHead(200, { 'Content-Type': 'text/vtt; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
      res.end('WEBVTT\n\n');
    } catch (x) {}
  }

  function runSubExtract(req, res, token, name, finished) {
    const done = (() => { let called = false; return () => { if (!called) { called = true; finished(); } }; })();
    // Waiting in the queue takes time, and the receiver may have given up during it. Extracting for a
    // response nobody is listening to would spend the whole budget and hold up the track that is.
    if (req.destroyed || res.writableEnded) { clog('sub extract skipped: request gone while queued'); return done(); }
    if (!mkvEntry || mkvEntry.token !== token) { try { res.writeHead(404); res.end(); } catch (x) {} return done(); }
    const base = String(name).replace(/\.vtt$/i, '');
    const sub = mkvEntry.subs.find((s) => s.name === base);
    if (!sub) { try { res.writeHead(404); res.end(); } catch (x) {} return done(); }
    const cached = mkvEntry.subCache[base];
    if (cached && safeStat(cached)) { serveFile(req, res, cached); return done(); }
    try { fs.mkdirSync(path.join(remuxRoot, 'subs'), { recursive: true }); } catch (e) {}
    const out = path.join(remuxRoot, 'subs', newToken() + '.vtt');
    // Embedded subtitles start at the position the cast started from, with absolute timestamps.
    // Seeking the input jumps straight to that region rather than reading up to it, which matters
    // enormously on a torrent: the bytes around the play head are already on disk from sequential
    // download, so those cues come out at disk speed. The cues are cut from the same keyframe the video
    // stream starts on (subSeekArgs), so both clocks read zero at the same film time.
    const origin = Number.isFinite(mkvEntry.origin) ? mkvEntry.origin : Math.max(0, Math.floor((mkvEntry.startSec || 0)));
    const args = sub.kind === 'external'
      ? ['-loglevel', 'error', '-y', '-sub_charenc', sniffCharenc(sub.ref), '-i', sub.ref, '-c:s', 'webvtt', '-f', 'webvtt', out]
      : ['-loglevel', 'error', '-y', ...subSeekArgs(origin),
        '-i', mkvEntry.input, '-map', '0:s:' + sub.ref, '-c:s', 'webvtt', '-f', 'webvtt', out];
    let ff;
    try { ff = spawn(FFMPEG, args); } catch (e) {
      try { fs.unlinkSync(out); } catch (x) {}
      try { res.writeHead(500, { 'Access-Control-Allow-Origin': '*' }); res.end(); } catch (x) {}
      done(); return;
    }
    ff.stderr.on('data', () => {});
    // Track it. These were spawned into a local and never referenced again: cancelMkv() killed only
    // the stream ffmpeg, so stopping a cast left every extraction running. Observed after one stopped
    // cast — four of them still reading the torrent minutes later, competing with playback for the
    // same bandwidth and with each other.
    mkvSubProcs.push(ff);
    const drop = () => { const i = mkvSubProcs.indexOf(ff); if (i >= 0) mkvSubProcs.splice(i, 1); };
    clog('sub extract start: ' + base + ' (' + sub.kind + ')');
    const t0 = Date.now();
    const fail = () => { try { fs.unlinkSync(out); } catch (x) {} try { res.writeHead(500, { 'Access-Control-Allow-Origin': '*' }); res.end(); } catch (x) {} done(); };
    // The receiver giving up (or the cast ending) should end the work it asked for. Without this the
    // extraction outlives the request that justified it.

    // Collecting every cue means reading the whole source, because subtitle samples are interleaved
    // through the media. On a torrent that is hours and the receiver gives up long before. So the run
    // is given a deadline and whatever it produced by then is served: on a local file it finishes far
    // inside the budget and nothing changes, and on a torrent it yields the stretch that is actually
    // downloaded, which is the stretch about to be watched.
    //
    // SIGTERM, emphatically not SIGKILL. ffmpeg buffers output and writes the trailer on its way out,
    // so a killed run loses everything it had. Measured on a fixture: the same extraction killed
    // yields an empty file, terminated yields eleven cues. The first version of this used SIGKILL and
    // destroyed precisely what the deadline existed to salvage — every track came back size=0.
    // (-flush_packets changes nothing; the signal is what matters.)
    let timedOut = false, grace = null, producerFailed = false, producerClosed = false;
    const budget = setTimeout(() => {
      if (!producerClosed && !producerFailed && ff.exitCode === null && !ff.killed) {
        timedOut = true;
        clog('sub extract ' + base + ': budget reached, asking ffmpeg to finish and flush');
        try { ff.kill('SIGTERM'); } catch (x) {}
        // Only if it ignores that — a read wedged on a dead socket will not answer SIGTERM.
        grace = setTimeout(() => { if (!producerClosed && !producerFailed) { try { ff.kill('SIGKILL'); } catch (x) {} } }, SUB_GRACE_MS);
      }
    }, SUB_BUDGET_MS);
    let requestDetached = false;
    const detachRequest = () => {
      if (requestDetached) return;
      requestDetached = true;
      req.removeListener('aborted', abandon); res.removeListener('close', abandon);
      res.removeListener('error', abandon);
      // Keep late socket errors handled without retaining extraction ownership.
      res.on('error', () => {});
    };
    const abandon = () => {
      if (producerClosed || producerFailed) return;
      producerFailed = true; detachRequest(); clearTimeout(budget); clearTimeout(grace); drop();
      try { ff.kill('SIGKILL'); } catch (x) {}
      try { fs.unlinkSync(out); } catch (x) {}
      done();
    };
    req.on('aborted', abandon);
    res.on('close', abandon);
    res.on('error', abandon);
    const producerError = () => {
      if (producerFailed || producerClosed) return;
      producerFailed = true; detachRequest(); clearTimeout(budget); clearTimeout(grace); drop();
      try { ff.kill('SIGKILL'); } catch (x) {}
      try { fs.unlinkSync(out); } catch (x) {}
      fail();
    };
    ff.on('error', producerError);
    ff.stderr.on('error', producerError);
    // Whatever happens next, the next queued extraction gets its turn.
    ff.on('close', (code) => {
      if (producerClosed) return;
      producerClosed = true; detachRequest();
      clearTimeout(budget); clearTimeout(grace); drop();
      if (producerFailed) { try { fs.unlinkSync(out); } catch (x) {} return; }
      clog('sub extract ' + base + ' exited code=' + code + (timedOut ? ' (deadline)' : '') + ' after ' + (Date.now() - t0) + 'ms size=' + ((safeStat(out) || {}).size || 0));
      if (!mkvEntry || mkvEntry.token !== token) { try { fs.unlinkSync(out); } catch (x) {} return fail(); } // superseded
      // A clean exit means the file is complete. A killed one may end mid-cue, so it is trimmed back
      // to the last complete cue — a receiver that rejects a malformed tail drops the whole track,
      // which would turn "some subtitles" into "no subtitles".
      if (code !== 0) {
        let salvaged = null;
        try { salvaged = trimToCompleteCues(fs.readFileSync(out, 'utf8')); } catch (x) {}
        if (!salvaged) { clog('sub extract ' + base + ': nothing usable extracted'); return fail(); }
        try { fs.writeFileSync(out, salvaged); } catch (x) { return fail(); }
        clog('sub extract ' + base + ': serving partial track covering to ' + Math.round(coverageEnd(salvaged)) + 's');
      }
      if (!safeStat(out)) return fail();
      shiftVtt(out, mkvEntry.subDelay); mkvEntry.subCache[base] = out; serveFile(req, res, out);
      done();
    });
  }
  function serveMkvStream(req, res, token) {
    if (!mkvEntry || mkvEntry.token !== token) {
      clog('GET /mkv rejected: ' + (mkvEntry ? 'stale token' : 'no active entry') + ' — the receiver asked for a stream we are no longer serving');
      res.writeHead(404); res.end(); return;
    }
    if (req.method === 'HEAD') {
      res.writeHead(200, { 'Content-Type': MKV_MIME, 'Accept-Ranges': 'none', 'Cache-Control': 'no-cache', 'Connection': 'close' });
      res.end(); return;
    }
    const e = mkvEntry;
    clog('GET /mkv from ' + (req.socket && req.socket.remoteAddress) + ' method=' + req.method + ' input=' + String(e.input).slice(0, 120));
    const retiredProc = mkvProc, retiredRes = mkvRes;
    mkvProc = null; mkvRes = res;
    if (retiredProc) {
      clog('cast stream ENDED by a fresh GET superseding it');
      try { retiredProc.stdout.unpipe(retiredRes); } catch (x) {}
      try { retiredProc.kill('SIGKILL'); } catch (x) {}
    }
    if (retiredRes && retiredRes !== res) { try { retiredRes.destroy(); } catch (x) {} }
    // Cleanup may admit another request or retire the cast. Preserve that newer ownership.
    if (mkvRes !== res || mkvEntry !== e) { try { res.destroy(); } catch (x) {} return; }
    res.writeHead(200, { 'Content-Type': MKV_MIME, 'Accept-Ranges': 'none', 'Cache-Control': 'no-cache', 'Connection': 'close' });
    let produced = false, triedSw = false;
    let errTail = '';   // last stderr of the CURRENT launch; onEnd is declared out here and needs it
    const onEnd = (ff, code) => {
      if (ff !== mkvProc) return;
      mkvProc = null;
      try { ff.stdout.unpipe(res); } catch (x) {}
      if (mkvRes !== res || mkvEntry !== e || res.destroyed || res.writableEnded) return;
      // The encoder died before emitting a single byte (e.g. a hardware videotoolbox transcode of an
      // exotic codec it can't handle) → retry ONCE with the software libx264 encoder, reusing the open
      // 200 (no body sent yet, so the receiver just keeps waiting on the same connection).
      // Retry with the software encoder only when the ENCODER is what failed. When the source went
      // quiet, a different encoder changes nothing — it just spends the receiver's patience on a
      // second doomed attempt and files the result under the wrong cause.
      if (!produced && !triedSw) {
        const kind = classifyFailure(errTail);
        if (shouldRetryInSoftware(errTail)) { triedSw = true; clog('no output (' + kind + ' failure) — retrying with the software encoder'); return launch(true); }
        clog('no output and the input is what failed — not retrying, a different encoder cannot help');
      }
      // How this connection closes is the ONLY signal the receiver gets about whether the media
      // finished. A clean res.end() is indistinguishable from a complete stream, so an ffmpeg that
      // crashed or was killed mid-film made the TV report IDLE/FINISHED — playback "ending" early
      // with the resume marker cleared. Only end cleanly on a genuine exit 0; otherwise destroy the
      // socket so the receiver sees a truncated stream and can surface/retry it as an error.
      if (code === 0) { try { res.end(); } catch (x) {} }
      else { try { res.destroy(); } catch (x) {} }
      if (mkvRes === res) mkvRes = null;
    };
    function launch(sw) {
      if (mkvRes !== res || mkvEntry !== e || res.destroyed || res.writableEnded) return;
      // The receiver re-requests this URL whenever the stream stalls, and that is not something we
      // control. Relaunching from e.startSec fed it video from behind where it had already played,
      // so it buffered until ffmpeg caught up and then re-requested again — a loop that looks like
      // "the cast only runs for a few minutes, around the middle of the film". Restart from where it
      // actually is.
      const from = resumePosition({ first: !e.servedOnce, startSec: e.startSec, livePos: e.livePos, durationSec: e.dur });
      if (from !== e.startSec) clog('restarting the stream at ' + from + 's (receiver was at ' + Math.round(e.livePos) + 's, original start ' + e.startSec + 's)');
      resolveOrigin(e, from, (origin) => {
        if (mkvRes !== res || mkvEntry !== e || res.destroyed || res.writableEnded) return; // went away while probing
        spawnStream(sw, origin);
      });
    }
    function spawnStream(sw, origin) {
      const args = mkvArgs(e.input, e.info, e.caps, e.audioTrack, origin, e.burnSub, sw);
      let ff;
      try { ff = spawn(FFMPEG, args); } catch (x) {
        if (mkvRes === res) { mkvRes = null; try { res.destroy(); } catch (e) {} }
        return;
      }
      mkvProc = ff;
      const t0 = Date.now();
      errTail = '';
      clog('ffmpeg launch' + (sw ? ' (software encoder retry)' : '') + ': ' + args.join(' '));
      // Keep the last of stderr rather than discarding it. Bounded, because a long transcode emits a
      // great deal of it and the interesting part is always the end.
      let launchTail = '';
      ff.stderr.on('data', (b) => {
        launchTail = (launchTail + b.toString()).slice(-4000);
        if (ff === mkvProc) errTail = launchTail;
      });
      let producerFailed = false;
      const producerError = () => {
        if (producerFailed || ff !== mkvProc) return;
        producerFailed = true;
        onEnd(ff, -1);
        try { ff.kill('SIGKILL'); } catch (x) {}
      };
      ff.stdout.on('error', producerError);
      ff.stderr.on('error', producerError);
      ff.stdout.once('data', () => { if (ff !== mkvProc) return; produced = true; e.servedOnce = true; clog('first byte out after ' + (Date.now() - t0) + 'ms'); });
      ff.on('close', (code) => {
        clog('ffmpeg exited code=' + code + ' after ' + (Date.now() - t0) + 'ms, produced=' + produced);
        if (launchTail.trim()) clog('ffmpeg stderr:\n' + launchTail.trim());
      });
      ff.stdout.pipe(res, { end: false }); // keep res open across a hw→sw relaunch; pipe preserves backpressure
      ff.on('error', producerError); // producer failure — never a clean end
      ff.on('close', (code) => onEnd(ff, code));
    }
    const abandonStream = () => {
      if (mkvRes !== res) return;
      const retired = mkvProc;
      mkvProc = null; mkvRes = null;
      if (retired) {
        clog('cast stream ENDED by the receiver closing the connection');
        try { retired.kill('SIGKILL'); } catch (x) {}
        try { onCastStreamLost('the receiver closed the connection'); } catch (x) {}
      }
    };
    req.on('aborted', abandonStream);
    res.on('close', abandonStream);
    res.on('error', abandonStream);
    launch(false);
  }

  // Remux `src` → a temp MP4 (video copied, audio→AAC if needed), then cb(absTempPath|null).
  // -c copy is fast (I/O-bound, no re-encode); we wait for completion so the served file
  // is complete + range-seekable (AVPlayer requires that).
  function remuxToTemp(src, transcodeAudio, cb) {
    cancelRemux();
    try { fs.mkdirSync(remuxRoot, { recursive: true }); } catch (e) {}
    const out = path.join(remuxRoot, newToken() + '.mp4');
    // Keep the source audio channel layout (no forced -ac 2) so 5.1/7.1 surround survives.
    const args = ['-loglevel', 'error', '-y', '-i', src, '-c:v', 'copy', '-c:a', transcodeAudio ? 'aac' : 'copy'];
    if (transcodeAudio) args.push('-b:a', '384k');
    args.push('-movflags', '+faststart', '-f', 'mp4', out); // faststart: moov up front → fast TV start
    let ff, finished = false, discardOutput = false;
    const remove = () => { try { fs.unlinkSync(out); } catch (e) {} };
    const cancel = () => {
      if (finished) return;
      finished = true; discardOutput = true;
      if (remuxProc === ff) remuxProc = null;
      if (remuxOut === out) remuxOut = null;
      try { if (ff) ff.kill('SIGKILL'); } catch (e) {}
      remove();
    };
    remuxOut = out;
    try { ff = remuxProc = spawn(FFMPEG, args); } catch (e) {
      finished = true; if (remuxOut === out) remuxOut = null;
      remove(); cb(null); return cancel;
    }
    ff.stderr.on('data', () => {});
    const settle = (code) => {
      if (finished) { if (discardOutput) remove(); return; }
      if (ff !== remuxProc) { finished = true; discardOutput = true; remove(); return; }
      finished = true; remuxProc = null;
      if (code === 0 && safeStat(out)) cb(out);
      else { discardOutput = true; remove(); if (remuxOut === out) remuxOut = null; cb(null); }
    };
    ff.on('error', () => settle(-1));
    ff.on('close', settle);
    return cancel;
  }

  // (Removed: setMasterDefaultAudio/setMasterDefaultSubtitle — the old AirPlay "rewrite the master
  // DEFAULT + reload" track-switch path. AirPlay now switches renditions via the native AVPlayer
  // AVMediaSelectionGroup (apAddon.selectMedia) and Chromecast via EDIT_TRACKS_INFO, so these are dead.)

  // Serve an external subtitle file for a DLNA cast as a sidecar the LG can sideload. webOS DLNA
  // loads SRT/SMI sidecars (advertised in the DIDL), so SRT is served as-is and ASS/SSA/VTT/SUB are
  // converted to UTF-8 SRT (charset-sniffed). cb(lanUrl|null). The DLNA route plays the original file
  // untouched, so EMBEDDED subs are already handled by the TV — this is only for external files.
  function serveSubtitleForDlna(filePath, cb) {
    if (!filePath) return cb(null);
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.srt' || ext === '.smi') return serve(filePath, cb); // LG loads these directly
    try { fs.mkdirSync(remuxRoot, { recursive: true }); } catch (e) {}
    const out = path.join(remuxRoot, newToken() + '.srt');
    const ff = spawn(FFMPEG, ['-loglevel', 'error', '-y', '-sub_charenc', sniffCharenc(filePath), '-i', filePath, '-c:s', 'subrip', '-f', 'srt', out]);
    ff.stderr.on('data', () => {});
    ff.on('error', () => cb(null));
    ff.on('close', (code) => { if (code === 0 && safeStat(out)) serve(out, cb); else cb(null); });
  }

  // serve(absPath, cb) → cb(lanUrl|null) — direct file, range-supported (already compatible).
  function serve(absPath, cb) {
    const lan = lanAddress();
    if (!lan || !absPath) return cb(null);
    return tokenReady(cb, () => {
      const token = newToken(); files.set(token, absPath);
      cb(`http://${lan}:${port}/file/${token}/${encodeURIComponent(path.basename(absPath))}`);
    });
  }

  // prepareCast(input, isFile, cb, remuxAlt) → cb(lanUrl|null). Probes the source and returns a
  // TV-fetchable URL: direct serve if already compatible, else repackage. When `remuxAlt(input, cb)`
  // is given (the casting path passes serveHls), the repackage uses live HLS — its first segment is
  // ready in ~1–3s, so the cast button appears fast even for an MP4 whose audio needs transcoding
  // (e.g. a 4K movie with TrueHD/DTS). Without it (DLNA, which needs a finite MP4) it falls back to
  // a full remux-to-temp-MP4 (slow for big files). null if the VIDEO codec is unsupported.
  const directPreparations = new Set();
  function cancelDirectPreparations() {
    for (const cancel of [...directPreparations]) cancel();
  }
  function prepareCast(input, isFile, cb, remuxAlt, opts) {
    const lan = lanAddress();
    if (!lan || !input) return cb(null);
    const complete = cb;
    let finished = false, cancelled = false, disposeProbe = null, disposeFallback = null, disposeSubs = null, disposeServe = null, fallbackStarted = false, probeAnswered = false;
    const cancel = () => {
      if (finished) return;
      cancelled = true; cb(null);
      for (const dispose of [disposeProbe, disposeFallback, disposeSubs, disposeServe]) if (typeof dispose === 'function') { try { dispose(); } catch (e) {} }
      disposeProbe = null; disposeFallback = null; disposeSubs = null; disposeServe = null;
    };
    cb = (...args) => {
      if (finished) return;
      finished = true;
      directPreparations.delete(cancel);
      try { complete(...args); } catch (e) {}
    };
    directPreparations.add(cancel);
    const fallback = () => {
      if (finished || fallbackStarted) return;
      fallbackStarted = true;
      if (!remuxAlt) return cb(null);
      disposeFallback = remuxAlt(input, cb);
      if (cancelled && typeof disposeFallback === 'function') { try { disposeFallback(); } catch (e) {} disposeFallback = null; }
    };
    const extraSubs = (opts && Array.isArray(opts.extraSubs)) ? opts.extraSubs : [];
    disposeProbe = probe(input, (info) => {
      if (finished || probeAnswered) return;
      probeAnswered = true;
      if (!info || !info.vcodec) return fallback(); // inconclusive → let HLS try (it has the fallback)
      // VP9/AV1/Xvid/VC-1/WMV can't ride a direct MP4 → hand to the HLS path, which now transcodes
      // them (was: hard refuse). DLNA serves the original untouched, so the TV decodes them natively.
      if (!VIDEO_OK.has(info.vcodec)) return fallback();
      const ext = isFile ? path.extname(input).toLowerCase().replace('.', '') : (input.match(/\.(\w+)(\?|#|$)/) || [])[1];
      const compatContainer = ['mp4', 'm4v', 'mov'].includes(ext) || /\/webtorrent\//.test(input) && /\.(mp4|m4v|mov)/i.test(input);
      const compatAudio = !info.acodec || AUDIO_OK.has(info.acodec);
      if (compatContainer && compatAudio) {
        // Already castable as-is: direct file serve (+ sideloadable subs), or a token-scoped torrent proxy.
        const finishDirect = (url) => {
          if (finished) return;
          if (!url) return cb(null);
          // Attach embedded text subs (local files) + any external .srt/.ass as standalone WebVTT the
          // cast receiver can sideload — direct-MP4 casts used to carry NO subtitles. Only when this is
          // an actual Chromecast handoff (directSubs) — AirPlay/AVPlayer reads MP4 subs itself, so the
          // pre-resolution skips the extraction.
          if (opts && opts.directSubs) {
            disposeSubs = prepareDirectSubs(input, isFile, extraSubs, (subs) => cb(url, subs));
            if (cancelled && typeof disposeSubs === 'function') { try { disposeSubs(); } catch (e) {} disposeSubs = null; }
          }
          else cb(url);
        };
        if (isFile) {
          disposeServe = serve(input, finishDirect);
          if (cancelled && typeof disposeServe === 'function') { try { disposeServe(); } catch (e) {} disposeServe = null; }
          return;
        }
        const m = input.match(/^http:\/\/(?:localhost|127\.0\.0\.1)(:\d+)(\/.*)$/i);
        if (!m) return finishDirect(null);
        disposeServe = serveDlna(input, 'video/mp4', finishDirect);
        if (cancelled && typeof disposeServe === 'function') { try { disposeServe(); } catch (e) {} disposeServe = null; }
        return;
      }
      if (remuxAlt) return fallback(); // fast: live HLS (first segment in seconds)
      // remux needed (foreign container and/or audio): -c:v copy (+ audio→AAC) to a temp
      // MP4, then serve that complete file via /file/ with range support.
      ensure(() => {
        if (finished) return;
        disposeFallback = remuxToTemp(input, !compatAudio, (tempPath) => {
          if (finished) return;
          if (!tempPath) return cb(null);
          disposeServe = serve(tempPath, cb);
          if (cancelled && typeof disposeServe === 'function') { try { disposeServe(); } catch (e) {} disposeServe = null; }
        });
        if (cancelled && typeof disposeFallback === 'function') { try { disposeFallback(); } catch (e) {} disposeFallback = null; }
      });
    });
    if (cancelled && typeof disposeProbe === 'function') { try { disposeProbe(); } catch (e) {} disposeProbe = null; }
    return cancel;
  }

  // Extract embedded text subtitle tracks (local file) + external .srt/.ass files to standalone
  // WebVTT served over /file/ (text/vtt), for SIDELOADING onto a direct-MP4 cast (cast.js → TEXT
  // tracks). cb([{url,lang,name}]). Torrent/remote input: skip embedded probe (would stall), but
  // still attach external files. Bitmap subs are skipped (no WebVTT path).
  const directSubJobs = new Set();
  function cancelDirectSubJobs() {
    for (const cancel of [...directSubJobs]) cancel();
  }
  function prepareDirectSubs(input, isFile, extraSubs, cb) {
    let finished = false, cancelled = false, started = false, disposeProbe = null;
    const children = new Set(), outputs = new Set(), registrations = new Set();
    const finish = (tracks) => {
      if (finished) return;
      finished = true;
      directSubJobs.delete(cancel);
      cb(tracks);
    };
    const cancel = () => {
      if (finished) return;
      finished = true; cancelled = true;
      directSubJobs.delete(cancel);
      if (typeof disposeProbe === 'function') { try { disposeProbe(); } catch (e) {} }
      for (const dispose of registrations) { try { dispose(); } catch (e) {} }
      registrations.clear();
      for (const child of children) { try { child.kill('SIGKILL'); } catch (e) {} }
      for (const file of outputs) { try { fs.unlinkSync(file); } catch (e) {} }
    };
    directSubJobs.add(cancel);
    const dir = path.join(remuxRoot, 'subs');
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
    const run = (embedded) => {
      if (finished || started) return;
      started = true;
      const sources = embedded.map((s) => ({ idx: s.idx, lang: s.lang, name: s.name }))
        .concat((extraSubs || []).map((s, i) => ({ path: s.path, lang: s.lang || 'und', name: s.name || ('Subtitle ' + (embedded.length + i + 1)) })));
      if (!sources.length) return finish([]);
      const out = []; let pending = sources.length;
      const settle = () => { if (--pending === 0) finish(out); };
      sources.forEach((s) => {
        const vtt = path.join(dir, newToken() + '.vtt');
        outputs.add(vtt);
        const ffArgs = s.path
          ? ['-loglevel', 'error', '-y', '-sub_charenc', sniffCharenc(s.path), '-i', s.path, '-c:s', 'webvtt', '-f', 'webvtt', vtt]
          : ['-loglevel', 'error', '-y', '-i', input, '-map', '0:s:' + s.idx, '-c:s', 'webvtt', '-f', 'webvtt', vtt];
        let ff, answered = false, producerSettled = false, discardOutput = false;
        const discard = () => { discardOutput = true; try { fs.unlinkSync(vtt); } catch (e) {} };
        const done = () => { if (answered) return; answered = true; settle(); };
        try { ff = spawn(FFMPEG, ffArgs); } catch (e) { discard(); done(); return; }
        children.add(ff);
        ff.stderr.on('data', () => {});
        ff.on('error', () => {
          if (producerSettled) return;
          producerSettled = true; discard();
          if (!finished) done();
        });
        ff.on('close', (code) => {
          children.delete(ff);
          if (finished || answered || producerSettled) {
            if (cancelled || discardOutput) discard();
            return;
          }
          producerSettled = true;
          let ok = false; try { ok = code === 0 && fs.statSync(vtt).size > 12; } catch (e) {}
          if (ok) {
            let registered = false;
            const dispose = serve(vtt, (u) => {
              if (registered) return;
              registered = true;
              if (finished || answered) return;
              if (u) out.push({ url: u, lang: s.lang, name: s.name });
              else discard();
              done();
            });
            if (!registered && typeof dispose === 'function') {
              if (finished) { try { dispose(); } catch (e) {} }
              else registrations.add(dispose);
            }
          } else { discard(); done(); }
        });
      });
    };
    if (isFile) disposeProbe = probeTracks(input, (info) => run(info && info.subs ? info.subs.filter((x) => !x.bitmap) : []));
    else run([]);
    if (cancelled && typeof disposeProbe === 'function') { try { disposeProbe(); } catch (e) {} disposeProbe = null; }
    return cancel;
  }

  function teardown() {
    cancelDirectSubJobs();
    cancelTokenRegistrations();
    // cancelVod BEFORE the directory is removed: it kills the segment producers and subtitle
    // extractors still running. Without it those ffmpegs outlive teardown entirely — they keep
    // writing into a directory that is about to be deleted, and they hold the process open. Found
    // because a test file stopped exiting once a case left a session in flight.
    cancelDirectPreparations();
    cancelRemux(); cancelHls(); cancelVod(); cancelMkv('teardown');
    try { if (server) server.close(); } catch (e) {} server = null;
    try { if (binding) binding.close(); } catch (e) {} binding = null;
    cancelProxyRequests();
    files.clear(); dlnaProxies.clear(); // drop all token→path / proxy entries (were leaking until quit)
    // This instance's roots only. NOT the parents: those are shared with every other Spritz on the
    // machine, and removing them is the bug above.
    for (const root of [remuxRoot, hlsRoot, vodRoot]) {
      try { fs.rmSync(root, { recursive: true, force: true }); } catch (e) {}
    }
  }

  // Cancel any in-flight HLS remux + temp remux (without closing the server) — used when the source
  // changes or a torrent is cancelled, so an orphan ffmpeg isn't left reading a dead URL. Also prune
  // the per-source token Maps (they only grew until app-quit before): the previous source's /file/ and
  // /dlna/ URLs are dead now, and the next source re-registers its own afterwards. (Audit M7)

  // ---- seekable VOD (on-demand segments) --------------------------------------------------------
  //
  // The route hls-vod.js was written for and never got. Every cast today is a LIVE PIPE: one ffmpeg
  // writing until something stops it, which is why this project has a resume-point module, a cast
  // recovery module, and a long history of a paused receiver killing a socket. A VOD playlist
  // replaces all of that with arithmetic — the receiver is handed the complete, finite shape of the
  // film up front and asks for the parts it wants. Pausing is not asking. Seeking is asking for a
  // different index. A stall is asking again.
  //
  // OFF BY DEFAULT (SPRITZ_VOD=1). The segments form a continuous, advancing timeline — see
  // vod-segment.test.js, which runs ffmpeg and checks exactly that.
  //
  // Since proven on an LG NANO80T6A (webOS 33.31.61) against a 1080p HEVC copy, 182 segments: the
  // set read the finite playlist and reported the full duration before anything was encoded, sought
  // in both directions including 2293s deep, survived pause/resume, and ran unattended for minutes
  // with content advancing 1:1 with the wall clock. Note it fires a `stalled` at every segment
  // boundary regardless of whether the segment was already cached — see VOD_READAHEAD; that event
  // is not a signal about this route.
  //
  // STILL UNPROVEN: an AVPlayer on this route at all (main.js is what hands it one), subtitle and
  // audio-rendition switching, and a full watch-through long enough to evict.
  const VOD_ENABLED = () => process.env.SPRITZ_VOD === '1';
  // Beyond this the keyframe probe is not worth waiting for. It is a full pass over the file index,
  // and on a slow disk or a network share it can take longer than the user will sit through.
  const VOD_PROBE_TIMEOUT = 60000;
  // How many segments to produce AHEAD of the one being served.
  //
  // This exists to keep segment production off the critical path, NOT to silence the television's
  // `stalled` events. That distinction was measured, and it cost a hardware run to learn.
  //
  // On the NANO80T6A playing a 1080p HEVC copy, the set fires a `stalled` at every segment
  // boundary — cadence matching the EXTINF values exactly. The obvious reading was that the
  // just-in-time ffmpeg was the cause and a cushion would remove them. It does not. With the
  // read-ahead in place the events continue at the same cadence (255.7s, 266.3s, 275.8s, ...
  // 338.6s, 350.1s of content) even though, at t=350.1s — inside segment 22 — the cache already
  // held through segment 27, and a cached segment answers in ~3ms. The set emits `stalled` on the
  // segment transition itself, whatever the server does. Playback ran 1:1 with the wall clock
  // throughout, both with and without this. Do not use `stalled` counts to judge this route.
  //
  // What the read-ahead is still worth: on that run the producer genuinely stayed several segments
  // ahead of the playhead, so a request never waited on an ffmpeg. A stream copy off an SSD is
  // fast enough that the margin was invisible either way — a slower disk, a larger segment or a
  // torrent-backed source is where a zero-margin just-in-time cut becomes a real stutter. That is
  // an argument from the mechanism, not from a measurement; it has not been demonstrated on slow
  // media, and the television gives no signal that would show it.
  //
  // Two, not ten: each one is an ffmpeg, and the point is a cushion, not a pre-encode of the film —
  // which is the thing this whole design exists to avoid.
  const VOD_READAHEAD = 2;

  // Produce segments in ONE ffmpeg run instead of one process per segment.
  //
  // OFF BY DEFAULT (SPRITZ_VOD_RUN=1), because it has never been tested on hardware and the path it
  // replaces, bad as it is, at least plays for 130 seconds.
  //
  // Why it exists: cutting each segment independently gives every one the open-GOP lead-in, so
  // consecutive segments OVERLAP and every boundary steps backward while the playlist promises a
  // continuous timeline. Measured on an LG webOS television — 130s of clean playback, then a
  // LIVELOCK: 15,107 aborted segment fetches alternating between the two segments whose ranges
  // conflict, each connection closed by the receiver after ~20ms. ffmpeg's own HLS demuxer reports
  // the same fault as a timestamp discontinuity at every boundary, accumulating 83.6s of correction
  // over nine of them. See segmentRunArgs in vod-segment.js for the full measurement.
  const VOD_RUN_ENABLED = () => process.env.SPRITZ_VOD_RUN === '1';

  // Segment the WHOLE film in one stream-copy pass at cast start, and serve the playlist ffmpeg
  // writes, instead of cutting segments on demand at boundaries we choose.
  //
  // OFF BY DEFAULT (SPRITZ_VOD_PRESEG=1) until it has run on hardware.
  //
  // Every way of forcing our own boundaries corrupts an open-GOP source — see presegmentArgs in
  // vod-segment.js for the five variants measured. Letting the segmenter choose is the only clean
  // option, and it turns out to cost almost nothing: measured on the 5981s test WEBRip, a stream
  // copy segments 600s in 0.3s (2169x realtime), so about 3 seconds for the whole film, at a disk
  // cost roughly equal to the source. The on-demand machinery below — the LRU, the read-ahead, the
  // production de-duplication — exists to avoid a cost that does not exist.
  const VOD_PRESEG_ENABLED = () => process.env.SPRITZ_VOD_PRESEG === '1';
  // Transport EPOCHS: one ffmpeg-owned HLS run per seek, from that position — see transport-epoch.js.
  // OFF BY DEFAULT (SPRITZ_VOD_EPOCH=1) until it has run on hardware. Takes precedence over preseg.
  const VOD_EPOCH_ENABLED = () => process.env.SPRITZ_VOD_EPOCH === '1';
  // What the receiver's currentTime counts inside an epoch's media, which -copyts stamps with SOURCE
  // timestamps: 'pts' if the player exposes them (local == logical), 'zero' if it counts from the
  // first frame it played. A property of the television, TO BE MEASURED on hardware; until then
  // this is a setting, not knowledge.
  const VOD_EPOCH_CLOCK = () => (process.env.SPRITZ_VOD_EPOCH_CLOCK === 'pts' ? 'pts' : 'zero');
  // Which HLS playlist type an epoch run writes; 'vod' is the alternative to measure against the
  // live-edge start seen with 'event'. See epochArgs.
  const VOD_EPOCH_PLAYLIST = () => (process.env.SPRITZ_VOD_EPOCH_PLAYLIST === 'vod' ? 'vod' : 'event');
  // How long a superseded epoch's files stay after a newer one took over: long enough for a
  // receiver mid-switch to finish the segment it was fetching, short enough not to keep two films
  // on disk.
  const VOD_EPOCH_LINGER_MS = 20000;
  // How long to wait for a fresh epoch's playlist to appear before giving up on it.
  const VOD_EPOCH_PLAYLIST_TIMEOUT = 30000;
  // How many segments one run produces before the next request starts another. Long enough that a
  // boundary — and its one unavoidable lead-in — is rare; short enough that a seek does not leave a
  // large ffmpeg running for film nobody will watch.
  const VOD_RUN_SEGMENTS = 12;
  // How often to look for the run's output while a request waits on it. A run writes progressively,
  // so unlike a per-segment cut there is no process exit to wait for.
  const VOD_RUN_POLL_MS = 100;
  // How long a request will wait for a run to reach its segment before giving up. Generous next to
  // the 6-47ms a cold cut measured, because a run that has just started may be several segments
  // behind the one being asked for.
  const VOD_RUN_TIMEOUT = 60000;

  // The current session. One at a time, like hlsToken — a second source supersedes the first, and
  // requests carrying the old token get a 404 rather than segments of the wrong film.
  let vod = null; // { token, input, dir, segments, copyAudio, procs:Map, waiters:Map, lru:[] }
  // Which serveVod call is the live one. Everything between the request and the playlist is async —
  // two ffprobe passes — so a second call overtakes the first whenever the first file is slower to
  // probe, and completion order is not call order. Without this the LOSER still built a session,
  // still overwrote `vod`, and still handed its caller a URL: measured on two 40s files, the first
  // caller received a playlist whose every fetch 404'd, because the second had already replaced the
  // session it named. serveHls guards the same race by comparing a captured token; this is the same
  // guard, made explicit.
  let vodGen = 0;
  const vodPreparations = new Set();

  function cancelVod() {
    ++vodGen; // ownership starts before a session or server exists
    for (const cancel of [...vodPreparations]) cancel();
    if (!vod) return;
    const dead = vod; vod = null;
    for (const timer of (dead.lingering || new Map()).values()) clearTimeout(timer);
    if (dead.lingering) dead.lingering.clear();
    for (const cancel of [...(dead.epochWaiters || new Set())]) { try { cancel(); } catch (e) {} }
    for (const cancel of [...(dead.runWaiters || new Set())]) { try { cancel(); } catch (e) {} }
    for (const ff of dead.procs.values()) { try { ff.kill('SIGKILL'); } catch (e) {} }
    dead.procs.clear();
    for (const r of (dead.runs || new Map()).values()) { if (r.proc) { try { r.proc.kill('SIGKILL'); } catch (e) {} } }
    if (dead.runs) dead.runs.clear();
    if (dead.presegProc) { try { dead.presegProc.kill('SIGKILL'); } catch (e) {} dead.presegProc = null; }
    if (dead.epochs) { try { dead.epochs.close(); } catch (e) {} } // every run killed, producer inactive
    for (const ff of dead.subProcs.values()) { try { ff.kill('SIGKILL'); } catch (e) {} }
    dead.subProcs.clear();
    // Everyone still waiting is waiting for a session that no longer exists. Failing them is the
    // honest answer; leaving them hanging holds a television's request open forever.
    const waiters = [...dead.waiters.values(), ...dead.subWaiters.values()];
    dead.waiters.clear(); dead.subWaiters.clear();
    for (const list of waiters) for (const w of list) { try { w(false); } catch (e) {} }
    try { fs.rmSync(dead.dir, { recursive: true, force: true }); } catch (e) {}
  }

  // Duration and keyframe times, the two things segmentsFromKeyframes needs. Both come from one
  // ffprobe pass each; the keyframe pass is the slow one and is why this is done ONCE per source
  // and never per segment.
  function probeVodShape(input, cb) {
    let finished = false, child = null;
    const finish = (result) => {
      if (finished) return;
      finished = true;
      child = null;
      cb(result);
    };
    const cancel = () => {
      if (finished) return;
      finished = true;
      const owned = child; child = null;
      if (owned) { try { owned.kill('SIGKILL'); } catch (e) {} }
    };
    let dout = '';
    let dp;
    try {
      dp = spawn(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', input], { timeout: 15000 });
    } catch (e) { finish(null); return cancel; }
    child = dp;
    dp.stdout.on('data', (d) => { dout += d; });
    dp.on('error', () => finish(null));
    dp.once('close', (code) => {
      if (finished) return;
      const dur = parseFloat(String(dout).trim());
      if (code !== 0 || !Number.isFinite(dur) || dur <= 0) return finish(null);
      let out = '', ps;
      try { ps = spawn(FFPROBE, keyframeArgs(input), { timeout: VOD_PROBE_TIMEOUT }); }
      catch (e) { return finish(null); }
      child = ps;
      ps.stdout.on('data', (d) => { out += d; });
      ps.on('error', () => finish(null));
      ps.once('close', (exit) => {
        if (finished) return;
        const keys = parseKeyframes(out);
        finish(exit === 0 && keys.length ? { keys, dur } : null);
      });
    });
    return cancel;
  }

  // serveVod(input, opts, cb) → cb(playlistUrl | null)
  function serveVod(input, opts, cb) {
    const o = opts || {};
    if (!VOD_ENABLED()) return cb(null);
    const lan = lanAddress();
    if (!lan || !input) return cb(null);
    cancelVod();
    const gen = vodGen;
    const complete = cb;
    let finished = false, cancelled = false;
    let cancelTracks = null, cancelShape = null;
    const dispose = (fn) => { if (typeof fn === 'function') { try { fn(); } catch (e) {} } };
    const cancel = () => {
      if (finished) return;
      cancelled = true;
      cb(null, { outcome: 'cancelled' });
      dispose(cancelTracks); dispose(cancelShape);
      cancelTracks = null; cancelShape = null;
    };
    cb = (url, meta) => {
      if (finished) return;
      finished = true;
      vodPreparations.delete(cancel);
      try { complete(url, meta); } catch (e) {}
    };
    vodPreparations.add(cancel);
    const stale = () => cancelled || gen !== vodGen;
    ensure(() => {
      if (stale()) return cb(null, { outcome: 'cancelled' });
      // The eligibility gate FIRST, because it is the cheap probe and the keyframe pass is the
      // expensive one. Every segment here is `-c:v copy`, so a source needing a real transcode has
      // no business on this path — it belongs on live HLS, which exists to do that work.
      cancelTracks = probeTracks(input, (info) => {
        // Superseded while probing. Telling the caller "no VOD playlist" is right: it has already
        // been replaced, and anything built here would be torn down by the newer request anyway.
        if (stale()) { clog('vod: superseded while probing tracks'); return cb(null, { outcome: 'cancelled' }); }
        const plan = planPlayback(info || {}, o.caps, { canTonemap: CAN_TONEMAP });
        const fit = vodEligible(plan, info);
        if (!fit.ok) { clog('vod: declined — ' + fit.why); return cb(null); }
        cancelShape = startVod(input, o, fit, info, stale, cb);
        if (cancelled) { dispose(cancelShape); cancelShape = null; }
      });
      if (cancelled) { dispose(cancelTracks); cancelTracks = null; }
    });
    return cancel;
  }

  function startVod(input, o, fit, info, stale, cb) {
    const lan = lanAddress();
    if (!lan) return cb(null);
    if (VOD_EPOCH_ENABLED()) return startEpochVod(input, o, fit, info, stale, cb);
    // The keyframe pass (`-skip_frame nokey`) decodes nothing but is still a FULL pass over the
    // file: measured at 33.9s on a 2.8 GB 100-minute film, against ~3s for the segmenting itself.
    // It buys exactly one thing — the segment SPANS the on-demand producer cuts to — and the
    // pre-segment path cuts to no spans at all. It hands the whole file to one `-f hls` run, lets
    // ffmpeg pick the boundaries, and serves the playlist ffmpeg writes (serveVodFile's media.m3u8
    // branch), so sess.segments is written and then never read. The only part of `shape` that path
    // does read is the duration, for the subtitle playlists (sess.dur) — and probeTracks has
    // already parsed that from the same format.duration field, at no extra cost.
    //
    // This holds for SPLIT AUDIO too, now that the package pass writes each rendition's playlist as
    // well: serveVodFile serves ffmpeg's aN.m3u8 verbatim, so sess.segments is unread on every
    // branch of the preseg path. It was measured still costing 32.5s on a 5981s two-track source
    // before this covered that case.
    const skipKeyframes = VOD_PRESEG_ENABLED();
    const withShape = (done) => {
      if (!skipKeyframes) return probeVodShape(input, done);
      const d = Number(info && info.dur);
      if (!Number.isFinite(d) || d <= 0) return done(null);
      done({ keys: [], dur: d });
    };
    return withShape((shape) => {
      // The keyframe pass is the long one, so this is where supersession is most likely — and the
      // last point before a directory gets created that nothing would ever clean up.
      if (stale()) { clog('vod: superseded while probing keyframes'); return cb(null); }
      if (!shape || !(shape.dur > 0)) { clog('vod: no duration or no keyframes — not offering a VOD playlist'); return cb(null); }
      const segments = skipKeyframes ? [] : segmentsFromKeyframes(shape.keys, shape.dur, o.segmentSec || DEFAULT_SEGMENT_SEC);
      if (!skipKeyframes && (!segments || !segments.length)) { clog('vod: the keyframes did not divide into segments'); return cb(null); }
      const token = newToken();
      const dir = path.join(vodRoot, token);
      try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { return cb(null); }
      // One rendition per embedded TEXT subtitle track. probeTracks only reports text subtitles —
      // a bitmap track (PGS/VOBSUB) cannot become WebVTT at all and never appears in this list, so
      // there is nothing here to filter out.
      //
      // Capped, for the same measured reason the cast and live-HLS paths are: AVPlayer — which is
      // this route's consumer, main.js hands the /vod/ URL to the AirPlay launch — walks EVERY
      // rendition named in the master before it will show a frame. Offering all 40 renditions of a
      // release made AVFoundation refuse the master outright, status=failed with an EMPTY error log,
      // where the same source at 8 loads and plays. See capSubSources for that measurement and for
      // why the budget is spent primary-language-first rather than one-per-language.
      //
      // The finite playlist does NOT buy an exemption here. It removes the receiver's wait on
      // ENCODING, not its walk of the manifest — the walk happens before a byte of media is asked
      // for. Worth stating because the file this route was developed against has 42 text tracks and
      // played happily on a webOS television with all 42 offered; that is a different receiver, and
      // it is not the one this URL is handed to.
      const allSubs = Array.isArray(info && info.subs) ? info.subs : [];
      const everySub = capSubSources(allSubs);
      if (everySub.length < allSubs.length) {
        clog('vod: offering ' + everySub.length + ' of ' + allSubs.length + ' subtitle renditions (' +
          (allSubs.length - everySub.length) + ' dropped: past the cap AVPlayer will load)');
      }
      const subs = everySub.map((t, i) => {
        const base = 'sub_' + i + '_' + String(t.lang || 'und').replace(/[^a-z0-9]/gi, '');
        return { idx: t.idx, lang: t.lang || 'und', name: t.name || t.lang || ('Subtitle ' + (i + 1)),
          base, vtt: base + '.vtt', playlist: base + '.m3u8' };
      });
      // One rendition per audio track, but ONLY when there is more than one. A single-track film
      // keeps the muxed shape: splitting it would cost a second fetch stream per segment and buy
      // the viewer no choice they did not already have.
      const audio = fit.splitAudio ? (fit.audioTracks || []).map((a, i) => ({
        index: i, lang: a.lang, name: a.name, copy: a.copy !== false,
        playlist: 'audio_' + i + '.m3u8', prefix: 'a' + i + '_',
        default: i === 0
      })) : [];
      vod = { token, input, dir, segments, dur: shape.dur, subs, audio, splitAudio: !!fit.splitAudio,
        copyAudio: fit.copyAudio !== false,
        procs: new Map(), waiters: new Map(), lru: [],
        presegProc: null,
        // One run per variant prefix, when SPRITZ_VOD_RUN is on. Keyed by prefix for the same reason
        // the LRU is: a film with three audio renditions has three segments numbered 12.
        runs: new Map(),
        subProcs: new Map(), subWaiters: new Map() };
      // Captured because the pre-segment handlers below are async: by the time ffmpeg exits, `vod`
      // may already be a different session (a second cast supersedes the first), and acting on it
      // would hand this caller a URL for somebody else's film.
      const sess0 = vod;
      if (VOD_PRESEG_ENABLED()) {
        // Segment everything before the URL is handed out. The receiver must never see a playlist
        // whose segments do not exist yet: this route's whole premise is that a seek to minute 80
        // works on the first request, and a partially written playlist breaks exactly that.
        // Split audio needs picture AND every track out of ONE muxer — see presegmentPackageArgs
        // for why producing them separately is the mistake that caused the livelock. Before this,
        // kind:'video' segmented only the picture while serveVod still advertised an audio_N.m3u8
        // per track, so every aN_*.ts the receiver asked for was a 404.
        const pargs = fit.splitAudio
          ? presegmentPackageArgs({ input, dir, targetSec: DEFAULT_SEGMENT_SEC,
            copyAudio: fit.copyAudio !== false, audioTracks: fit.audioTracks || [] })
          : presegmentArgs({ input, dir, targetSec: DEFAULT_SEGMENT_SEC,
            copyAudio: fit.copyAudio !== false, kind: 'muxed' });
        if (!pargs) { clog('vod: could not build the pre-segment command'); return cb(null); }
        const t0 = Date.now();
        const ff = spawn(FFMPEG, pargs);
        vod.presegProc = ff;
        ff.stderr.on('data', () => {});
        ff.on('error', () => { if (vod === sess0) { clog('vod: pre-segmenting failed to start'); cb(null); } });
        ff.on('close', (code) => {
          if (vod !== sess0) return; // superseded while segmenting — the caller has moved on
          vod.presegProc = null;
          // The package writes the picture's playlist as v.m3u8 (%v expands to the variant name);
          // the single-variant form still writes media.m3u8.
          const plFile = path.join(dir, fit.splitAudio ? 'v.m3u8' : 'media.m3u8');
          if (code !== 0 || !safeStat(plFile)) {
            clog('vod: pre-segmenting failed (exit ' + code + ')');
            return cb(null);
          }
          clog('vod: pre-segmented in ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
          cb('http://' + lan + ':' + port + '/vod/' + token + '/master.m3u8');
        });
        return;
      }
      clog('vod: ' + segments.length + ' segments over ' + Math.round(shape.dur) + 's from ' +
        shape.keys.length + ' keyframes, ' + subs.length + ' subtitle track(s), ' +
        (fit.splitAudio ? audio.length + ' audio renditions' : 'audio muxed in'));
      cb('http://' + lan + ':' + port + '/vod/' + token + '/master.m3u8');
    });
  }

  // Produce segment `index` as part of a RUN — one ffmpeg producing a stretch of consecutive
  // segments, rather than one process per segment. See VOD_RUN_ENABLED above for why.
  //
  // The shape is different from ensureSegment's in one way that matters: a run has no per-segment
  // exit to wait on. It writes its files progressively, so the file for the segment being produced
  // exists on disk while it is still being appended to. runSegmentReady is the rule for telling
  // those apart — serving on existence alone would hand the receiver a truncated segment.
  function ensureSegmentViaRun(sess, index, variant, cb) {
    const v = variant || { kind: sess.splitAudio ? 'video' : 'muxed', prefix: '' };
    const prefix = v.prefix || '';
    const out = segmentPath(sess.dir, index, prefix);
    if (!out) return cb(false);
    const knownRun = sess.runs.get(prefix);
    if (safeStat(out) && runSegmentReady({ index, has: (i) => !!safeStat(segmentPath(sess.dir, i, prefix)),
      runEnded: !!(knownRun && knownRun.completed && index >= knownRun.from && index < knownRun.from + knownRun.count) })) {
      touchSegment(sess, prefix + index, out);
      return cb(true);
    }

    let run = sess.runs.get(prefix);
    const covers = run && index >= run.from && index < run.from + run.count;
    if (!covers) {
      // A seek, or the end of the previous run's stretch. Kill the old one first: leaving it running
      // would keep an ffmpeg producing film nobody is going to watch, which is exactly the waste the
      // on-demand design exists to avoid.
      if (run && run.proc) { run.failed = true; run.completed = false; try { run.proc.kill('SIGKILL'); } catch (e) {} }
      const args = segmentRunArgs({ input: sess.input, spans: sess.segments, fromIndex: index,
        count: VOD_RUN_SEGMENTS, dir: sess.dir, prefix, kind: v.kind, audioTrack: v.audioTrack || 0,
        copyAudio: v.kind === 'audio' ? v.copy !== false : sess.copyAudio });
      if (!args) return cb(false);
      let proc;
      try { proc = spawn(FFMPEG, args); } catch (e) { return cb(false); }
      run = { proc, from: index, count: VOD_RUN_SEGMENTS, failed: false, completed: false };
      sess.runs.set(prefix, run);
      proc.stderr.on('data', () => {});
      proc.on('error', () => { run.failed = true; run.proc = null; });
      proc.on('close', (code) => { run.failed = run.failed || code !== 0; run.completed = !run.failed; run.proc = null; });
    }

    // Wait for the run to get past this segment. Polling rather than watching the directory: the
    // interval is short next to a segment's production time, and fs.watch's behaviour differs enough
    // across platforms that it is not worth the failure mode.
    const started = Date.now();
    let finished = false, timer = null;
    if (!sess.runWaiters) sess.runWaiters = new Set();
    const cancel = () => finish(false);
    const finish = (ready) => {
      if (finished) return;
      finished = true;
      if (timer !== null) clearTimeout(timer);
      sess.runWaiters.delete(cancel);
      cb(ready);
    };
    sess.runWaiters.add(cancel);
    const poll = () => {
      if (finished) return;
      if (vod !== sess) return finish(false);
      const cur = sess.runs.get(prefix);
      if (cur !== run) return finish(false); // superseded by a newer run — the caller will retry
      const ready = runSegmentReady({ index, has: (i) => !!safeStat(segmentPath(sess.dir, i, prefix)),
        runEnded: run.completed });
      if (ready) { touchSegment(sess, prefix + index, out); return finish(true); }
      if (!run.proc) return finish(false); // the run ended without producing it
      if (Date.now() - started > VOD_RUN_TIMEOUT) {
        run.failed = true; run.completed = false;
        const owned = run.proc; run.proc = null;
        if (owned) { try { owned.kill('SIGKILL'); } catch (e) {} }
        return finish(false);
      }
      timer = setTimeout(() => { timer = null; poll(); }, VOD_RUN_POLL_MS);
    };
    poll();
  }

  // Produce segment `index`, or join the production already under way.
  //
  // Two receivers — or one receiver retrying — must not start two ffmpegs writing the same file:
  // they would race on the same path and hand somebody a half-written segment. So a production is
  // registered before it starts and later arrivals wait on it.
  function ensureSegment(sess, index, variant, cb) {
    if (VOD_RUN_ENABLED()) return ensureSegmentViaRun(sess, index, variant, cb);
    const v = variant || { kind: sess.splitAudio ? 'video' : 'muxed', prefix: '' };
    const key = v.prefix + index;
    const out = segmentPath(sess.dir, index, v.prefix);
    if (!out) return cb(false);
    const waiting = sess.waiters.get(key);
    if (waiting) { waiting.push(cb); return; }
    if (safeStat(out)) { touchSegment(sess, key, out); return cb(true); }
    sess.waiters.set(key, [cb]);

    const work = out + '.work-' + crypto.randomBytes(8).toString('hex');
    let finished = false;
    const finish = (ok) => {
      if (finished) return;
      finished = true;
      try { fs.unlinkSync(work); } catch (e) {}
      sess.procs.delete(key);
      const list = sess.waiters.get(key) || [];
      sess.waiters.delete(key);
      if (ok) touchSegment(sess, key, out);
      for (const w of list) { try { w(ok); } catch (e) {} }
    };

    const args = segmentArgs({ input: sess.input, span: sess.segments[index], out: work,
      kind: v.kind, audioTrack: v.audioTrack || 0,
      copyAudio: v.kind === 'audio' ? v.copy !== false : sess.copyAudio });
    if (!args) return finish(false);
    let ff;
    try { ff = spawn(FFMPEG, args); } catch (e) { return finish(false); }
    sess.procs.set(key, ff);
    ff.stderr.on('data', () => {});
    ff.on('error', () => { if (vod === sess) finish(false); });
    ff.on('close', (code) => {
      if (finished) { try { fs.unlinkSync(work); } catch (e) {} return; }
      if (vod !== sess) { try { fs.unlinkSync(work); } catch (e) {} return; } // superseded → drop the orphan
      if (code !== 0 || !safeStat(work)) return finish(false);
      try { fs.renameSync(work, out); } catch (e) { return finish(false); }
      finish(true);
    });
  }

  // Prime the segments after `index`, so the receiver's next request is already on disk.
  //
  // Deliberately AFTER the current segment has been handed to serveFile: the cushion must never
  // delay the thing the viewer is waiting for. Bounded by VOD_READAHEAD and by the end of the film.
  function readAhead(sess, index, variant) {
    for (let i = 1; i <= VOD_READAHEAD; i++) {
      const next = index + i;
      if (next >= sess.segments.length) return;
      ensureSegment(sess, next, variant, () => {});
    }
  }

  // Keep the cache bounded. Most-recently-served at the end; the front is evicted.
  //
  // Keyed by variant, not by index: a film with three audio renditions has three segments numbered
  // 12, and evicting "12" would have to guess which. The cache holds paths so eviction never has to
  // reconstruct one.
  function touchSegment(sess, key, file) {
    const at = sess.lru.findIndex((e) => e.key === key);
    if (at >= 0) sess.lru.splice(at, 1);
    sess.lru.push({ key, file });
    while (sess.lru.length > VOD_CACHE_SEGMENTS) {
      const drop = sess.lru.shift();
      // Never delete something being produced right now; it will fall out of the window on its own
      // next time.
      //
      // NOT guarded against being SERVED, which is a real race — see pipeFile. A guard was written
      // and removed again: no test could be made to discriminate it (a segment small enough to fit
      // the kernel send buffer completes before the eviction runs, so the response is not actually
      // in flight), and unproven concurrency machinery is worse than the smaller proven fix.
      if (sess.procs.has(drop.key) || sess.waiters.has(drop.key)) { sess.lru.push(drop); break; }
      try { fs.unlinkSync(drop.file); } catch (e) {}
    }
  }

  // Extract one subtitle track to WebVTT, on selection.
  //
  // Not up front: each extraction reads the source to EOF, so doing every track eagerly is a
  // disk-I/O storm for tracks nobody asked for — the same conclusion extractSubs reached on the
  // live-HLS path. A player fetches the .vtt only when the viewer picks that subtitle, which makes
  // the request itself the selection signal.
  //
  // De-duplicated exactly like ensureSegment, and for the same reason: two readers of a
  // half-written .vtt is a track that renders as garbage or not at all.
  function ensureSub(sess, sub, cb) {
    const out = path.join(sess.dir, sub.vtt);
    const waiting = sess.subWaiters.get(sub.base);
    if (waiting) { waiting.push(cb); return; }
    if (safeStat(out)) return cb(true);
    sess.subWaiters.set(sub.base, [cb]);
    const work = out + '.work-' + crypto.randomBytes(8).toString('hex');
    let finished = false;
    const finish = (ok) => {
      if (finished) return;
      finished = true;
      try { fs.unlinkSync(work); } catch (e) {}
      sess.subProcs.delete(sub.base);
      const list = sess.subWaiters.get(sub.base) || [];
      sess.subWaiters.delete(sub.base);
      for (const w of list) { try { w(ok); } catch (e) {} }
    };
    const args = subExtractArgs(sess.input, sub.idx, work);
    if (!args) return finish(false);
    let ff;
    try { ff = spawn(FFMPEG, args); } catch (e) { return finish(false); }
    sess.subProcs.set(sub.base, ff);
    ff.stderr.on('data', () => {});
    ff.on('error', () => { if (vod === sess) finish(false); });
    ff.on('close', (code) => {
      if (finished) { try { fs.unlinkSync(work); } catch (e) {} return; }
      if (vod !== sess) { try { fs.unlinkSync(work); } catch (e) {} return; }
      let body = null;
      try { body = fs.readFileSync(work, 'utf8'); } catch (e) {}
      try { fs.unlinkSync(work); } catch (e) {}
      // A non-zero exit may still have produced usable cues; trimming back to the last complete one
      // turns "some subtitles" into a track that renders, where a malformed tail makes a receiver
      // drop the whole thing. Same salvage the live-HLS path performs.
      if (code !== 0) { try { body = trimToCompleteCues(body || ''); } catch (e) { body = null; } }
      if (!body || !/-->/.test(body)) { clog('vod sub ' + sub.base + ': nothing usable extracted'); return finish(false); }
      // ffmpeg's webvtt muxer writes its own WEBVTT line and omits the timestamp map; replace the
      // header wholesale so every track carries the anchor.
      const cues = body.replace(/^WEBVTT[^\n]*\n(?:[^\n]*\n)*?\n/, '');
      try { fs.writeFileSync(out, VTT_HEAD + cues); } catch (e) { return finish(false); }
      finish(true);
    });
  }

  // ---- transport epochs ---------------------------------------------------------------------------
  //
  // A session whose media is a SET of epochs, each one ffmpeg `-f hls` run from a logical position
  // with ffmpeg choosing every cut (transport-epoch.js). The session is the FILM — one token, one
  // directory, one mediaId — and each epoch is a subdirectory of it, so a seek that replaces the
  // transport leaves the session, its token and its URL prefix alone.
  //
  // Subtitle and audio renditions are NOT offered on this path yet: the epoch's media playlist is
  // handed out directly. That is a known limitation of this cycle, not a design.
  function startEpochVod(input, o, fit, info, stale, cb) {
    const lan = lanAddress();
    const d = Number(info && info.dur);
    if (!Number.isFinite(d) || d <= 0) { clog('vod: no duration — not offering epochs'); return cb(null); }
    const token = newToken();
    const dir = path.join(vodRoot, token);
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { return cb(null); }
    const sess = {
      token, input, dir, segments: [], dur: d, subs: [], audio: [], splitAudio: false,
      copyAudio: fit.copyAudio !== false, mediaId: o.mediaId || null,
      procs: new Map(), waiters: new Map(), lru: [], presegProc: null, runs: new Map(),
      subProcs: new Map(), subWaiters: new Map(),
      epochs: null, lingering: new Map() // superseded epoch id -> retire timer
    };
    sess.epochs = createEpochs({
      spawn, ffmpeg: FFMPEG, root: dir, namespace: token,
      onActive: (a) => { try { onProducerActive(a); } catch (e) {} },
      probeFirstPts: probeFirstPts,
      log: (m) => clog('vod epoch: ' + m)
    });
    vod = sess;
    const start = Number.isFinite(o.startSec) && o.startSec > 0 ? o.startSec : 0;
    openEpochAt(sess, start, (e) => {
      if (vod !== sess) return cb(null);
      if (!e) { clog('vod: the first epoch did not produce a playlist'); return cb(null); }
      clog('vod: epoch ' + e.id + ' serving at logical ' + start + 's (clock ' + VOD_EPOCH_CLOCK() + ')');
      cb(epochUrl(lan, sess, e.id), { epoch: e.id, clock: VOD_EPOCH_CLOCK() });
    });
  }
  const epochUrl = (lan, sess, id) => 'http://' + lan + ':' + port + '/vod/' + sess.token + '/' + id + '/media.m3u8';

  // Start one epoch and wait for its playlist to exist. temp_file makes the playlist appear only
  // as a whole, so "exists" is "servable".
  function openEpochAt(sess, logicalStart, cb) {
    const complete = cb;
    let finished = false, pollTimer = null, e = null;
    if (!sess.epochWaiters) sess.epochWaiters = new Set();
    const cancel = () => cb(null);
    cb = (result) => {
      if (finished) return;
      finished = true;
      if (pollTimer !== null) clearTimeout(pollTimer);
      pollTimer = null;
      sess.epochWaiters.delete(cancel);
      if (!result && e) { try { sess.epochs.retire(e.id); } catch (error) {} }
      try { complete(result); } catch (error) {}
    };
    sess.epochWaiters.add(cancel);
    const schedulePoll = () => { pollTimer = setTimeout(() => { pollTimer = null; poll(); }, 100); };
    try {
      e = sess.epochs.open({ mediaId: sess.mediaId || sess.token, input: sess.input, logicalStart, copyAudio: sess.copyAudio, playlistType: VOD_EPOCH_PLAYLIST() });
    } catch (error) { cb(null); return cancel; }
    if (finished) { if (e) { try { sess.epochs.retire(e.id); } catch (error) {} } return cancel; }
    if (!e) { cb(null); return cancel; }
    // The previous current epoch lingers for the handoff, then goes.
    for (const prev of sess.epochs.list()) {
      if (prev.id === e.id || sess.lingering.has(prev.id)) continue;
      const t = setTimeout(() => { sess.lingering.delete(prev.id); if (vod === sess) sess.epochs.retire(prev.id); }, VOD_EPOCH_LINGER_MS);
      if (t.unref) t.unref();
      sess.lingering.set(prev.id, t);
    }
    const t0 = Date.now();
    const poll = () => {
      if (finished) return;
      if (vod !== sess) return cb(null);
      const cur = sess.epochs.get(e.id);
      if (!cur) return cb(null);
      if (safeStat(e.playlist)) {
        // Measure where it actually begins before answering, so the caller can tell the receiver
        // an honest local start. temp_file means 0.ts exists only once it is whole.
        const first = path.join(e.dir, '0.ts');
        if (!safeStat(first)) { if (Date.now() - t0 > VOD_EPOCH_PLAYLIST_TIMEOUT) return cb(null); return schedulePoll(); }
        try {
          return sess.epochs.noteFirstSegment(e.id, first, () => cb(vod === sess ? sess.epochs.get(e.id) : null));
        } catch (error) { return cb(null); }
      }
      if (!cur.running) return cb(null); // ended without ever writing a playlist
      if (Date.now() - t0 > VOD_EPOCH_PLAYLIST_TIMEOUT) return cb(null);
      schedulePoll();
    };
    poll();
    return cancel;
  }

  // How far an epoch has produced, in logical seconds, read from the playlist ffmpeg wrote — the
  // only description that matches the media. Sum of EXTINF from the first playable timestamp.
  function epochCoverage(e) {
    let pl; try { pl = fs.readFileSync(e.playlist, 'utf8'); } catch (er) { return null; }
    let sum = 0;
    for (const m of pl.matchAll(/^#EXTINF:([0-9.]+)/gm)) sum += Number(m[1]);
    const from = Number.isFinite(e.firstPlayableSec) ? e.firstPlayableSec : e.logicalStart;
    return { from, until: from + sum, ended: /#EXT-X-ENDLIST/.test(pl) };
  }

  // A seek to a LOGICAL position. Answers how to get there: inside the current epoch (the receiver
  // is told a local position), or by a new epoch (the receiver is told a new transport).
  function vodSeek(logicalSec, cb) {
    const sess = vod;
    if (!sess || !sess.epochs) return cb(null);
    const cur = sess.epochs.current();
    if (cur) {
      const cov = epochCoverage(cur);
      if (cov) sess.epochs.noteProducedUntil(cur.id, cov.until);
    }
    const plan = planSeek({ epoch: sess.epochs.current(), toLogical: Number(logicalSec), clock: VOD_EPOCH_CLOCK() });
    if (!plan) return cb(null);
    if (plan.kind === 'in-epoch') { clog('vod seek: ' + logicalSec + 's is inside ' + cur.id + ' (local ' + plan.localSec + 's)'); return cb(plan); }
    clog('vod seek: ' + logicalSec + 's needs a new epoch');
    return openEpochAt(sess, plan.logicalStart, (e) => {
      if (!e || vod !== sess) return cb(null);
      const lan = lanAddress();
      cb({ kind: 'new-epoch', epoch: e.id, url: epochUrl(lan, sess, e.id), clock: VOD_EPOCH_CLOCK(),
        startSec: epochToLocal(e, plan.logicalStart, VOD_EPOCH_CLOCK()), firstPlayableSec: e.firstPlayableSec, leadInSec: e.leadInSec });
    });
  }
  // Epoch-local -> logical, for a position the receiver reported in a named epoch.
  function vodLogical(epochId, localSec) {
    const sess = vod;
    const e = sess && sess.epochs && sess.epochs.get(epochId);
    if (!e) return null;
    return epochToLogical(e, localSec, VOD_EPOCH_CLOCK());
  }
  function vodSourceDuration(epochId) {
    const sess = vod;
    if (!sess || !sess.epochs || !sess.epochs.get(epochId)) return null;
    return Number.isFinite(sess.dur) && sess.dur > 0 ? sess.dur : null;
  }
  function vodEpoch() {
    const sess = vod;
    if (!sess || !sess.epochs) return null;
    const cur = sess.epochs.current();
    return { token: sess.token, clock: VOD_EPOCH_CLOCK(), current: cur, epochs: sess.epochs.list(), producerActive: sess.epochs.active() };
  }
  // First timestamp of a segment, via ffprobe. csv rows end in a trailing comma.
  function probeFirstPts(file, cb) {
    let out = '', finished = false, p;
    const finish = (pts) => { if (finished) return; finished = true; cb(pts); };
    try {
      p = spawn(FFPROBE, ['-v', 'error', '-protocol_whitelist', 'file,concat', '-select_streams', 'v:0', '-show_entries', 'packet=pts_time', '-read_intervals', '%+#1', '-of', 'csv=p=0', file], { timeout: 5000 });
    } catch (e) { finish(null); return () => {}; }
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', () => {});
    p.on('error', () => finish(null));
    p.on('close', (code) => {
      const value = String(out).trim().split('\n')[0].split(',')[0];
      const n = Number(value);
      finish(code === 0 && value !== '' && Number.isFinite(n) ? n : null);
    });
    return () => { if (finished) return; finished = true; try { p.kill('SIGKILL'); } catch (e) {} };
  }
  function serveEpochFile(req, res, sess, epochId, file) {
    const e = sess.epochs.get(epochId);
    if (!e) { res.writeHead(404); res.end(); return; }
    if (!/^[A-Za-z0-9_.-]+$/.test(file) || file.includes('..')) { res.writeHead(404); res.end(); return; }
    const f = path.join(e.dir, file);
    if (!safeStat(f)) { res.writeHead(404); res.end(); return; }
    if (file === '0.ts') sess.epochs.noteFirstSegment(e.id, f);
    if (file === 'media.m3u8') {
      const cov = epochCoverage(e);
      if (cov) sess.epochs.noteProducedUntil(e.id, cov.until);
    }
    return serveFile(req, res, f);
  }

  function serveVodFile(req, res, token, name) {
    const sess = vod;
    // A stale token is a receiver still fetching the previous film. 404 is right and the receiver
    // stops; serving it segments of whatever is playing now would be worse than failing.
    if (!sess || token !== sess.token) { res.writeHead(404); res.end(); return; }
    const em = /^(epoch-[A-Za-z0-9_-]+)\/([^/]+)$/.exec(name);
    if (em) { if (!sess.epochs) { res.writeHead(404); res.end(); return; } return serveEpochFile(req, res, sess, em[1], em[2]); }
    const sendText = (body, type) => {
      res.writeHead(200, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(body),
        'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Range' });
      res.end(req.method === 'HEAD' ? undefined : body);
    };
    if (name === 'master.m3u8') {
      const master = buildVodMaster({ mediaUrl: 'media.m3u8', subs: sess.subs, audio: sess.audio });
      if (!master) { res.writeHead(500); res.end(); return; }
      return sendText(master, 'application/vnd.apple.mpegurl');
    }
    const subPl = sess.subs.find((x) => x.playlist === name);
    if (subPl) {
      const pl = subPlaylist(subPl.vtt, sess.dur);
      if (!pl) { res.writeHead(500); res.end(); return; }
      return sendText(pl, 'application/vnd.apple.mpegurl');
    }
    const subVtt = sess.subs.find((x) => x.vtt === name);
    if (subVtt) {
      return ensureSub(sess, subVtt, (ok) => {
        if (vod !== sess) { try { res.writeHead(404); } catch (e) {} return res.end(); }
        // An empty-but-valid track rather than an error: a 500 makes the receiver drop the
        // rendition and often the whole master, where a track with no cues simply shows nothing.
        if (!ok) return sendText(VTT_HEAD, 'text/vtt');
        serveFile(req, res, path.join(sess.dir, subVtt.vtt));
      });
    }
    if (name === 'media.m3u8') {
      // Pre-segmented: ffmpeg wrote the playlist, and it is the ONLY description of the media that
      // matches it. Building our own here would reintroduce the mismatch this change removes —
      // ffmpeg's boundaries are its own, and the whole point is that the playlist follows them.
      if (VOD_PRESEG_ENABLED()) {
        const plFile = path.join(sess.dir, sess.splitAudio ? 'v.m3u8' : 'media.m3u8');
        if (!safeStat(plFile)) { res.writeHead(404); return res.end(); }
        return serveFile(req, res, plFile);
      }
      const pl = buildVodPlaylistFromSegments({ segments: sess.segments, urlFor: (i) => String(i) + '.ts' });
      if (!pl) { res.writeHead(500); res.end(); return; }
      return sendText(pl, 'application/vnd.apple.mpegurl');
    }
    // An audio rendition's playlist. Same segment boundaries as the video, so switching language
    // lands at the same point in the film rather than near it.
    const aud = sess.audio.find((a) => a.playlist === name);
    if (aud && VOD_PRESEG_ENABLED()) {
      // ffmpeg wrote this rendition's playlist in the same pass as the picture's, so it is the only
      // description whose boundaries actually match the segments on disk. Rebuilding it from
      // sess.segments would reassert spans this media does not have.
      const plFile = path.join(sess.dir, 'a' + aud.index + '.m3u8');
      if (!safeStat(plFile)) { res.writeHead(404); return res.end(); }
      return serveFile(req, res, plFile);
    }
    if (aud) {
      const pl = buildVodPlaylistFromSegments({ segments: sess.segments, urlFor: (i) => aud.prefix + i + '.ts' });
      if (!pl) { res.writeHead(500); res.end(); return; }
      return sendText(pl, 'application/vnd.apple.mpegurl');
    }
    // A segment: bare index for the picture, prefixed for an audio rendition.
    let variant = null, index = -1;
    // A package names the picture's segments v_<i>.ts, because -var_stream_map expands %v into
    // every filename it writes. The single-variant form keeps the bare index.
    const pvm = /^v_(\d+)\.ts$/.exec(name);
    const vm = /^(\d+)\.ts$/.exec(name);
    if (pvm && VOD_PRESEG_ENABLED() && sess.splitAudio) {
      variant = { kind: 'video', prefix: 'v_' };
      index = Number(pvm[1]);
    } else if (vm) {
      variant = { kind: sess.splitAudio ? 'video' : 'muxed', prefix: '' };
      index = Number(vm[1]);
    } else {
      const am = /^a(\d+)_(\d+)\.ts$/.exec(name);
      const track = am && sess.audio[Number(am[1])];
      if (track) { variant = { kind: 'audio', prefix: track.prefix, audioTrack: track.index, copy: track.copy }; index = Number(am[2]); }
    }
    if (!variant) { res.writeHead(404); res.end(); return; }
    // Pre-segmented: everything already exists on disk, so there is nothing to produce, nothing to
    // wait on, and nothing to prime. The index bound comes from the playlist ffmpeg wrote rather
    // than from sess.segments, which describes boundaries this media does not have.
    if (VOD_PRESEG_ENABLED()) {
      const f = segmentPath(sess.dir, index, variant.prefix);
      if (!Number.isInteger(index) || index < 0 || !f || !safeStat(f)) { res.writeHead(404); res.end(); return; }
      return serveFile(req, res, f);
    }
    if (!Number.isInteger(index) || index < 0 || index >= sess.segments.length) { res.writeHead(404); res.end(); return; }
    ensureSegment(sess, index, variant, (ok) => {
      if (vod !== sess) { try { res.writeHead(404); } catch (e) {} return res.end(); }
      if (!ok) { clog('vod: segment ' + name + ' could not be produced'); try { res.writeHead(500); } catch (e) {} return res.end(); }
      serveFile(req, res, segmentPath(sess.dir, index, variant.prefix));
      // Start the NEXT segments while this one is being sent. Fire-and-forget: nothing waits on
      // them, an already-cached one returns immediately, and ensureSegment's de-duplication means a
      // read-ahead racing the receiver's own request for the same segment produces one ffmpeg, not
      // two. Same variant, so an audio rendition primes its own track rather than the picture's.
      readAhead(sess, index, variant);
    });
  }

  function cancelActive() { cancelDirectSubJobs(); cancelTokenRegistrations(); cancelDirectPreparations(); cancelProxyRequests(); cancelHls(); cancelRemux(); cancelVod(); cancelMkv('cancelActive — the source changed or casting stopped'); files.clear(); dlnaProxies.clear(); }

  return { retireReceiverHls: cancelHls, serve, serveDlna, serveSource, serveSubtitleForDlna, prepareCast, serveHls, serveMkv, serveVod, cancelVod, teardown, cancelActive, lanAddress, avCompatible,
    // Transport epochs (SPRITZ_VOD_EPOCH=1): seek by logical position, map a reported position back.
    vodSeek, vodLogical, vodSourceDuration, vodEpoch,
    // Where the AirPlay player is. Only the orchestrator sees AVPlayer's clock, and only this module
    // knows when a subtitle extractor is about to choose where to start reading.
    noteAirplayPosition: (sec) => { if (typeof sec === 'number' && sec >= 0) airplayPos = sec; },
    // The live AirPlay media playlist (video variant), so a handoff can see the real segment
    // boundaries — they follow the source's keyframes in a stream copy. null when there is none.
    airplayMediaPlaylist: () => {
      if (!hlsDir) return null;
      for (const f of [path.join(hlsDir, 'stream_0', 'index.m3u8'), path.join(hlsDir, 'index.m3u8')]) {
        try { return fs.readFileSync(f, 'utf8'); } catch (e) {}
      }
      return null;
    },
    // The container this route actually serves. What the receiver is told must agree with what the
    // socket delivers, so it is read from here rather than written out again at each call site —
    // where it had already drifted to a hardcoded Matroska type in one place and video/mp4 in another.
    castMime: () => MKV_MIME,
    // Film time at which the live cast pipe's clock reads zero (see resolveOrigin); 0 when nothing is streaming.
    castOrigin: () => (mkvEntry && Number.isFinite(mkvEntry.origin) ? mkvEntry.origin : 0),
    // The receiver's live position, pushed in from the cast status stream. Only the orchestrator sees
    // those updates, and only this module knows when a stream is being restarted — so the number has
    // to cross over.
    noteCastPosition: (sec) => { if (mkvEntry && Number.isFinite(sec) && sec > 0) mkvEntry.livePos = sec; },
    suspendAirplayPrep, resumeAirplayPrep, holdReadyAirplayPrep,
    // Is a cast stream being served right now? Recovery asks, because the receiver often re-requests
    // the URL on its own — and re-casting on top of a stream that is already flowing tears down a
    // working one and costs the viewer a visible bounce.
    hasLiveCastStream: () => !!(mkvProc && mkvRes),
    serverPort: () => (server && server.listening ? port : null), // diagnostics: where receivers are pointed
    // The receiver control channel attaches to this server's `upgrade` event; see onServer above.
    onServer,
    ensureServer: (cb) => ensure(() => cb(server)) };
};

function safeStat(f) { try { const s = fs.statSync(f); return s.isFile() ? s : null; } catch (e) { return null; } }
// Shift every WebVTT cue timestamp (HH:MM:SS.mmm) by deltaSec (may be negative) — the cast subtitle
// sync control: a positive delta makes subs appear later, negative earlier. Rewrites the file in place.
function shiftVtt(file, deltaSec) {
  if (!deltaSec) return;
  try {
    const p2 = (n) => String(n).padStart(2, '0'), p3 = (n) => String(n).padStart(3, '0');
    const txt = fs.readFileSync(file, 'utf8').replace(/(\d{2}):(\d{2}):(\d{2})\.(\d{3})/g, (m, h, mi, s, ms) => {
      let total = Math.round(((+h) * 3600 + (+mi) * 60 + (+s)) * 1000 + (+ms) + deltaSec * 1000);
      if (total < 0) total = 0;
      const msv = total % 1000; total = Math.floor(total / 1000);
      const ss = total % 60; total = Math.floor(total / 60);
      const mm = total % 60, hh = Math.floor(total / 60);
      return p2(hh) + ':' + p2(mm) + ':' + p2(ss) + '.' + p3(msv);
    });
    fs.writeFileSync(file, txt);
  } catch (e) {}
}
function countSegs(dir) { // count .m4s segments (recursively) — drives the HLS readiness/progress check
  let n = 0;
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) n += countSegs(path.join(dir, e.name));
      else if (e.name.endsWith('.m4s')) n++;
    }
  } catch (e) {}
  return n;
}

// Exported for the regression test. This string decides whether a Dolby Vision file gets a cheap
// copy or a needless 4K re-encode, and when a field is missing from it nothing errors — the picture
// just never arrives. Worth pinning.
module.exports.PROBE_ENTRIES = PROBE_ENTRIES;

// Exported for the regression test. How many subtitle renditions a streamed source advertises is not
// cosmetic: AVPlayer fetches every one before it will show a frame, and eighteen of them timed the
// load out entirely.
module.exports.capSubSources = capSubSources;
module.exports.MAX_REMOTE_SIDELOAD_SUBS = MAX_REMOTE_SIDELOAD_SUBS;
// Exported so the eviction test asserts against the real bound rather than a second copy of it
// that could drift away from the one the cache actually uses.
module.exports.VOD_CACHE_SEGMENTS = VOD_CACHE_SEGMENTS;
// Exported so the observation test asserts against the real coalescing window.
module.exports.SOURCE_READ_COALESCE_BYTES = SOURCE_READ_COALESCE_BYTES;

// Exported for the regression test. This decides whether AirPlay reaches for 4K, and the two ways it
// can be wrong are both expensive: taking a 4K TRANSCODE makes a playable source uncastable, and
// taking a 1080p HEVC HDR10 COPY reproduces "enters AirPlay mode, never plays".
module.exports.decide4k = decide4k;

// Exported for the regression test. A failed probe must never be allowed to overwrite a good reading
// of the same source: that is the difference between a stream copy and a blind 4K re-encode.
module.exports._probeMemory = { rememberProbe, recallProbe, memoProbe };

// Exported for the regression test. Getting this wrong is silent: return the wrong index and the
// viewer gets a track they did not ask for, return the first by default and the signs-only track
// shadows the real dialogue exactly as it did before extraction-on-selection.
module.exports.pickActiveSub = pickActiveSub;

// Which sideloaded subtitle the RECEIVER currently has on, as an index into the offered text tracks
// (-1 = none), given what it reported and what we already believe. Returns null for "no change".
// Pure, and exported, because getting it wrong loops: react to the empty track list a re-cast
// reports mid-load and you set the pick back to -1, which re-casts, which reports empty again.
function receiverSubPick(activeTrackIds, count, current) {
  if (!Array.isArray(activeTrackIds) || !(count > 0)) return null;
  const mine = activeTrackIds.filter((id) => id >= 1000 && id < 1000 + count);
  const want = mine.length ? mine[0] - 1000 : -1;
  const have = (current != null) ? current : -1;
  return want === have ? null : want;
}
module.exports.receiverSubPick = receiverSubPick;

// Exported for the regression test. A subtitle rendition whose discontinuity sequence disagrees with
// its variant makes AVPlayer reject the entire stream, so this must mirror ffmpeg, never guess.
module.exports.opensWithDiscontinuity = opensWithDiscontinuity;

// Exported for the regression test. The AirPlay downscale box: a height-only cap let a 2:1 source out
// at 2160x1080, which this receiver accepted and then could not decode.
function airplayScaleBox(capH, srcW, srcH) {
  const capW = Math.round((capH * 16 / 9) / 2) * 2;
  const boxH = Math.min(capH, srcH || capH);   // never upscale a source shorter than the cap
  const need = !!(srcH && capH && (capH < srcH || (srcW && capW && srcW > capW)));
  if (!need) return { scale: false, w: srcW || 0, h: srcH || 0 };
  const f = Math.min(capW / srcW, boxH / srcH);
  return { scale: true, w: Math.round(srcW * f / 2) * 2, h: Math.round(srcH * f / 2) * 2 };
}
module.exports.airplayScaleBox = airplayScaleBox;

// Exported for the regression test. Must live at the END of the file: module.exports is REASSIGNED to
// createLanServer partway down, so anything attached before that point is silently discarded.
module.exports.minimalStreamInf = minimalStreamInf;
module.exports.minimalMaster = minimalMaster;
module.exports.servedMaster = servedMaster;
module.exports.isCompleteMaster = isCompleteMaster;
module.exports.canSynthesizeMaster = canSynthesizeMaster;
module.exports.masterWithSubs = masterWithSubs;
module.exports.CAST_PIPE_MUXFLAGS = CAST_PIPE_MUXFLAGS;
module.exports.lastKeyframeAtOrBefore = lastKeyframeAtOrBefore;
module.exports.castSeekArgs = castSeekArgs;
module.exports.subSeekArgs = subSeekArgs;
module.exports.CAST_HYGIENE = CAST_HYGIENE;
module.exports.keyframeProbeArgs = keyframeProbeArgs;
