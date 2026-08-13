'use strict';

// Given a file and a receiver, decide what has to happen to play it.
//
// This decision already existed — twice, in lanserver.js, once around line 646 for the HLS path and
// again in mkvArgs around line 823. The two copies had drifted apart in wording but not yet in
// behaviour, which is the usual precursor to drifting in behaviour. Both were tangled up with
// building ffmpeg argument arrays, so neither could be exercised without spawning ffmpeg and
// pointing it at a real file, which is why neither ever was.
//
// So this is an EXTRACTION, not a redesign. Every rule below is ported from those two sites,
// including the comments explaining the failures that produced them. The value is not new
// cleverness: it is that "will this file play on that television" becomes a pure function that
// answers in microseconds instead of a trip to the living room.
//
// The plan also carries `reasons` — the decision has always been explicable, it just never
// explained itself. That is what lets the UI say "only the audio is being converted" instead of
// showing a spinner and hoping.

const { normalise } = require('./device-profile');

// Codecs the cast receivers (AVPlayer, Google Cast default receiver) reliably decode in an MP4/HLS
// container. VP9/AV1 are decodable by modern receivers but NOT muxable into fMP4 the way Apple and
// Cast want, so they still need a transcode on this path — the DLNA route serves the original file
// and lets the TV decode natively, which is preferred where it is available.
const FMP4_VIDEO = new Set(['h264', 'hevc']);

// Above this, treat the source as "4K-ish". 1088 not 1080: some encodes are 1088 tall from
// macroblock padding and must not be mistaken for 4K.
const TALL = 1088;

// actions
const VIDEO_COPY = 'copy';
const VIDEO_TRANSCODE = 'transcode';
const AUDIO_COPY = 'copy';
const AUDIO_TRANSCODE = 'transcode';

function planPlayback(media, device, opts) {
  const caps = normalise(device);
  const o = opts || {};
  const canTonemap = o.canTonemap !== false;   // whether ffmpeg has zscale+tonemap
  const reasons = [];
  const m = media || {};

  // A missing codec means the probe was inconclusive — a just-started torrent, typically. The
  // historical behaviour is to assume copy for the VIDEO and let the software-encoder fallback
  // rescue it if the codec turns out to be uncopyable. Preserved deliberately: refusing to start is
  // worse than starting and adapting.
  //
  // What is NOT preserved is throwing away the rest of the probe record. `vcodec` being null is the
  // audio-only / video-stream-not-yet-seen case: height, hdr and the audio track list are all
  // populated and the shipped pipeline acts on them (audioArgs re-encodes a TrueHD track to AAC
  // whether or not the video codec is known). An earlier version of this function returned a stub
  // here, which claimed lossless passthrough of tracks ffmpeg was about to re-encode and left
  // `audioTracks` undefined for callers to trip over.
  const speculative = !m.vcodec;
  if (speculative) {
    reasons.push('Source not probed yet — starting optimistically, will fall back if needed.');
  }

  const height = m.height || 0;
  const tooTall = height > TALL;
  const isHevc = m.vcodec === 'hevc';
  const isH264 = m.vcodec === 'h264';
  const hdrSource = !!m.hdr;

  // ---- video ----
  let canCopyVideo = speculative;
  if (isHevc) canCopyVideo = caps.hevc && (tooTall ? caps.hevc4k : true);
  else if (isH264) canCopyVideo = tooTall ? caps.h264_4k : true;

  // DELIBERATE DIVERGENCE FROM THE SHIPPED CODE (a bug fix, not an extraction).
  // The shipped sites decide copy-eligibility from the booleans hevc4k/h264_4k plus the 1088
  // threshold, none of which can tell 2160 from 4320. A receiver that reports maxHeight 2160 and
  // h264_4k:true therefore gets an 8K bitstream copied straight to it and fails to decode — a black
  // screen the HLS sw-retry ladder cannot rescue, because from ffmpeg's point of view the copy
  // succeeded. So refuse the copy above the receiver's stated limit and let it be scaled.
  // The limit is max(cap, TALL) rather than cap, because the 1088 tolerance is deliberate: a
  // mod-16-padded 1080p encode must stay copy-eligible on a 1080p receiver.
  const copyHeightLimit = Math.max(caps.maxHeight || 1080, TALL);
  // Not applied to the unprobed case: there the optimism is the whole point, the sw fallback is the
  // safety net, and the height on an unprobed record is not yet trustworthy either.
  if (canCopyVideo && !speculative && height > copyHeightLimit) canCopyVideo = false;

  // The caller has already committed to an encode and is asking what that encode must look like:
  // the software-encoder retry after a copy attempt failed, or a burn-in overlay, which is
  // incompatible with `-c:v copy`. The copy/transcode question is then not ours to answer, but
  // everything downstream of it — scale, tonemap, whether HDR survives — still is, and must answer
  // for the ENCODE. Without this the sw fallback would inherit the copy path's answers (no scale,
  // HDR "preserved") and emit a stream the receiver cannot decode.
  if (o.forceTranscode) canCopyVideo = false;

  if (m.vcodec && !FMP4_VIDEO.has(m.vcodec)) {
    reasons.push(String(m.vcodec).toUpperCase() + ' cannot be packaged for this receiver — re-encoding video.');
  } else if (!canCopyVideo && isHevc && !caps.hevc) {
    reasons.push('Receiver does not decode HEVC — re-encoding to H.264.');
  } else if (!canCopyVideo && tooTall) {
    reasons.push('Receiver is limited to ' + caps.maxHeight + 'p — re-encoding.');
  }

  // HDR can only be copied to a receiver that does HDR10; otherwise it is tonemapped to SDR, or it
  // arrives washed-out and too dark.
  if (hdrSource && !caps.hdr10) canCopyVideo = false;

  const video = canCopyVideo ? VIDEO_COPY : VIDEO_TRANSCODE;

  // Everything below is a property of the ENCODE, so it is conditioned on there being one. On the
  // copy path ffmpeg is handed `-c:v copy` and returns before any filter or pixel-format flag is
  // built: no scaling, no tonemapping, the HDR metadata rides along in the bitstream. Computing
  // these fields independently of the copy/transcode outcome produced self-contradictory plans —
  // `video:'copy'` alongside `tonemap:true`, which is not a producible ffmpeg command.
  //
  // HDR10 output is HEVC, so keep HDR only if the receiver displays HDR10 AND decodes HEVC. A
  // receiver that reports HDR10 but is H.264-only (a plain Cast dongle) would otherwise get an
  // undecodable HEVC stream with no fallback. That is an ENCODER-side constraint: an H.264 HDR
  // source being copied to that same dongle passes through untouched and displays correctly.
  const keepHdr = video === VIDEO_TRANSCODE
    ? hdrSource && caps.hdr10 && caps.hevc
    : hdrSource;
  const needTonemap = video === VIDEO_TRANSCODE && hdrSource && !keepHdr;

  // Stated whenever the encode tonemaps. This used to be reported only when the video would
  // OTHERWISE have been copied, so a file that was already being re-encoded for some other reason
  // got tonemapped in silence — the plan did the right thing and could not say so, which defeats
  // the point of carrying reasons at all.
  if (needTonemap) {
    reasons.push(caps.hdr10
      ? 'Receiver cannot decode HDR video — converting to SDR.'
      : 'Receiver cannot display HDR — converting to SDR.');
  }

  if (needTonemap && !canTonemap) {
    reasons.push('HDR conversion is approximate — this build of ffmpeg lacks zscale.');
  }

  // Downscale only ABOVE the receiver's limit, and scale TO that limit — a 4K-capable receiver
  // keeps 4K rather than being forced to 1080p.
  // Only the encode can scale, so `targetHeight` is the source height whenever the video is copied
  // — including the 1088 case, where the copy threshold (>1088) and the scale threshold (>1080)
  // deliberately disagree and 1088 goes out on the wire as 1088.
  const cap = caps.maxHeight || 1080;
  const needScale = video === VIDEO_TRANSCODE && height > cap;
  const targetHeight = needScale ? cap : (height || null);
  if (needScale) {
    reasons.push('Downscaling ' + height + 'p to ' + cap + 'p for this receiver.');
  }

  if (video === VIDEO_COPY) {
    reasons.push('Video is sent untouched' + (hdrSource && keepHdr ? ', HDR preserved.' : '.'));
  }

  // ---- audio ----
  // Per track: copy when the receiver takes that codec as passthrough, else AAC. Copying matters
  // for surround — a forced AAC stereo downmix destroys 5.1/7.1.
  const tracks = Array.isArray(m.audio) ? m.audio : [];
  const audioTracks = tracks.map((a) => {
    const copy = caps.audioCopy.includes(String(a.codec || '').toLowerCase());
    return { codec: a.codec, channels: a.channels || 2, action: copy ? AUDIO_COPY : AUDIO_TRANSCODE,
      bitrate: copy ? null : ((a.channels || 2) > 2 ? '384k' : '160k') };
  });
  const anyAudioTranscode = audioTracks.some((a) => a.action === AUDIO_TRANSCODE);
  const audio = tracks.length === 0 ? AUDIO_TRANSCODE
    : anyAudioTranscode ? AUDIO_TRANSCODE : AUDIO_COPY;

  if (tracks.length && anyAudioTranscode) {
    const bad = audioTracks.filter((a) => a.action === AUDIO_TRANSCODE).map((a) => a.codec);
    reasons.push('Receiver does not support ' + [...new Set(bad)].join('/') + ' — converting audio to AAC.');
  } else if (tracks.length) {
    reasons.push('Audio is sent untouched' + (audioTracks.some((a) => a.channels > 2) ? ', surround preserved.' : '.'));
  }

  // ---- subtitles ----
  // Text tracks become WebVTT and are sideloaded. Bitmap tracks (PGS/VOBSUB) cannot, so they are
  // either burned into the video or left to a DLNA receiver that renders them itself.
  const subs = Array.isArray(m.subs) ? m.subs : [];
  const subtitles = subs.map((s) => ({
    ...s,
    action: s.bitmap ? (o.canBurnIn === false ? 'unavailable' : 'burn') : 'sideload-webvtt'
  }));
  if (subs.some((s) => s.bitmap) && o.canBurnIn === false) {
    reasons.push('Image-based subtitles cannot be shown on this route.');
  }

  return {
    video,
    audio,
    audioTracks,
    subtitles,
    targetHeight,
    hdr: keepHdr ? 'preserve' : hdrSource ? 'tonemap' : 'none',
    tonemap: needTonemap,
    tonemapAccurate: needTonemap ? canTonemap : null,
    container: 'fmp4',
    speculative,
    profileSource: caps.source,
    // Whether anything at all is being re-encoded — the cheap "is this lossless" question callers
    // keep asking.
    lossless: video === VIDEO_COPY && audio === AUDIO_COPY,
    reasons
  };
}

// A one-line, non-technical version for the UI.
function explain(plan) {
  if (!plan) return '';
  if (plan.speculative) return 'Starting playback…';
  if (plan.lossless) return 'Playing the original video and audio untouched.';
  if (plan.video === VIDEO_COPY) return 'Playing the original video; only the audio is being converted.';
  if (plan.audio === AUDIO_COPY) return 'Converting the video for this device; audio is untouched.';
  return 'Converting this file for your device.';
}

module.exports = { planPlayback, explain, FMP4_VIDEO, TALL };
