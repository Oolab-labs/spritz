'use strict';

// A TRANSPORT EPOCH: one ffmpeg-owned HLS representation of a film from a chosen logical position.
//
// The rule this module exists to keep: LOGICAL MEDIA IDENTITY != TRANSPORT REPRESENTATION. A far
// seek may replace the transport — a new ffmpeg run, a new playlist, a new directory — while the
// film stays the same film. The receiver is told which epoch it holds alongside which film, and
// receiver-session.shouldLoad() uses both: same film + same epoch is adopted on reconnect; same
// film + newer epoch means the transport must be reloaded; a different film is a different film.
//
// WHY EPOCHS RATHER THAN ONE PLAYLIST WITH PREDETERMINED SEGMENTS. Measured on an LG against a real
// open-GOP HEVC WEBRip: cutting segments independently gives every one a keyframe lead-in, so
// consecutive segments overlap and the playlist lies about the timeline — the set played 130s and
// then livelocked on 15,107 aborted fetches. Every way of forcing our own boundaries in one run
// corrupted the output at the identical packet (`-segment_times` at PTS, at DTS, with
// `-segment_time_delta`, video-only, and `-segment_frames`). One continuous `-f hls` muxer choosing
// its own cuts was clean. So each epoch is exactly that: one run, ffmpeg's cuts, from a seek point.
//
// WHY NOT ONE EVER-GROWING PLAYLIST WITH EXT-X-DISCONTINUITY. A discontinuity tag says the encoding
// or timestamps changed; it does not represent the five thousand seconds missing between a region
// produced at 0 and one produced at 5200. A player may simply add the durations up. Whether some
// receiver handles a sparse timeline is a hardware question for later; the film's absolute
// position must not depend on the answer, so each epoch has its own playlist and Spritz keeps the
// logicalStart itself.
//
// PRODUCER LIFECYCLE belongs to the RUN and to nothing else. This is the first production caller of
// setProducerActive (through onActive): spawning the epoch's ffmpeg makes the producer active; its
// exit, error, explicit stop or supersession makes it inactive. Never an HTTP request — a real
// ffmpeg was measured making several Range requests per run and closing each before the next.
//
// INPUT is opaque: a local path now, a lan.serveSource() URL when the source is a torrent. ffmpeg
// treats both as `-i`, and nothing here forks on which it was given.

const fs = require('fs');
const path = require('path');

const finite = (n) => typeof n === 'number' && Number.isFinite(n);

// Target segment length. A target, not a floor: ffmpeg cuts at keyframes, so real durations follow
// the source's keyframe spacing. Same value the preseg path proved on hardware.
const DEFAULT_TARGET_SEC = 6;

// ffmpeg arguments for one epoch.
//
// -ss BEFORE -i: an INPUT seek. ffmpeg lands on the keyframe at or before T using the container's
// index, without decoding up to it — the only affordable seek into a two-hour file, and the only
// one that preserves a stream copy. The output therefore starts a keyframe lead-in EARLY; that
// lead-in is measured (noteFirstSegment) rather than assumed away.
//
// -copyts: source timestamps survive into the epoch's media, so subtitle alignment and any player
// that exposes PTS speak logical time directly. Whether a given receiver's currentTime is PTS-based
// or zero-based is measured on hardware and expressed as `clock` in toLogical below.
//
// -hls_flags temp_file: a segment is written to a temp name and RENAMED into place when complete,
// so a file that exists is a file that is whole. This is the muxer's own safe-visibility rule, and
// it is why an epoch depends on nothing like ensureSegment, which serves on existence.
//
// -hls_playlist_type event: an append-only playlist that ffmpeg finishes with ENDLIST when the run
// ends. A local file finishes in seconds; a torrent-backed run may not, and a player asking for
// the duration before ENDLIST gets none — that is inherent to producing on demand, not a defect.
//
// NOT -f segment, NOT -segment_times, NOT -reset_timestamps. See the module comment.
function epochArgs({ input, dir, logicalStart = 0, targetSec = DEFAULT_TARGET_SEC, copyAudio = true, audioTrack = 0, playlistType = 'event' } = {}) {
  if (!input || !dir) return null;
  // 'event' is append-only and finished with ENDLIST at exit. Measured on the LG: with no ENDLIST at
  // fetch time it is treated as LIVE and playback starts at the edge. 'vod' is the alternative to
  // measure against it — ffmpeg still writes ENDLIST only at exit, so growth is unchanged; whether
  // webOS honours a growing VOD-typed playlist as VOD is the hardware question the option exists
  // to ask.
  if (playlistType !== 'event' && playlistType !== 'vod') return null;
  const start = Number(logicalStart);
  if (!finite(start) || start < 0) return null;
  const target = Number(targetSec);
  if (!finite(target) || target <= 0) return null;
  return [
    '-loglevel', 'error', '-y',
    ...(start > 0 ? ['-ss', String(start)] : []),
    '-copyts',
    '-i', input,
    '-map', '0:v:0', '-map', '0:a:' + Number(audioTrack) + '?',
    '-c:v', 'copy',
    '-c:a', copyAudio ? 'copy' : 'aac', ...(copyAudio ? [] : ['-b:a', '192k']),
    '-avoid_negative_ts', 'disabled',
    '-muxdelay', '0', '-muxpreload', '0',
    '-f', 'hls',
    '-hls_time', String(target),
    '-hls_playlist_type', playlistType,
    '-hls_list_size', '0',
    '-hls_flags', 'temp_file',
    '-hls_segment_filename', path.join(dir, '%d.ts'),
    path.join(dir, 'media.m3u8')
  ];
}

// Epoch-local position <-> logical film position.
//
// clock — what the player's currentTime counts:
//   'pts'  the media's own timestamps, which with -copyts ARE logical time; local == logical.
//   'zero' from zero at the first frame it played, which is the epoch's first playable timestamp.
// A property of the receiver, measured on hardware; not chosen here.
// Millisecond precision: a playback clock is no finer, and floating-point residue in a position
// would otherwise masquerade as a measurement.
const ms = (n) => Math.round(n * 1000) / 1000;
function toLogical(epoch, localSec, clock) {
  if (!epoch || !finite(localSec)) return null;
  if (clock === 'pts') return localSec;
  const base = finite(epoch.firstPlayableSec) ? epoch.firstPlayableSec : epoch.logicalStart;
  return ms(localSec + base);
}
function toLocal(epoch, logicalSec, clock) {
  if (!epoch || !finite(logicalSec)) return null;
  if (clock === 'pts') return logicalSec;
  const base = finite(epoch.firstPlayableSec) ? epoch.firstPlayableSec : epoch.logicalStart;
  return ms(logicalSec - base);
}

// Where does a seek to `toLogical` go — inside the current epoch, or into a new one?
//
// Inside, when the epoch already holds that position: at or after its first playable timestamp and
// no later than what it has produced. A finished epoch has produced through to its end. Anything
// else is a new epoch at the requested position; a backward seek before the epoch began is the
// common case, because an epoch only ever runs forward from its start.
function planSeek({ epoch, toLogical: target, clock } = {}) {
  if (!finite(target) || target < 0) return null;
  if (!epoch) return { kind: 'new-epoch', logicalStart: target };
  const from = finite(epoch.firstPlayableSec) ? epoch.firstPlayableSec : epoch.logicalStart;
  const until = finite(epoch.producedUntilSec) ? epoch.producedUntilSec : from;
  const usable = epoch.state === 'producing' || epoch.state === 'done';
  if (usable && target >= from && target <= until) {
    return { kind: 'in-epoch', localSec: toLocal(epoch, target, clock) };
  }
  return { kind: 'new-epoch', logicalStart: target };
}

// The set of epochs for one session, and the runs behind them.
//
// spawn / ffmpeg   — injected so lifecycle is testable without a real process.
// root             — the session directory; each epoch owns exactly one subdirectory of it, and
//                    retire()/close() remove only those.
// onActive(bool)   — the producer lifecycle, to be forwarded to torrent.setProducerActive.
// probeFirstPts(file, cb) — reads the first segment's first timestamp, so the keyframe lead-in is
//                    a measurement. Injected because ffprobe is not available in every test.
function createEpochs({ spawn, ffmpeg, root, namespace = null, onActive = () => {}, probeFirstPts = (f, cb) => cb(null), log = () => {} } = {}) {
  if (typeof spawn !== 'function' || !ffmpeg || !root) throw new Error('createEpochs needs spawn, ffmpeg and root');
  if (namespace != null && !/^[A-Za-z0-9_-]+$/.test(namespace)) throw new Error('invalid epoch namespace');
  const prefix = namespace == null ? 'epoch-' : 'epoch-' + namespace + '-';
  const epochs = new Map();
  let seq = 0, currentId = null, active = false;

  function setActive(a) {
    if (active === !!a) return;
    active = !!a;
    try { onActive(active); } catch (e) {}
  }
  // The producer is active while the CURRENT epoch's run is alive. Superseding kills the old run
  // and starts the new one in the same breath, so production never reads as having stopped.
  function reconsider() {
    const cur = currentId && epochs.get(currentId);
    setActive(!!(cur && cur.proc));
  }

  function open({ mediaId, input, logicalStart = 0, targetSec, copyAudio, audioTrack, playlistType } = {}) {
    if (!mediaId || !input) return null;
    const start = finite(Number(logicalStart)) && Number(logicalStart) >= 0 ? Number(logicalStart) : 0;
    const id = prefix + (++seq);
    const dir = path.join(root, id);
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { return null; }
    const args = epochArgs({ input, dir, logicalStart: start, targetSec, copyAudio, audioTrack, playlistType });
    if (!args) return null;

    // The previous current epoch is superseded: its run is killed (it was producing film nobody is
    // going to watch from this transport), its files stay until retire() so a receiver mid-switch
    // still has them.
    const prev = currentId && epochs.get(currentId);
    if (prev && prev.proc) { try { prev.proc.kill('SIGKILL'); } catch (e) {} prev.proc = null; }
    if (prev) prev.state = 'superseded';

    const e = {
      id, mediaId: String(mediaId), input, dir,
      playlist: path.join(dir, 'media.m3u8'),
      logicalStart: start, requestedStart: start,
      firstPlayableSec: null, leadInSec: null, producedUntilSec: null,
      state: 'producing', exitCode: null, startedAt: Date.now(), endedAt: null, proc: null
    };
    epochs.set(id, e);
    currentId = id;

    let proc;
    try { proc = spawn(ffmpeg, args); } catch (er) {
      e.state = 'failed'; e.endedAt = Date.now();
      log(id + ' failed to spawn: ' + er.message);
      reconsider();
      return e;
    }
    e.proc = proc;
    if (proc.stderr) proc.stderr.on('data', () => {});
    const ended = (state, code) => {
      if (e.proc !== proc) return; // already stopped/superseded; the late event is not news
      e.proc = null; e.state = state; e.exitCode = code == null ? null : code; e.endedAt = Date.now();
      log(id + ' ' + state + (code != null ? ' (exit ' + code + ')' : ''));
      reconsider();
    };
    proc.on('error', () => ended('failed', null));
    proc.on('close', (code) => ended(code === 0 ? 'done' : 'failed', code));
    log(id + ' started at logical ' + start + 's');
    reconsider();
    return e;
  }

  // The first segment exists: measure where the epoch ACTUALLY begins. `-ss` lands on the keyframe
  // at or before the request, so the difference is the lead-in — recorded, never assumed.
  //
  // `done` fires once the measurement is in (or was already known, or could not be made): the probe
  // is a process, and a caller about to hand out the epoch wants the number, not a promise of it.
  function noteFirstSegment(id, file, done = () => {}) {
    const e = epochs.get(id);
    if (!e || e.firstPlayableSec !== null) return done();
    if (e.measurement) { e.measurement.waiters.push(done); return; }
    const job = e.measurement = { waiters: [done], finished: false, cancelled: false, dispose: null };
    const finish = (pts) => {
      if (job.finished) return;
      job.finished = true;
      e.measurement = null;
      if (epochs.get(id) === e && finite(pts) && e.firstPlayableSec === null) {
        e.firstPlayableSec = pts;
        e.leadInSec = Math.round((e.requestedStart - pts) * 1000) / 1000;
        log(id + ' first playable ' + pts + 's (asked ' + e.requestedStart + 's, lead-in ' + e.leadInSec + 's)');
      }
      for (const waiter of job.waiters.splice(0)) {
        try { waiter(); } catch (er) { log(id + ' timestamp waiter failed: ' + er.message); }
      }
    };
    job.cancel = () => {
      if (job.finished) return;
      job.cancelled = true;
      finish(null);
      if (typeof job.dispose === 'function') job.dispose();
    };
    try {
      job.dispose = probeFirstPts(file, finish);
      if (job.cancelled && typeof job.dispose === 'function') job.dispose();
    } catch (er) { finish(null); }
  }

  function noteProducedUntil(id, sec) {
    const e = epochs.get(id);
    if (e && finite(sec)) e.producedUntilSec = sec;
  }

  function stop(id) {
    const e = epochs.get(id);
    if (!e) return;
    if (e.proc) { try { e.proc.kill('SIGKILL'); } catch (er) {} e.proc = null; }
    if (e.state === 'producing') e.state = 'stopped';
    e.endedAt = e.endedAt || Date.now();
    reconsider();
  }
  // Remove one epoch's directory — and only that.
  function retire(id) {
    const e = epochs.get(id);
    if (!e) return;
    stop(id);
    try { fs.rmSync(e.dir, { recursive: true, force: true }); } catch (er) {}
    epochs.delete(id);
    if (e.measurement) e.measurement.cancel();
    if (currentId === id) currentId = null;
    reconsider();
  }
  function close() { for (const id of Array.from(epochs.keys())) retire(id); setActive(false); }

  const view = (e) => e && Object.assign({}, e, { proc: undefined, measurement: undefined, running: !!e.proc });
  return {
    open, stop, retire, close, noteFirstSegment, noteProducedUntil,
    get: (id) => view(epochs.get(id)),
    current: () => view(currentId && epochs.get(currentId)),
    list: () => Array.from(epochs.values()).map(view),
    active: () => active
  };
}

module.exports = { epochArgs, createEpochs, toLogical, toLocal, planSeek, DEFAULT_TARGET_SEC };
