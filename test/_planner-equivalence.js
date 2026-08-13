'use strict';
// TEMPORARY differential proof harness — NOT a permanent test (underscore prefix keeps it out of
// npm test). Compares src/main/playback-planner.js against a VERBATIM transcription of the two
// shipped decision sites in src/main/lanserver.js.
//   node test/_planner-equivalence.js

const { planPlayback } = require('../src/main/playback-planner');

// ───────────────────────── ORACLE: verbatim from lanserver.js ─────────────────────────
// lanserver.js:68/72
const AUDIO_OK = new Set(['aac', 'mp3', 'alac']);
const AUDIO_PASSTHROUGH = new Set(['aac', 'mp3', 'alac', 'ac3', 'eac3']);
// lanserver.js:119-120
const CAPS_CONSERVATIVE = { hevc: true, hevc4k: false, h264_4k: false, hdr10: true, dovi: false, audioCopy: AUDIO_OK, maxHeight: 1080 };
// lanserver.js:121-129
function normCaps(caps) {
  if (!caps) return CAPS_CONSERVATIVE;
  return {
    hevc: caps.hevc !== false, hevc4k: !!caps.hevc4k, h264_4k: !!caps.h264_4k,
    hdr10: caps.hdr10 !== false, dovi: !!caps.dovi,
    audioCopy: caps.audioCopy instanceof Set ? caps.audioCopy : new Set(caps.audioCopy || AUDIO_OK),
    maxHeight: caps.maxHeight || 1080
  };
}
const CAN_TONEMAP = false; // shipped bundled ffmpeg has no zscale/tonemap

// SITE A — serveHls, lanserver.js 646-661 + audioArgs 673-683 + videoArgs 688-717 + primaryMode 738
function oracleHls(info, capsRaw) {
  const caps = normCaps(capsRaw);
  const tooTall = !!(info && info.height > 1088);
  const isHevc = !!(info && info.vcodec === 'hevc');
  const isH264 = !!(info && info.vcodec === 'h264');
  let canCopyVideo = false;
  if (info && info.vcodec) {
    if (isHevc) canCopyVideo = caps.hevc && (tooTall ? caps.hevc4k : true);
    else if (isH264) canCopyVideo = tooTall ? caps.h264_4k : true;
  }
  if (info && info.hdr && !caps.hdr10) canCopyVideo = false;
  const transcode = !!(info && info.vcodec) && !canCopyVideo;

  function audioArgs() {
    if (!info || !info.audio.length) return ['-c:a', 'aac'];
    const out = [];
    info.audio.forEach((a, i) => {
      if (caps.audioCopy.has(a.codec)) out.push(`-c:a:${i}`, 'copy');
      else out.push(`-c:a:${i}`, 'aac', `-b:a:${i}`, a.channels > 2 ? '384k' : '160k');
    });
    return out;
  }
  function videoArgs(mode) {
    const hdr = !!(info && info.hdr && caps.hdr10 && caps.hevc);
    const cap = caps.maxHeight || 1080;
    const needScale = !!(info && info.height && info.height > cap);
    const scaleExpr = 'scale=-2:' + cap;
    const scale = needScale ? ['-vf', scaleExpr] : [];
    if (mode === 'copy') return ['-c:v', 'copy', ...(isHevc ? ['-tag:v', 'hvc1'] : [])];
    if (hdr) {
      const enc = mode === 'sw' ? ['-c:v', 'libx265', '-preset', 'fast', '-crf', '20'] : ['-c:v', 'hevc_videotoolbox', '-prio_speed', '1', '-b:v', '10M', '-maxrate', '14M', '-bufsize', '20M'];
      return [...scale, ...enc, '-tag:v', 'hvc1', '-pix_fmt', 'p010le',
        '-color_primaries', 'bt2020', '-color_trc', 'smpte2084', '-colorspace', 'bt2020nc', '-color_range', 'tv'];
    }
    const needTonemap = !!(info && info.hdr && !(caps.hdr10 && caps.hevc));
    const vf = needTonemap && CAN_TONEMAP
      ? ['-vf', (needScale ? scaleExpr + ',' : '') + 'zscale=...']
      : scale;
    const enc = mode === 'sw' ? ['-c:v', 'libx264'] : ['-c:v', 'h264_videotoolbox'];
    return [...vf, ...enc, '-pix_fmt', 'yuv420p', '-profile:v', 'high'];
  }
  const primaryMode = transcode ? 'hw' : 'copy';
  const v = videoArgs(primaryMode);
  const cap = caps.maxHeight || 1080;
  const needScale = !!(info && info.height && info.height > cap);
  // OBSERVABLES
  const hdrKept = !!(info && info.hdr && caps.hdr10 && caps.hevc);
  const hdrSource = !!(info && info.hdr);
  return {
    video: primaryMode === 'copy' ? 'copy' : 'transcode',
    // actual output height: copy never scales, transcode scales only above cap
    targetHeight: primaryMode === 'copy'
      ? ((info && info.height) || null)
      : (info && info.height ? (needScale ? cap : info.height) : null),
    hdr: primaryMode === 'copy'
      ? (hdrSource ? 'preserve' : 'none')                 // copy passes the bitstream through as-is
      : (hdrKept ? 'preserve' : hdrSource ? 'tonemap' : 'none'),
    tonemap: primaryMode !== 'copy' && hdrSource && !hdrKept,
    audioTracks: (info && info.audio ? info.audio : []).map((a) => ({
      codec: a.codec,
      action: caps.audioCopy.has(a.codec) ? 'copy' : 'transcode',
      bitrate: caps.audioCopy.has(a.codec) ? null : (a.channels > 2 ? '384k' : '160k')
    })),
    audio: (!info || !info.audio.length) ? 'transcode'
      : (info.audio.every((a) => caps.audioCopy.has(a.codec)) ? 'copy' : 'transcode'),
    _args: v.concat(audioArgs()),
    // same builders, an explicit mode — lets the sw-FALLBACK args be compared too
    _argsFor: (m) => videoArgs(m).concat(audioArgs())
  };
}

// SITE B — mkvArgs, lanserver.js 820-873 (no burn-in, swEncode=false)
function oracleMkv(info, capsRaw, audioTrack) {
  const caps = normCaps(capsRaw);
  const tooTall = !!(info && info.height > 1088);
  const isHevc = !!(info && info.vcodec === 'hevc');
  const isH264 = !!(info && info.vcodec === 'h264');
  let canCopyV = false;
  if (info && info.vcodec) {
    if (isHevc) canCopyV = caps.hevc && (tooTall ? caps.hevc4k : true);
    else if (isH264) canCopyV = tooTall ? caps.h264_4k : true;
  }
  if (info && info.hdr && !caps.hdr10) canCopyV = false;
  const cap = caps.maxHeight || 1080;
  const needScale = !!(info && info.height && info.height > cap);
  const a = info && info.audio && info.audio[audioTrack];
  const aArgs = (a && caps.audioCopy.has(a.codec)) ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', (a && a.channels > 2) ? '384k' : '160k'];
  return {
    video: canCopyV ? 'copy' : 'transcode',
    targetHeight: canCopyV ? ((info && info.height) || null)
      : (info && info.height ? (needScale ? cap : info.height) : null),
    hdr: canCopyV ? ((info && info.hdr) ? 'preserve' : 'none') : ((info && info.hdr) ? 'tonemap-none' : 'none'),
    audio: aArgs[1] === 'copy' ? 'copy' : 'transcode'
  };
}

// ───── NEW WIRING: verbatim transcription of the REWIRED call sites in lanserver.js ─────
// The oracles above prove the planner agrees with the OLD decision. These prove the rewired sites
// turn that plan into the SAME ffmpeg arguments. The arg strings are abridged exactly as the
// oracle's are, so a diff means a decision moved, not a typo.
function wiredHls(info, capsRaw, mode) {
  const plan = planPlayback(info || {}, capsRaw, { canTonemap: CAN_TONEMAP });
  const encPlan = planPlayback(info || {}, capsRaw, { canTonemap: CAN_TONEMAP, forceTranscode: true });
  const isHevc = !!(info && info.vcodec === 'hevc');
  const transcode = !plan.speculative && plan.video === 'transcode';
  function audioArgs() {
    if (!plan.audioTracks.length) return ['-c:a', 'aac'];
    const out = [];
    plan.audioTracks.forEach((a, i) => {
      if (a.action === 'copy') out.push(`-c:a:${i}`, 'copy');
      else out.push(`-c:a:${i}`, 'aac', `-b:a:${i}`, a.bitrate);
    });
    return out;
  }
  function videoArgs(m) {
    const hdr = encPlan.hdr === 'preserve';
    const cap = encPlan.targetHeight || 0;
    const needScale = !!(info && info.height && cap && cap < info.height);
    const scaleExpr = 'scale=-2:' + cap;
    const scale = needScale ? ['-vf', scaleExpr] : [];
    if (m === 'copy') return ['-c:v', 'copy', ...(isHevc ? ['-tag:v', 'hvc1'] : [])];
    if (hdr) {
      const enc = m === 'sw' ? ['-c:v', 'libx265', '-preset', 'fast', '-crf', '20'] : ['-c:v', 'hevc_videotoolbox', '-prio_speed', '1', '-b:v', '10M', '-maxrate', '14M', '-bufsize', '20M'];
      return [...scale, ...enc, '-tag:v', 'hvc1', '-pix_fmt', 'p010le',
        '-color_primaries', 'bt2020', '-color_trc', 'smpte2084', '-colorspace', 'bt2020nc', '-color_range', 'tv'];
    }
    const needTonemap = encPlan.tonemap;
    const vf = needTonemap && CAN_TONEMAP
      ? ['-vf', (needScale ? scaleExpr + ',' : '') + 'zscale=...']
      : scale;
    const enc = m === 'sw' ? ['-c:v', 'libx264'] : ['-c:v', 'h264_videotoolbox'];
    return [...vf, ...enc, '-pix_fmt', 'yuv420p', '-profile:v', 'high'];
  }
  return videoArgs(mode || (transcode ? 'hw' : 'copy')).concat(audioArgs());
}
function wiredMkv(info, capsRaw, audioTrack) {
  const plan = planPlayback(info || {}, capsRaw, { canTonemap: CAN_TONEMAP });
  const encPlan = planPlayback(info || {}, capsRaw, { canTonemap: CAN_TONEMAP, forceTranscode: true });
  const isHevc = !!(info && info.vcodec === 'hevc');
  const canCopyV = !plan.speculative && plan.video === 'copy';
  const cap = encPlan.targetHeight || 0;
  const needScale = !!(info && info.height && cap && cap < info.height);
  const at = plan.audioTracks[audioTrack];
  const aArgs = (at && at.action === 'copy') ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', (at && at.bitrate) || '160k'];
  const vEnc = ['-c:v', 'h264_videotoolbox'];
  const vArgs = canCopyV
    ? ['-c:v', 'copy', ...(isHevc ? ['-tag:v', 'hvc1'] : [])]
    : [...(needScale ? ['-vf', 'scale=-2:' + cap] : []), ...vEnc];
  return vArgs.concat(aArgs);
}
// mkvArgs as SHIPPED (no burn-in, swEncode=false), down to the arg array.
function oracleMkvArgs(info, capsRaw, audioTrack) {
  const caps = normCaps(capsRaw);
  const tooTall = !!(info && info.height > 1088);
  const isHevc = !!(info && info.vcodec === 'hevc');
  const isH264 = !!(info && info.vcodec === 'h264');
  let canCopyV = false;
  if (info && info.vcodec) {
    if (isHevc) canCopyV = caps.hevc && (tooTall ? caps.hevc4k : true);
    else if (isH264) canCopyV = tooTall ? caps.h264_4k : true;
  }
  if (info && info.hdr && !caps.hdr10) canCopyV = false;
  const cap = caps.maxHeight || 1080;
  const needScale = !!(info && info.height && info.height > cap);
  const a = info && info.audio && info.audio[audioTrack];
  const aArgs = (a && caps.audioCopy.has(a.codec)) ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', (a && a.channels > 2) ? '384k' : '160k'];
  const vEnc = ['-c:v', 'h264_videotoolbox'];
  const vArgs = canCopyV
    ? ['-c:v', 'copy', ...(isHevc ? ['-tag:v', 'hvc1'] : [])]
    : [...(needScale ? ['-vf', 'scale=-2:' + cap] : []), ...vEnc];
  return vArgs.concat(aArgs);
}

// ───────────────────────── matrix ─────────────────────────
const VCODECS = ['h264', 'hevc', 'vp9', 'av1', 'mpeg4', null];
const HEIGHTS = [480, 720, 1080, 1088, 1440, 2160, 4320, 0];
const HDRS = [true, false];
const ACODECS = ['aac', 'mp3', 'alac', 'ac3', 'eac3', 'dts', 'truehd', 'opus', 'flac'];
const CHANS = [2, 6, 8];

const PROFILES = [
  { name: 'default/conservative (null caps)', caps: null },
  { name: 'full 4K TV', caps: { hevc: true, hevc4k: true, h264_4k: true, hdr10: true, audioCopy: [...AUDIO_PASSTHROUGH], maxHeight: 2160 } },
  { name: '1080p-blocked Chromecast', caps: { hevc: true, hevc4k: false, h264_4k: false, hdr10: true, audioCopy: [...AUDIO_PASSTHROUGH], maxHeight: 1080 } },
  { name: 'H.264-only HDR10 dongle', caps: { hevc: false, hevc4k: false, h264_4k: false, hdr10: true, audioCopy: ['aac', 'mp3', 'alac'], maxHeight: 1080 } },
  { name: 'hevc:false 4K-capable', caps: { hevc: false, hevc4k: true, h264_4k: true, hdr10: true, audioCopy: [...AUDIO_PASSTHROUGH], maxHeight: 2160 } },
  { name: 'no-HDR 4K TV (hdr10:false)', caps: { hevc: true, hevc4k: true, h264_4k: true, hdr10: false, audioCopy: [...AUDIO_PASSTHROUGH], maxHeight: 2160 } }
];

const divergences = [];
let cases = 0;

function add(input, field, oldR, newR, rationale) {
  divergences.push({ input, field, oldResult: String(oldR), plannerResult: String(newR), rationale });
}

for (const vcodec of VCODECS) {
  for (const height of HEIGHTS) {
    for (const hdr of HDRS) {
      for (const acodec of ACODECS) {
        for (const ch of CHANS) {
          for (const prof of PROFILES) {
            const audio = [{ idx: 1, lang: 'eng', name: 'A', codec: acodec, channels: ch }];
            const info = vcodec === null && height === 0
              ? null
              : { vcodec, height, hdr, audio, subs: [], dur: 100, width: 1920, fps: 24 };
            cases++;
            const exp = oracleHls(info, prof.caps);
            const got = planPlayback(info, prof.caps, { canTonemap: CAN_TONEMAP });
            const desc = JSON.stringify({ vcodec, height, hdr, acodec, channels: ch, profile: prof.name });

            if (exp.video !== got.video) add(desc, 'video', exp.video, got.video, 'copy-vs-transcode');
            if (exp.audio !== got.audio) add(desc, 'audio', exp.audio, got.audio, 'audio copy-vs-transcode (aggregate)');
            const ea = exp.audioTracks[0], ga = (got.audioTracks || [])[0];
            if (ea && ga && (ea.action !== ga.action || ea.bitrate !== ga.bitrate)) {
              add(desc, 'audioTracks[0]', ea.action + '/' + ea.bitrate, ga.action + '/' + ga.bitrate, 'per-track audio');
            }
            if ((exp.targetHeight || null) !== (got.targetHeight || null)) {
              add(desc, 'targetHeight', exp.targetHeight, got.targetHeight, 'output height');
            }
            if (exp.hdr !== got.hdr) add(desc, 'hdr', exp.hdr, got.hdr, 'HDR preserved vs tonemapped');
            if (exp.tonemap !== !!got.tonemap) add(desc, 'tonemap', exp.tonemap, !!got.tonemap, 'tonemap flag');

            // cross-check site B on the video decision only (single audio track 0)
            const mkv = oracleMkv(info, prof.caps, 0);
            if (mkv.video !== got.video) add(desc, 'video(mkv-site)', mkv.video, got.video, 'site B copy-vs-transcode');

            // ARG-LEVEL: shipped call sites vs the rewired ones. This is the byte-identity claim.
            for (const mode of [null, 'hw', 'sw']) {
              const eArgs = mode ? exp._argsFor(mode) : exp._args;
              const gArgs = wiredHls(info, prof.caps, mode);
              if (eArgs.join(' ') !== gArgs.join(' ')) {
                add(desc, 'args(hls,' + (mode || 'primary') + ')', eArgs.join(' '), gArgs.join(' '), 'ffmpeg args');
              }
            }
            const eM = oracleMkvArgs(info, prof.caps, 0).join(' ');
            const gM = wiredMkv(info, prof.caps, 0).join(' ');
            if (eM !== gM) add(desc, 'args(mkv)', eM, gM, 'ffmpeg args');
          }
        }
      }
    }
  }
}

// group
const byKey = new Map();
for (const d of divergences) {
  const k = d.field + '|' + d.oldResult + '→' + d.plannerResult;
  if (!byKey.has(k)) byKey.set(k, { ...d, count: 0, samples: [] });
  const g = byKey.get(k); g.count++; if (g.samples.length < 3) g.samples.push(d.input);
}
const spec = divergences.filter((d) => /"vcodec":null/.test(d.input)).length;
// The byte-identity claim, stated as a number: arg-level divergences between the shipped call sites
// and the rewired ones, EXCLUDING the deliberate 8K copy-refusal (height 4320). Must be 0.
const argDiv = divergences.filter((d) => /^args/.test(d.field));
const argDivNon8K = argDiv.filter((d) => !/"height":4320/.test(d.input));
console.log('ffmpeg-arg divergences (rewired vs shipped):', argDiv.length,
  '| excluding the deliberate 8K fix:', argDivNon8K.length);
argDivNon8K.slice(0, 5).forEach((d) => console.log('   !', d.input, d.oldResult, '→', d.plannerResult));
console.log('cases:', cases, 'divergent comparisons:', divergences.length,
  '(unprobed/speculative:', spec, '| probed:', divergences.length - spec, ') distinct classes:', byKey.size);
for (const [k, g] of byKey) {
  console.log('\n### ' + k + '  (x' + g.count + ')');
  g.samples.forEach((s) => console.log('   ' + s));
}
