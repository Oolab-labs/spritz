'use strict';
// A probe that fails has learned nothing about the file. Letting it overwrite a good reading is the
// difference between a stream copy and a blind 4K re-encode.
//
// Captured at 05:58 on a real session: a recovery fired four resolves in four seconds against the same
// torrent URL. Three probed it correctly — hevc 3840x1920, DV profile 8, dur 3782s, 40 subtitle tracks
// — and the fourth exhausted its retry ladder against an empty swarm. Because probeKey() needs
// statSync and every torrent is an http:// URL, nothing was memoised, so the loser reached the planner
// with info=null and planned `h264 0x0, videoCopied:false, audioCopied:false`.
const test = require('node:test');
const assert = require('node:assert');
const { rememberProbe, recallProbe, memoProbe } = require('../src/main/lanserver')._probeMemory;

const URL = 'http://localhost:63856/webtorrent/abc/Example.Show.S01E01.mkv';
const GOOD = { vcodec: 'hevc', width: 3840, height: 1920, hdr: true, dovi: true, doviProfile: 8, dur: 3782 };

test('a successful reading is remembered and recalled', () => {
  rememberProbe('tracks', URL, GOOD);
  assert.deepStrictEqual(recallProbe('tracks', URL), GOOD);
});

test('a source never read successfully recalls nothing', () => {
  assert.strictEqual(recallProbe('tracks', 'http://localhost/never-seen.mkv'), null);
});

test('the tag namespaces the memory, so probe and tracks cannot cross-contaminate', () => {
  rememberProbe('tracks', URL, GOOD);
  assert.strictEqual(recallProbe('probe', URL), null);
});

test('a failure is not remembered as an answer', () => {
  rememberProbe('tracks', 'http://localhost/x.mkv', null);
  assert.strictEqual(recallProbe('tracks', 'http://localhost/x.mkv'), null);
});

test('THE INCIDENT: a good probe then a failed one yields the good answer, not null', (t, done) => {
  const input = 'http://localhost/incident.mkv';
  memoProbe('tracks', input, (k) => k(GOOD), (first) => {
    assert.deepStrictEqual(first, GOOD, 'the successful probe returns the real answer');
    // …the swarm empties and the next probe times out entirely.
    memoProbe('tracks', input, (k) => k(null), (second) => {
      assert.deepStrictEqual(second, GOOD, 'the failure must reuse the good reading, not plan blind');
      done();
    });
  });
});

test('a source with no history still reports failure honestly rather than inventing one', (t, done) => {
  memoProbe('tracks', 'http://localhost/unknown-' + Math.random() + '.mkv', (k) => k(null), (res) => {
    assert.strictEqual(res, null, 'never read successfully → the caller must still see the failure');
    done();
  });
});

test('a later successful probe replaces the remembered one', (t, done) => {
  const input = 'http://localhost/updated.mkv';
  const better = Object.assign({}, GOOD, { audio: [{ idx: 0, codec: 'eac3' }] });
  memoProbe('tracks', input, (k) => k(GOOD), () => {
    memoProbe('tracks', input, (k) => k(better), (res) => {
      assert.deepStrictEqual(res, better);
      assert.deepStrictEqual(recallProbe('tracks', input), better);
      done();
    });
  });
});

test('the memory is bounded, so a long session cannot grow it without limit', () => {
  for (let i = 0; i < 80; i++) rememberProbe('tracks', 'http://localhost/f' + i + '.mkv', GOOD);
  // The most recent entry always survives; the map is cleared rather than grown past its bound.
  assert.deepStrictEqual(recallProbe('tracks', 'http://localhost/f79.mkv'), GOOD);
});

test('changed local revision cannot fall back to the prior codec reading', () => {
  const fs = require('fs'), os = require('os'), path = require('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spritz-probe-revision-'));
  const file = path.join(dir, 'movie.mkv');
  try {
    fs.writeFileSync(file, 'old'); rememberProbe('tracks', file, GOOD);
    fs.writeFileSync(file, 'replacement-longer');
    let result;
    memoProbe('tracks', file, (done) => done(null), (value) => { result = value; });
    assert.strictEqual(result, null);
    assert.strictEqual(recallProbe('tracks', file), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('local replacement during a probe rejects its result before cache publication', () => {
  const fs = require('fs'), os = require('os'), path = require('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spritz-probe-revision-'));
  const file = path.join(dir, 'movie.mkv');
  try {
    fs.writeFileSync(file, 'old'); let finish, result;
    memoProbe('tracks', file, (done) => { finish = done; }, (value) => { result = value; });
    fs.writeFileSync(file, 'newer-longer'); finish(GOOD);
    assert.strictEqual(result, null);
    assert.strictEqual(recallProbe('tracks', file), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('memoized completion is single-shot and completed disposal does not kill a finished job', () => {
  let finish, calls = 0, disposed = 0;
  const cancel = memoProbe('tracks', 'http://localhost/single-shot-unique', (done) => {
    finish = done; return () => disposed++;
  }, () => calls++);
  finish(GOOD); finish(null); cancel();
  assert.strictEqual(calls, 1); assert.strictEqual(disposed, 0);
});

function withLocalProbeFile(fn) {
  const fs = require('fs'), os = require('os'), path = require('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spritz-shared-probe-'));
  const file = path.join(dir, 'movie.mkv'); fs.writeFileSync(file, 'fixture');
  try { fn(file); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
test('concurrent revision probes share work with independent caller cancellation', () => withLocalProbeFile((file) => {
  let finish, runs = 0, disposed = 0; const results = [];
  const run = (done) => { runs++; finish = done; return () => disposed++; };
  const cancelA = memoProbe('tracks', file, run, (r) => results.push(['A', r]));
  memoProbe('tracks', file, run, (r) => results.push(['B', r]));
  assert.strictEqual(runs, 1); cancelA(); assert.strictEqual(disposed, 0);
  finish(GOOD); assert.deepStrictEqual(results, [['B', GOOD]]);
}));
test('last shared owner cancellation disposes once and lets a new job start', () => withLocalProbeFile((file) => {
  const completions = []; let disposed = 0, results = 0;
  const run = (done) => { completions.push(done); return () => disposed++; };
  const a = memoProbe('tracks', file, run, () => results++);
  const b = memoProbe('tracks', file, run, () => results++);
  a(); b(); b(); assert.strictEqual(disposed, 1);
  memoProbe('tracks', file, run, () => results++);
  assert.strictEqual(completions.length, 2);
  completions[0](GOOD); assert.strictEqual(results, 0);
  completions[1](GOOD); assert.strictEqual(results, 1);
}));
test('different probe schemas do not share a child', () => withLocalProbeFile((file) => {
  let runs = 0;
  const run = () => { runs++; return () => {}; };
  const a = memoProbe('tracks', file, run, () => {});
  const b = memoProbe('probe', file, run, () => {});
  assert.strictEqual(runs, 2); a(); b();
}));
