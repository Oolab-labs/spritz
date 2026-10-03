'use strict';

// A transport epoch against a REAL ffmpeg and a real (synthetic) film: does one `-f hls` run from
// an arbitrary logical position produce media that is clean across every boundary ffmpeg chose?
//
// This is the local-file half of the proof — no torrent, no television — so that the media design
// is judged on its own. Each epoch is held to the same gate that caught the forced-boundary
// corruption before it cost a hardware round: ffmpeg's own HLS demuxer reading the playlist back
// with `-c copy -f null` must be SILENT, and the packet timeline must be monotonic.

const { test } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { createEpochs, epochArgs } = require('../src/main/transport-epoch');

const FFMPEG = ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg'].find((p) => fs.existsSync(p));
const FFPROBE = ['/opt/homebrew/bin/ffprobe', '/usr/local/bin/ffprobe', '/usr/bin/ffprobe'].find((p) => fs.existsSync(p));
const SKIP = (!FFMPEG || !FFPROBE) && 'ffmpeg/ffprobe not installed';

// 400 seconds, so an epoch at 300 is materially distant from one at 0. Keyframes every 2s (50 frames
// at 25fps), so the lead-in of an input seek is bounded and measurable.
function film(dir) {
  const src = path.join(dir, 'film.mkv');
  execFileSync(FFMPEG, ['-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=25:duration=400',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=400',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '50', '-keyint_min', '50', '-sc_threshold', '0',
    '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', src]);
  return src;
}

function firstPts(file, cb) {
  try {
    const out = execFileSync(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts_time',
      '-read_intervals', '%+#1', '-of', 'csv=p=0', file]).toString().trim().split('\n')[0];
    cb(Number(String(out).split(',')[0])); // csv rows end in a trailing comma
  } catch (e) { cb(null); }
}

// The gate. Silence is the pass condition; any `Packet corrupt` or `timestamp discontinuity` is
// exactly the fault the forced-boundary experiments produced.
function gate(playlist) {
  const r = require('child_process').spawnSync(FFMPEG, ['-v', 'warning', '-i', playlist, '-c', 'copy', '-f', 'null', '-'], { encoding: 'utf8' });
  return { status: r.status, stderr: (r.stderr || '').trim() };
}
// The video packet timeline as the HLS demuxer sees it across the whole epoch.
function dtsTimeline(playlist) {
  const out = execFileSync(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=dts_time', '-of', 'csv=p=0', playlist]).toString();
  return out.trim().split('\n').map((l) => Number(l.split(',')[0])).filter(Number.isFinite);
}
const untilDone = (epochs, id, ms = 60000) => new Promise((resolve) => {
  const t0 = Date.now();
  const poll = () => { const e = epochs.get(id); if (!e || !e.running || Date.now() - t0 > ms) return resolve(e); setTimeout(poll, 50); };
  poll();
});

test('epochs at 0 and at 300 each package cleanly with ffmpeg-chosen boundaries', { skip: SKIP, timeout: 300000 }, async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'spritz-epochff-'));
  const active = [];
  const epochs = createEpochs({ spawn, ffmpeg: FFMPEG, root: work, onActive: (a) => active.push(a), probeFirstPts: firstPts });
  try {
    const src = film(work);
    const results = {};
    for (const T of [0, 300]) {
      const e = epochs.open({ mediaId: 'film', input: src, logicalStart: T });
      assert.ok(e, 'epoch opened at ' + T);
      const done = await untilDone(epochs, e.id);
      assert.equal(done.state, 'done', 'the run finished cleanly at ' + T + ' (exit ' + done.exitCode + ')');
      assert.ok(fs.existsSync(e.playlist), 'a playlist was written');

      const pl = fs.readFileSync(e.playlist, 'utf8');
      const segs = pl.split('\n').filter((l) => /^\d+\.ts$/.test(l));
      assert.ok(segs.length >= 3, 'several segments (' + segs.length + ')');
      assert.ok(/#EXT-X-ENDLIST/.test(pl), 'finite: ffmpeg wrote ENDLIST when the run ended');
      assert.ok(!/#EXT-X-DISCONTINUITY/.test(pl), 'one continuous timeline, no discontinuities inside an epoch');
      for (const s of segs) assert.ok(fs.existsSync(path.join(e.dir, s)), s + ' exists (no leftover .tmp)');
      assert.ok(!fs.readdirSync(e.dir).some((f) => /\.tmp$/.test(f)), 'no half-written segment is visible');

      // The gate: ffmpeg reads its own output back and says nothing.
      const g = gate(e.playlist);
      assert.equal(g.status, 0, 'the gate ran');
      assert.equal(g.stderr, '', 'the gate is SILENT for the epoch at ' + T + ' — got: ' + g.stderr.slice(0, 200));

      // Monotonic across every boundary ffmpeg chose.
      const dts = dtsTimeline(e.playlist);
      assert.ok(dts.length > 100, 'a real timeline (' + dts.length + ' packets)');
      for (let i = 1; i < dts.length; i++) assert.ok(dts[i] >= dts[i - 1], 'dts went backwards at packet ' + i + ' (' + dts[i - 1] + ' -> ' + dts[i] + ')');

      // Where the epoch actually begins, measured.
      epochs.noteFirstSegment(e.id, path.join(e.dir, segs[0]));
      const m = epochs.get(e.id);
      assert.ok(Number.isFinite(m.firstPlayableSec), 'the first playable timestamp was measured');
      assert.ok(m.firstPlayableSec <= T + 0.05, 'the epoch starts at or before the request (' + m.firstPlayableSec + ' for ' + T + ')');
      assert.ok(T - m.firstPlayableSec <= 2.1, 'and no more than one keyframe interval early (lead-in ' + m.leadInSec + 's)');
      results[T] = { requested: T, firstPlayable: m.firstPlayableSec, leadIn: m.leadInSec, segments: segs.length, lastDts: dts[dts.length - 1] };
    }
    // Source timestamps survived: the 300 epoch's timeline is in film time, not from zero.
    assert.ok(results[300].firstPlayable >= 290, 'the epoch at 300 carries logical timestamps (first ' + results[300].firstPlayable + ')');
    assert.ok(results[300].lastDts > 390, 'and runs to the end of the film');
    assert.ok(results[0].lastDts > 390);
    // Lifecycle, through real processes: active on each start, inactive on each clean exit.
    assert.deepEqual(active, [true, false, true, false]);
    console.log('epoch measurements: ' + JSON.stringify(results));
  } finally {
    epochs.close();
    fs.rmSync(work, { recursive: true, force: true });
  }
});

test('the real command carries no forced-boundary arguments', () => {
  const args = epochArgs({ input: '/f.mkv', dir: '/d', logicalStart: 300 });
  assert.ok(!args.includes('segment') && !args.includes('-segment_times') && !args.includes('-segment_frames'));
});
