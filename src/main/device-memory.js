'use strict';

// What a receiver has actually been observed to play.
//
// device-profile.js ranks where a capability came from — default, guessed from the name, reported by
// the device, observed, user override — and `observed` was a rung with nothing standing on it.
// Nothing ever wrote one. This writes them.
//
// The asymmetry here is the whole design, and it is the lesson of a long day of wrong diagnoses.
//
// A SUCCESS is attributable. If a stream played, every property it had was supported: the codec, the
// resolution, the colour, the audio that was passed through untouched. Each of those can be recorded
// as fact about that device, and each is safe, because it says the device can do MORE than assumed —
// and over-claiming is the dangerous direction, so a claim grounded in a stream that demonstrably
// played is exactly the claim worth keeping.
//
// A FAILURE is not attributable. When a receiver refuses a 4K HDR HEVC file with Dolby Vision and
// E-AC-3 in Matroska, it has told you that one of six things was wrong and not which. Guessing costs
// days: the container was blamed on the codec, the codec on Dolby Vision, and Dolby Vision on a
// missing index, and every one of those theories fitted the evidence. So failures are recorded for
// context and never allowed to change a capability. Narrowing what a device can do on a guess is how
// a working setup quietly degrades to 1080p SDR stereo and nobody knows why.
//
// Pure: no filesystem, no electron. The caller owns persistence.

const MAX_FAILURES = 20;   // per device; context for a human, not a dataset

// Identity has to survive a DHCP lease. The address does not, and a profile keyed on it would be
// silently transplanted onto whatever answers at that address tomorrow. Prefer whatever stable id
// the discovery layer has (eureka gives one), then the label, and only then the address.
function deviceKey(device) {
  if (!device) return null;
  const id = device.id || device.uuid || device.deviceId;
  if (id) return 'id:' + String(id).toLowerCase();
  if (device.label) return 'label:' + String(device.label).toLowerCase().trim();
  if (device.host) return 'host:' + String(device.host).toLowerCase();
  return null;
}

function emptyMemory() {
  return { version: 1, devices: {} };
}

function entryFor(mem, key) {
  if (!mem.devices[key]) mem.devices[key] = { observed: {}, failures: [], label: null };
  const e = mem.devices[key];
  if (!e.observed) e.observed = {};
  if (!Array.isArray(e.failures)) e.failures = [];
  return e;
}

// Traits of a stream that played. Only what was sent UNTOUCHED counts as evidence about the
// receiver: a 4K file downscaled to 1080p before sending proves nothing about 4K, and audio
// re-encoded to AAC proves nothing about passthrough.
//   { videoCodec, width, height, hdr, dovi, audioCodec, videoCopied, audioCopied }
function recordSuccess(mem, key, traits) {
  if (!mem || !key || !traits) return mem;
  const e = entryFor(mem, key);
  const o = e.observed;
  const h = Number(traits.height) || 0;
  const w = Number(traits.width) || 0;
  const vc = String(traits.videoCodec || '').toLowerCase();
  // 4K is a frame size, not a height. A scope-framed feature is 3840x1606 — a 4K stream by every
  // measure that matters to a decoder, and 554 lines short of the height test. Judged on height alone
  // the first real cast of one recorded maxHeight 1606 and learned nothing about 4K at all, which is
  // how this was found. Either dimension qualifying is the honest test.
  const isFourK = h >= 2160 || w >= 3840;

  if (traits.videoCopied && h) {
    // maxHeight stays the height that actually went out — claiming 2160 for a 1606-tall stream would
    // be inventing evidence. It is the 4K CODEC flags that the frame size settles.
    o.maxHeight = Math.max(o.maxHeight || 0, h);
    if (isFourK) {
      if (vc === 'hevc' || vc === 'h265') o.hevc4k = true;
      if (vc === 'h264' || vc === 'avc') o.h264_4k = true;
    }
    if (vc === 'hevc' || vc === 'h265') o.hevc = true;
    // HDR and Dolby Vision only count when the picture went out untouched. A tonemapped or
    // DV-stripped stream that played says nothing about the receiver's HDR or DV support.
    if (traits.hdr) o.hdr10 = true;
    if (traits.dovi) o.dovi = true;
  }
  if (traits.audioCopied && traits.audioCodec) {
    const a = String(traits.audioCodec).toLowerCase();
    o.audioCopy = Array.from(new Set([...(o.audioCopy || []), a]));
  }
  if (traits.label) e.label = traits.label;
  e.updatedAt = traits.at || e.updatedAt || null;
  return mem;
}

// Recorded, never acted on. Kept so a human (or a later route planner with better evidence) can see
// what this device has refused, without any of it narrowing what the device is allowed to be sent.
function recordFailure(mem, key, traits, reason) {
  if (!mem || !key) return mem;
  const e = entryFor(mem, key);
  e.failures.push({
    at: (traits && traits.at) || null,
    reason: reason ? String(reason).slice(0, 200) : null,
    videoCodec: (traits && traits.videoCodec) || null,
    height: (traits && Number(traits.height)) || null,
    container: (traits && traits.container) || null,
    dovi: !!(traits && traits.dovi)
  });
  if (e.failures.length > MAX_FAILURES) e.failures.splice(0, e.failures.length - MAX_FAILURES);
  return mem;
}

// Fold what was observed into a profile.
//
// Only ever widens. A profile whose source already outranks observation (a user override) is left
// alone, and an observed value that is weaker than what the profile already claims is ignored —
// this is evidence that a device CAN do something, never that it cannot.
function applyMemory(profile, mem, key, deviceProfile) {
  const normalise = deviceProfile && deviceProfile.normalise;
  const base = normalise ? normalise(profile) : profile;
  if (!mem || !key || !mem.devices || !mem.devices[key] || !base) return base;
  if (base.source === 'user-override') return base;
  const o = mem.devices[key].observed || {};
  const out = Object.assign({}, base);
  let used = false;
  for (const flag of ['hevc', 'hevc4k', 'h264_4k', 'hdr10', 'dovi']) {
    if (o[flag] === true && out[flag] !== true) { out[flag] = true; used = true; }
  }
  if (o.maxHeight && o.maxHeight > (out.maxHeight || 0)) { out.maxHeight = o.maxHeight; used = true; }
  if (Array.isArray(o.audioCopy) && o.audioCopy.length) {
    const merged = Array.from(new Set([...(out.audioCopy || []), ...o.audioCopy]));
    if (merged.length > (out.audioCopy || []).length) { out.audioCopy = merged; used = true; }
  }
  if (used) out.source = 'observed';
  return out;
}

// What this device is known to have played, in a form fit to show someone.
function describe(mem, key) {
  if (!mem || !key || !mem.devices || !mem.devices[key]) return null;
  const e = mem.devices[key];
  const o = e.observed || {};
  const played = [];
  if (o.hevc4k) played.push('4K HEVC');
  else if (o.hevc) played.push('HEVC');
  if (o.h264_4k) played.push('4K H.264');
  if (o.hdr10) played.push('HDR10');
  if (o.dovi) played.push('Dolby Vision');
  if (o.maxHeight) played.push(o.maxHeight + 'p');
  for (const a of (o.audioCopy || [])) played.push(a.toUpperCase());
  return { label: e.label || null, played, failures: e.failures.length };
}

module.exports = { emptyMemory, deviceKey, recordSuccess, recordFailure, applyMemory, describe, MAX_FAILURES };
