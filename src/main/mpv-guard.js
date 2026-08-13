'use strict';

// What the renderer is allowed to ask mpv to do.
//
// The renderer is the untrusted side: it renders remote metadata, subtitle text, torrent filenames
// and web page titles, so anything reaching this boundary should be treated as attacker-influenced.
// `player:setProperty` and `player:command` are the two widest channels in the preload bridge —
// between them they can reach most of mpv's several-hundred-property surface.
//
// These used to be DENY lists (run/subprocess/load-script/loadlist, and a handful of properties).
// Deny lists are the wrong shape here: they have to enumerate every dangerous name in a large and
// growing API, and they missed real ones — `log-file` and `dump-cache` write attacker-chosen paths,
// `load-config-file` reads one, `screenshot-directory` picks a write target. Allow lists invert
// that: the renderer needs sixteen properties and six commands, all listed here, and anything new
// fails closed until someone adds it deliberately.
//
// Extracted from main.js so it can be unit-tested. The old inline deny lists never were, and a
// security control nobody tests is a security control nobody knows the shape of.

// Properties reachable from the renderer, either through preload's fixed wrappers
// (pause/time-pos/volume/mute/aid/sid/sub-delay/hwdec) or a direct soda.player.setProperty call.
const PROP_ALLOW = new Set([
  'aid',                    // audio track
  'audio-delay',
  'hwdec',                  // hardware decode mode picker
  'mute',
  'pause',
  'sid',                    // subtitle track
  'speed',
  'sub-back-color',
  'sub-border-size',
  'sub-codepage',
  'sub-delay',
  'sub-font-size',
  'time-pos',               // seek
  'video-aspect-override',
  'video-zoom',
  'volume'
]);

// Commands reachable from the renderer.
const CMD_ALLOW = new Set([
  'add',                    // `add chapter ±1` — chapter navigation
  'cycle',                  // `cycle sub-visibility`
  'frame-step',
  'frame-back-step',
  'stop',
  'sub-add'                 // user-chosen sidecar subtitle file
]);

// `add` and `cycle` take a PROPERTY NAME as their first argument, so they are a second route to the
// property surface — `add volume 100`, or worse against a property not in PROP_ALLOW. Constrain
// what they may target rather than trusting the verb alone.
const CMD_TARGET_ALLOW = new Set(['chapter', 'sub-visibility']);

function allowProperty(name) {
  return typeof name === 'string' && PROP_ALLOW.has(name.toLowerCase());
}

function allowCommand(args) {
  if (!Array.isArray(args) || !args.length) return false;
  // Every element must be a primitive. mpv's command interface takes strings/numbers; an object or
  // array here means the renderer sent something the caller did not anticipate.
  for (const a of args) {
    const t = typeof a;
    if (t !== 'string' && t !== 'number' && t !== 'boolean') return false;
  }
  const verb = String(args[0]).toLowerCase();
  if (!CMD_ALLOW.has(verb)) return false;
  if (verb === 'add' || verb === 'cycle') {
    return typeof args[1] === 'string' && CMD_TARGET_ALLOW.has(args[1].toLowerCase());
  }
  return true;
}

module.exports = { allowProperty, allowCommand, PROP_ALLOW, CMD_ALLOW, CMD_TARGET_ALLOW };
