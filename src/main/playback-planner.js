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

  // A null descriptor means the probe was inconclusive — a just-started torrent, typically. The
  // historical behaviour is to assume copy and let the software-encoder fallback rescue it if the
  // codec turns out to be uncopyable. Preserved deliberately: refusing to start is worse than
  // starting and adapting.
  if (!media || !media.vcodec) {
    reasons.push('Source not probed yet — starting optimistically, will fall back if needed.');
    return {
      video: VIDEO_COPY, audio: AUDIO_COPY, targetHeight: null,
      hdr: 'unknown', tonemap: false, container: 'fmp4', speculative: true,
      profileSource: caps.source, reasons
    };
  }

  const height = media.height || 0;
  const tooTall = height > TALL;
  const isHevc = media.vcodec === 'hevc';
  const isH264 = media.vcodec === 'h264';
  const hdrSource = !!media.hdr;

  // ---- video ----
  let canCopyVideo = false;
  if (isHevc) canCopyVideo = caps.hevc && (tooTall ? caps.hevc4k : true);
  else if (isH264) canCopyVideo = tooTall ? caps.h264_4k : true;

  if (!FMP4_VIDEO.has(media.vcodec)) {
    reasons.push(media.vcodec.toUpperCase() + ' cannot be packaged for this receiver — re-encoding video.');
  } else if (!canCopyVideo && isHevc && !caps.hevc) {
    reasons.push('Receiver does not decode HEVC — re-encoding to H.264.');
  } else if (!canCopyVideo && tooTall) {
    reasons.push('Receiver is limited to ' + caps.maxHeight + 'p — re-encoding.');
  }

  // HDR can only be copied to a receiver that does HDR10; otherwise it is tonemapped to SDR, or it
  // arrives washed-out and too dark.
  if (hdrSource && !caps.hdr10) canCopyVideo = false;

  // HDR10 output is HEVC, so keep HDR only if the receiver displays HDR10 AND decodes HEVC. A
  // receiver that reports HDR10 but is H.264-only (a plain Cast dongle) would otherwise get an
  // undecodable HEVC stream with no fallback.
  const keepHdr = hdrSource && caps.hdr10 && caps.hevc;
  const needTonemap = hdrSource && !keepHdr;

  // Stated unconditionally. This used to be reported only when the video would OTHERWISE have been
  // copied, so a file that was already being re-encoded for some other reason got tonemapped in
  // silence — the plan did the right thing and could not say so, which defeats the point of
  // carrying reasons at all.
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
  const cap = caps.maxHeight || 1080;
  const targetHeight = height && height > cap ? cap : (height || null);
  if (targetHeight && height > cap) {
    reasons.push('Downscaling ' + height + 'p to ' + cap + 'p for this receiver.');
  }

  const video = canCopyVideo ? VIDEO_COPY : VIDEO_TRANSCODE;
  if (video === VIDEO_COPY) {
    reasons.push('Video is sent untouched' + (hdrSource && keepHdr ? ', HDR preserved.' : '.'));
  }

  // ---- audio ----
  // Per track: copy when the receiver takes that codec as passthrough, else AAC. Copying matters
  // for surround — a forced AAC stereo downmix destroys 5.1/7.1.
  const tracks = Array.isArray(media.audio) ? media.audio : [];
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
  const subs = Array.isArray(media.subs) ? media.subs : [];
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
    speculative: false,
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
