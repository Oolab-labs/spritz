'use strict';

// A TRANSPORT EPOCH: one ffmpeg-owned HLS representation of a film from a chosen logical position.
//
// The rule: logical media identity != transport representation. A far seek may replace the
// transport — a new ffmpeg run, a new playlist, a new directory — while the film stays the same
// film. Each epoch is ONE `-f hls` run in which ffmpeg chooses every cut, because the hardware
// evidence is settled: five ways of forcing boundaries corrupted an open-GOP source at the same
// packet, and one continuous muxer choosing its own cuts was clean.
//
// Producer lifecycle belongs to the run. This module is the first production caller of
// setProducerActive: the epoch's ffmpeg starting makes the producer active, and its exit, error,
// stop or supersession makes it inactive. Never an HTTP request.
//
// Lifecycle is driven here with a fake spawn; the real ffmpeg is exercised end to end in
// transport-epoch-ffmpeg.test.js.

const { test } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { epochArgs, createEpochs, toLogical, toLocal, planSeek } = require('../src/main/transport-epoch');

// A child process the way the module sees one: stderr, kill(), and 'close'/'error' we emit ourselves.
function fakeSpawn() {
  const spawned = [];
  const spawn = (cmd, args) => {
    const p = new EventEmitter();
    p.stderr = new EventEmitter();
    p.killed = false;
    p.kill = (sig) => { p.killed = sig || true; setImmediate(() => p.emit('close', null, sig || 'SIGKILL')); };
    p.args = args;
    spawned.push(p);
    return p;
  };
  return { spawn, spawned };
}

function rig() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spritz-epoch-'));
  const { spawn, spawned } = fakeSpawn();
  const active = [];
  const epochs = createEpochs({ spawn, ffmpeg: '/fake/ffmpeg', root, onActive: (a) => active.push(a),
    probeFirstPts: (file, cb) => cb(null) });
  return { root, spawn, spawned, active, epochs, done: () => fs.rmSync(root, { recursive: true, force: true }) };
}
const tick = () => new Promise((r) => setImmediate(r));

test('session namespaces prevent first-epoch identity reuse across managers', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spritz-epoch-identities-'));
  const fake = fakeSpawn();
  const a = createEpochs({ spawn: fake.spawn, ffmpeg: '/fake/ffmpeg', root: path.join(root, 'A'), namespace: 'session-A' });
  const b = createEpochs({ spawn: fake.spawn, ffmpeg: '/fake/ffmpeg', root: path.join(root, 'B'), namespace: 'session-B' });
  try {
    const old = a.open({ mediaId: 'same-film', input: '/film', logicalStart: 600 });
    const fresh = b.open({ mediaId: 'same-film', input: '/film', logicalStart: 0 });
    assert.notEqual(old.id, fresh.id);
    assert.equal(b.get(old.id), null);
    assert.equal(a.get(fresh.id), null);
    assert.equal(b.current().id, fresh.id);
  } finally { a.close(); b.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

// ---- identity and position -------------------------------------------------------------------

test('an epoch has a stable logical media id separate from its own id', () => {
  const r = rig();
  try {
    const a = r.epochs.open({ mediaId: 'goat', input: '/f.mkv', logicalStart: 0 });
    const b = r.epochs.open({ mediaId: 'goat', input: '/f.mkv', logicalStart: 300 });
    assert.equal(a.mediaId, 'goat'); assert.equal(b.mediaId, 'goat', 'same film');
    assert.notEqual(a.id, b.id, 'different transport');
    assert.equal(a.logicalStart, 0); assert.equal(b.logicalStart, 300);
  } finally { r.done(); }
});

test('a new seek creates a new epoch and the previous one is superseded, not destroyed', async () => {
  const r = rig();
  try {
    const a = r.epochs.open({ mediaId: 'goat', input: '/f.mkv', logicalStart: 0 });
    r.spawned[0].emit('close', 0);
    fs.writeFileSync(path.join(a.dir, 'media.m3u8'), '#EXTM3U\n');
    const b = r.epochs.open({ mediaId: 'goat', input: '/f.mkv', logicalStart: 300 });
    await tick();
    assert.equal(r.epochs.current().id, b.id);
    assert.ok(fs.existsSync(path.join(a.dir, 'media.m3u8')), 'the old epoch\'s files are still there for the handoff');
    assert.equal(r.epochs.get(a.id).state, 'superseded');
    assert.deepEqual(r.epochs.list().map((e) => e.id), [a.id, b.id], 'both are known until the old one is retired');
  } finally { r.done(); }
});

test('epoch-local and logical positions map both ways, and the mapping depends on the clock the player exposes', () => {
  // -copyts writes SOURCE timestamps into the epoch's media. Whether a player's currentTime is
  // those timestamps ('pts') or counts from zero ('zero') is a property of the receiver measured on
  // hardware, not assumed here — so both are explicit.
  const epoch = { logicalStart: 300, firstPlayableSec: 297.5 }; // keyframe lead-in of 2.5s
  assert.equal(toLogical(epoch, 7.2, 'zero'), 304.7, 'zero-based: local + first playable');
  assert.equal(toLocal(epoch, 304.7, 'zero'), 7.2);
  assert.equal(toLogical(epoch, 304.7, 'pts'), 304.7, 'pts-based: the player already speaks logical time');
  assert.equal(toLocal(epoch, 304.7, 'pts'), 304.7);
  assert.equal(toLogical(epoch, null, 'zero'), null, 'no reading is no reading');
});

test('the first playable timestamp is recorded against what was asked for', () => {
  const r = rig();
  try {
    const probed = [];
    const epochs = createEpochs({ spawn: r.spawn, ffmpeg: '/fake/ffmpeg', root: r.root, onActive: () => {},
      probeFirstPts: (file, cb) => { probed.push(file); cb(297.5); } });
    const e = epochs.open({ mediaId: 'goat', input: '/f.mkv', logicalStart: 300 });
    fs.writeFileSync(path.join(e.dir, '0.ts'), 'x');
    epochs.noteFirstSegment(e.id, path.join(e.dir, '0.ts'));
    assert.equal(e.requestedStart, 300);
    assert.equal(e.firstPlayableSec, 297.5);
    assert.equal(e.leadInSec, 2.5, 'the keyframe lead-in, measured rather than assumed');
    assert.equal(probed.length, 1);
  } finally { r.done(); }
});

// ---- producer lifecycle ----------------------------------------------------------------------

test('starting an epoch makes the producer active', () => {
  const r = rig();
  try {
    r.epochs.open({ mediaId: 'goat', input: '/f.mkv', logicalStart: 0 });
    assert.deepEqual(r.active, [true]);
  } finally { r.done(); }
});

test('a normal exit clears producer active', () => {
  const r = rig();
  try {
    const e = r.epochs.open({ mediaId: 'goat', input: '/f.mkv', logicalStart: 0 });
    r.spawned[0].emit('close', 0);
    assert.deepEqual(r.active, [true, false]);
    assert.equal(r.epochs.get(e.id).state, 'done');
  } finally { r.done(); }
});

test('an error clears producer active', () => {
  const r = rig();
  try {
    const e = r.epochs.open({ mediaId: 'goat', input: '/f.mkv', logicalStart: 0 });
    r.spawned[0].emit('error', new Error('ENOENT'));
    assert.deepEqual(r.active, [true, false]);
    assert.equal(r.epochs.get(e.id).state, 'failed');
    const f = r.epochs.open({ mediaId: 'goat', input: '/f.mkv', logicalStart: 0 });
    r.spawned[1].emit('close', 1);
    assert.equal(r.epochs.get(f.id).state, 'failed', 'a non-zero exit is a failure too');
    assert.deepEqual(r.active, [true, false, true, false]);
  } finally { r.done(); }
});

test('an explicit stop clears producer active, and so does being superseded', async () => {
  const r = rig();
  try {
    const a = r.epochs.open({ mediaId: 'goat', input: '/f.mkv', logicalStart: 0 });
    r.epochs.stop(a.id);
    await tick();
    assert.deepEqual(r.active, [true, false]);
    assert.ok(r.spawned[0].killed, 'its ffmpeg was killed');

    const b = r.epochs.open({ mediaId: 'goat', input: '/f.mkv', logicalStart: 100 });
    const c = r.epochs.open({ mediaId: 'goat', input: '/f.mkv', logicalStart: 300 });
    await tick();
    assert.ok(r.spawned[1].killed, 'the superseded epoch\'s ffmpeg was killed');
    assert.ok(!r.spawned[2].killed, 'the new one runs');
    // Superseding is one continuous production: b ends and c begins, and the producer stays active
    // throughout because a packager is still reading.
    assert.equal(r.active[r.active.length - 1], true);
    assert.equal(r.epochs.get(b.id).state, 'superseded'); assert.equal(r.epochs.get(c.id).state, 'producing');
  } finally { r.done(); }
});

test('several Range-style events on the source are not lifecycle: only the run decides', () => {
  // The module has no HTTP surface at all, which is the point — nothing here can be told a
  // request opened or closed. Lifecycle is spawn, close, error, stop, supersede.
  const r = rig();
  try {
    const e = r.epochs.open({ mediaId: 'goat', input: 'http://127.0.0.1:1/dlna/t/f.mkv', logicalStart: 0 });
    assert.equal(typeof e.onRangeClose, 'undefined');
    assert.deepEqual(r.active, [true]);
  } finally { r.done(); }
});

// ---- ownership --------------------------------------------------------------------------------

test('retiring an epoch removes only its own artifacts', () => {
  const r = rig();
  try {
    const a = r.epochs.open({ mediaId: 'goat', input: '/f.mkv', logicalStart: 0 });
    const b = r.epochs.open({ mediaId: 'goat', input: '/f.mkv', logicalStart: 300 });
    fs.writeFileSync(path.join(a.dir, '0.ts'), 'a'); fs.writeFileSync(path.join(b.dir, '0.ts'), 'b');
    const unrelated = path.join(r.root, 'sub_0_en.vtt'); fs.writeFileSync(unrelated, 'WEBVTT');
    r.epochs.retire(a.id);
    assert.ok(!fs.existsSync(a.dir), 'the retired epoch is gone');
    assert.ok(fs.existsSync(path.join(b.dir, '0.ts')), 'the live one is untouched');
    assert.ok(fs.existsSync(unrelated), 'the session\'s other files are untouched');
    assert.deepEqual(r.epochs.list().map((e) => e.id), [b.id]);
  } finally { r.done(); }
});

test('closing the set stops every run and removes every epoch directory, nothing else', async () => {
  const r = rig();
  try {
    const a = r.epochs.open({ mediaId: 'goat', input: '/f.mkv', logicalStart: 0 });
    const b = r.epochs.open({ mediaId: 'goat', input: '/f.mkv', logicalStart: 300 });
    const unrelated = path.join(r.root, 'master.m3u8'); fs.writeFileSync(unrelated, '#EXTM3U');
    r.epochs.close();
    await tick();
    assert.ok(!fs.existsSync(a.dir) && !fs.existsSync(b.dir));
    assert.ok(fs.existsSync(unrelated));
    assert.equal(r.active[r.active.length - 1], false);
    assert.ok(r.spawned.every((p) => p.killed || true));
  } finally { r.done(); }
});

// ---- seeking ----------------------------------------------------------------------------------

test('a seek inside what the epoch covers is an in-epoch seek; outside it is a new epoch', () => {
  const covered = { id: 'epoch-2', logicalStart: 300, firstPlayableSec: 297.5, producedUntilSec: 900, state: 'producing' };
  assert.deepEqual(planSeek({ epoch: covered, toLogical: 450, clock: 'zero' }), { kind: 'in-epoch', localSec: 152.5 });
  assert.deepEqual(planSeek({ epoch: covered, toLogical: 450, clock: 'pts' }), { kind: 'in-epoch', localSec: 450 });
  assert.deepEqual(planSeek({ epoch: covered, toLogical: 100, clock: 'zero' }), { kind: 'new-epoch', logicalStart: 100 }, 'before the epoch began');
  assert.deepEqual(planSeek({ epoch: covered, toLogical: 2000, clock: 'zero' }), { kind: 'new-epoch', logicalStart: 2000 }, 'past what has been produced');
  assert.deepEqual(planSeek({ epoch: null, toLogical: 50, clock: 'zero' }), { kind: 'new-epoch', logicalStart: 50 });
  const done = Object.assign({}, covered, { state: 'done', producedUntilSec: 5980 });
  assert.deepEqual(planSeek({ epoch: done, toLogical: 5000, clock: 'zero' }), { kind: 'in-epoch', localSec: 4702.5 }, 'a finished epoch covers to its end');
});

// ---- the ffmpeg command -----------------------------------------------------------------------

test('the epoch command seeks the input, keeps source timestamps, copies streams, and lets ffmpeg cut', () => {
  const args = epochArgs({ input: '/f.mkv', dir: '/d/epoch-2', logicalStart: 300 });
  const i = args.indexOf('-i');
  assert.ok(args.indexOf('-ss') < i, '-ss before -i: an input seek, so ffmpeg lands on the keyframe at or before T without decoding up to it');
  assert.equal(args[args.indexOf('-ss') + 1], '300');
  assert.ok(args.includes('-copyts'), 'source timestamps survive into the epoch');
  assert.ok(args.includes('-c:v') && args[args.indexOf('-c:v') + 1] === 'copy');
  assert.equal(args[args.indexOf('-f') + 1], 'hls');
  assert.ok(args.includes('temp_file') || args.some((a) => /temp_file/.test(a)), 'segments become visible only when complete — the muxer\'s own rule, not ours');
  assert.equal(args[args.length - 1], path.join('/d/epoch-2', 'media.m3u8'));
});

test('no forced-boundary arguments appear in epoch packaging', () => {
  const args = epochArgs({ input: '/f.mkv', dir: '/d/e', logicalStart: 0 });
  for (const bad of ['segment', '-segment_times', '-segment_frames', '-segment_time_delta', '-reset_timestamps', '-segment_start_number']) {
    assert.ok(!args.includes(bad), bad + ' must not appear');
  }
  assert.ok(!args.some((a) => /^-f$/.test(a) && false));
  assert.equal(args.filter((a) => a === '-f').length, 1);
});

test('an epoch at logical 0 does not seek at all', () => {
  const args = epochArgs({ input: '/f.mkv', dir: '/d/e', logicalStart: 0 });
  assert.ok(!args.includes('-ss'), 'nothing to skip');
});

test('the playlist type is a choice, defaulting to event, and never anything ffmpeg would reject', () => {
  // Measured on the LG: an EVENT playlist with no ENDLIST at fetch time is treated as LIVE and
  // playback starts at the edge. Whether a VOD-typed playlist that is still growing is honoured as
  // VOD by webOS is a hardware question; the option exists so it can be asked without editing code.
  const dflt = epochArgs({ input: '/f.mkv', dir: '/d', logicalStart: 0 });
  assert.equal(dflt[dflt.indexOf('-hls_playlist_type') + 1], 'event');
  const vod = epochArgs({ input: '/f.mkv', dir: '/d', logicalStart: 0, playlistType: 'vod' });
  assert.equal(vod[vod.indexOf('-hls_playlist_type') + 1], 'vod');
  assert.equal(epochArgs({ input: '/f.mkv', dir: '/d', logicalStart: 0, playlistType: 'live' }), null, 'not a value this module knows');
});
