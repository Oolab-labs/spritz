'use strict';

// What a receiver can decode, in one place.
//
// This existed in two halves that never met. cast.js inferred capabilities from mDNS names and
// eureka JSON (capsProfile/capsFromMdns/capsFromEureka) and handed them over as a loose object;
// lanserver.js then re-normalised whatever arrived (normCaps, CAPS_CONSERVATIVE, CAPS_FULL) before
// deciding copy-vs-transcode. Two files had to agree on an undocumented shape, and the defaults
// differed: cast's inference set hevc from device class, lanserver's conservative default assumed
// hevc true. Nothing in between recorded WHY a receiver was believed to be 4K-capable.
//
// So: one profile type, one place that builds it, and provenance attached. `source` matters
// because the confidence levels are wildly different — a TV that reported 4k_blocked=0 over eureka
// is telling us something; a TV we guessed was 4K-capable because its name contains "OLED" is not.
// Anything that later learns from playback failures needs to know which it is looking at, and
// needs to refuse to downgrade a user override.

// Audio a receiver can take as a lossless passthrough. AC3/EAC3 are passthrough-supported by
// AVPlayer and the Google Cast receiver and decoded natively by webOS — copying them preserves
// 5.1/7.1 that a forced AAC stereo downmix destroys.
const AUDIO_BASIC = ['aac', 'mp3', 'alac'];
const AUDIO_PASSTHROUGH = ['aac', 'mp3', 'alac', 'ac3', 'eac3'];

// Ordered weakest to strongest. A profile built from a stronger source wins.
const SOURCES = ['default', 'inferred-from-name', 'reported', 'observed', 'user-override'];

const TV_LIKE = /\bTV\b|webos|nanocell|oled|qled|neo|bravia|google ?tv|android ?tv|\blg\b|samsung|sony|vizio|hisense|tcl|philips/i;
const isTvLike = (s) => TV_LIKE.test(s || '');

// The conservative default: copy <=1080p H.264/HEVC including HDR10, downscale 4K, AAC audio.
// Safe for any AVPlayer or Cast receiver, which is the point — it is what an unknown device gets.
function defaultProfile() {
  return {
    hevc: true, hevc4k: false, h264_4k: false, hdr10: true, dovi: false,
    audioCopy: AUDIO_BASIC.slice(), maxHeight: 1080,
    source: 'default', label: null, id: null
  };
}

function build({ isTv, fourK, source, label, id }) {
  const passthrough = isTv || fourK; // Dolby passthrough is safe on TVs and 4K receivers
  return {
    hevc: !!(isTv || fourK),
    hevc4k: !!fourK,
    h264_4k: !!fourK,
    hdr10: true,
    dovi: false,          // never inferred: Dolby Vision needs profile-level detail nothing here has
    audioCopy: (passthrough ? AUDIO_PASSTHROUGH : AUDIO_BASIC).slice(),
    maxHeight: fourK ? 2160 : 1080,
    source: source || 'inferred-from-name',
    label: label || null,
    // A stable identity for this device, where the discovery layer has one. Everything that
    // remembers a device across sessions keys on this: an address is a DHCP lease, and a memory
    // keyed on one gets silently transplanted onto whatever answers there next week.
    id: id || null
  };
}

// mDNS gives a friendly name and sometimes a model string. That is a guess from marketing text —
// the weakest real source, and it is recorded as such.
function fromMdns(name, model) {
  const tv = isTvLike((model || '') + ' ' + (name || ''));
  return build({ isTv: tv, fourK: tv, source: 'inferred-from-name', label: name || model || null });
}

// A Chromecast-built-in receiver's eureka_info. Stronger: `4k_blocked` is the device reporting its
// own limit rather than us reading its name. Absent means it did not say, so fall back to class.
function fromEureka(j) {
  const info = (j && j.device_info) || {};
  const tv = isTvLike([j && j.name, info.model_name, info.manufacturer, info.product_name].join(' '));
  const blocked = info['4k_blocked'];
  const said = blocked === 0 || blocked === '0' || blocked === 1 || blocked === '1';
  const fourK = blocked === 0 || blocked === '0' || (tv && blocked == null);
  return build({
    isTv: tv, fourK,
    source: said ? 'reported' : 'inferred-from-name',
    label: (j && j.name) || info.model_name || null,
    // ssdp_udn is the device's own UPnP identity and survives both a DHCP lease and a rename.
    // (mac_address is present but the LG reports all zeros, so it is useless here.)
    id: (j && j.ssdp_udn) || null
  });
}

// Accept whatever a caller has (including the loose objects the old code passed) and return a
// complete profile. Unknown or missing fields take the conservative default rather than the
// permissive one: guessing a receiver is MORE capable than it is produces a black screen.
function normalise(caps) {
  if (!caps) return defaultProfile();
  const d = defaultProfile();
  const audio = caps.audioCopy instanceof Set ? [...caps.audioCopy]
    : Array.isArray(caps.audioCopy) ? caps.audioCopy.slice()
      : d.audioCopy;
  return {
    hevc: caps.hevc !== false,
    hevc4k: !!caps.hevc4k,
    h264_4k: !!caps.h264_4k,
    hdr10: caps.hdr10 !== false,
    dovi: !!caps.dovi,
    audioCopy: audio.map((a) => String(a).toLowerCase()),
    maxHeight: Number.isFinite(caps.maxHeight) && caps.maxHeight > 0 ? caps.maxHeight : d.maxHeight,
    source: SOURCES.includes(caps.source) ? caps.source : 'default',
    label: caps.label || null,
    id: caps.id || null
  };
}

// Does `next` come from a stronger source than `prev`? Used so a name-based guess cannot overwrite
// something the device actually reported, and nothing overwrites a user override.
function outranks(next, prev) {
  if (!prev) return true;
  if (!next) return false;
  return SOURCES.indexOf(next.source) > SOURCES.indexOf(prev.source);
}

const canCopyAudio = (profile, codec) =>
  !!codec && normalise(profile).audioCopy.includes(String(codec).toLowerCase());

module.exports = {
  defaultProfile, fromMdns, fromEureka, normalise, outranks, canCopyAudio, isTvLike,
  AUDIO_BASIC, AUDIO_PASSTHROUGH, SOURCES
};
