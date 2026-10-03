'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { createReceiverSubtitles } = require('../src/main/receiver-subtitles');
function fixture(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'receiver-sub-test-'));
  const children = [];
  const server = createReceiverSubtitles({ input: 'http://localhost/fake', tracks: [{ id: 'source-subtitle-0', idx: 0, lang: 'eng' }],
    dir, baseUrl: 'http://localhost/hls/token/', ffmpeg: 'fake', duration: 3600, sampleMs: 5, retryMs: 0,
    spawnProcess: (binary, args) => {
      const child = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = signal => { child.signal = signal; };
      child.file = args[args.length - 1]; child.args = args; children.push(child); return child;
    }, ...options });
  const name = server.entries[0].url.split('/').pop();
  return { server, children, name, dir, close: () => { server.destroy(); fs.rmSync(dir, { recursive: true, force: true }); } };
}
const cue = 'WEBVTT\n\n00:00:01.000 --> 00:00:10.000\nhello\n\n';
test('embedded subtitle worker owns source priority through completion and final cancellation', () => {
  for (const finish of ['close', 'cancel']) {
    const calls = [];
    const f = fixture({ acquireInput: () => ({ url: 'http://localhost/owned-subtitle', setActive: a => calls.push(a), dispose: () => calls.push('dispose') }) });
    try {
      f.server.prepare(f.name, 'owner', 1);
      assert.equal(f.children[0].args[f.children[0].args.indexOf('-i') + 1], 'http://localhost/owned-subtitle');
      assert.deepEqual(calls, [true]);
      if (finish === 'cancel') f.server.cancel(f.name, 'owner');
      f.children[0].emit('close', 255, 'SIGKILL');
      assert.deepEqual(calls, [true, 'dispose']);
    } finally { f.close(); }
  }
});
test('subtitle spawn failure releases source priority and rejected admission starts no child', () => {
  let disposed = 0;
  const f = fixture({ acquireInput: () => ({ url: 'owned', dispose: () => disposed++ }), spawnProcess: () => { throw Error('spawn'); } });
  try { assert.equal(f.server.prepare(f.name, 'owner', 1).status, 'failed'); assert.equal(disposed, 1); } finally { f.close(); }
  const g = fixture({ acquireInput: () => null });
  try { assert.equal(g.server.prepare(g.name, 'owner', 1).status, 'failed'); assert.equal(g.children.length, 0); } finally { g.close(); }
});
test('partial revision cannot become permanent EOF and later seek starts new extraction', () => {
  const f = fixture();
  try {
    assert.equal(f.server.prepare(f.name, 'owner', 1).status, 'pending');
    fs.writeFileSync(f.children[0].file, cue); f.children[0].emit('close', 255, 'SIGTERM');
    const ready = f.server.prepare(f.name, 'owner', 1);
    assert.equal(ready.status, 'ready'); assert.equal(ready.complete, false); assert.equal(ready.cueEnd, 10);
    f.server.cancel(f.name, 'owner');
    // Retry cooldown is injected as zero; production retains a bounded retry delay.
    const later = f.server.prepare(f.name, 'later', 600);
    assert.notEqual(later.status, 'ready'); assert.equal(later.complete, false); assert.equal(f.children.length, 2);
  } finally { f.close(); }
});
test('successful EOF is reusable across sparse trailing gaps and backwards seeks', () => {
  const f = fixture();
  try {
    f.server.prepare(f.name, 'owner', 0); fs.writeFileSync(f.children[0].file, cue); f.children[0].emit('close', 0, null);
    for (const pos of [0, 600, 3590]) {
      const result = f.server.prepare(f.name, 'owner', pos); assert.equal(result.status, 'ready'); assert.equal(result.complete, true);
    }
    assert.equal(f.children.length, 1);
  } finally { f.close(); }
});
test('empty successful EOF is ready, whereas header-only interrupted extraction is failed', () => {
  for (const successful of [true, false]) {
    const f = fixture();
    try {
      f.server.prepare(f.name, 'owner', 1); fs.writeFileSync(f.children[0].file, 'WEBVTT\n');
      f.children[0].emit('close', successful ? 0 : 255, successful ? null : 'SIGTERM');
      assert.equal(f.server.prepare(f.name, 'owner', 1).status, successful ? 'ready' : 'pending');
    } finally { f.close(); }
  }
});
test('matching owner cancellation preserves another owner and final cancellation kills work', () => {
  const f = fixture();
  try {
    f.server.prepare(f.name, 'first', 1); f.server.prepare(f.name, 'second', 1);
    f.server.cancel(f.name, 'unrelated'); assert.equal(f.children[0].signal, undefined);
    f.server.cancel(f.name, 'first'); assert.equal(f.children[0].signal, undefined);
    f.server.cancel(f.name, 'second'); assert.equal(f.children[0].signal, 'SIGKILL');
  } finally { f.close(); }
});
test('complete cues publish before worker exit and revision files are immutable', async () => {
  const f = fixture();
  try {
    f.server.prepare(f.name, 'owner', 1); fs.writeFileSync(f.children[0].file, cue);
    await new Promise(resolve => setTimeout(resolve, 20));
    const result = f.server.prepare(f.name, 'owner', 1); assert.equal(result.status, 'ready'); assert.equal(result.complete, false);
    const originalFile = path.join(f.dir, result.url.split('/').pop()), original = fs.readFileSync(originalFile, 'utf8');
    fs.appendFileSync(f.children[0].file, '\n00:00:11.000 --> 00:00:15.000\nnext\n\n');
    await new Promise(resolve => setTimeout(resolve, 20));
    const next = f.server.prepare(f.name, 'owner', 12); assert.notEqual(next.revision, result.revision);
    assert.equal(fs.readFileSync(originalFile, 'utf8'), original);
  } finally { f.close(); }
});

test('late EOF preserves its extraction start and cannot cover a backward seek', () => {
  const f = fixture({ retryMs: 5000 });
  try {
    f.server.prepare(f.name, 'owner', 600); fs.writeFileSync(f.children[0].file, cue); f.children[0].emit('close', 0, null);
    const result = f.server.prepare(f.name, 'owner', 600);
    assert.equal(result.status, 'ready'); assert.equal(result.complete, true); assert.equal(result.eof, true); assert.equal(result.rangeStart, 585);
    assert.equal(f.server.prepare(f.name, 'owner', 10).status, 'pending'); assert.equal(f.children.length, 2);
  } finally { f.close(); }
});

test('failed extraction cooldown avoids repeated readers and is retryable', () => {
  const f = fixture({ retryMs: 5000 });
  try {
    f.server.prepare(f.name, 'owner', 1); fs.writeFileSync(f.children[0].file, 'WEBVTT\n'); f.children[0].emit('close', 255, 'SIGTERM');
    const result = f.server.prepare(f.name, 'owner', 1);
    assert.equal(result.status, 'failed'); assert.equal(result.retryAfterMs, 5000); assert.equal(f.children.length, 1);
  } finally { f.close(); }
});

test('demux I/O errors cannot become complete even when ffmpeg exits zero', () => {
  const f = fixture();
  try {
    f.server.prepare(f.name, 'owner', 1);
    assert.ok(f.children[0].args.includes('-xerror'));
    fs.writeFileSync(f.children[0].file, cue.trimEnd() + '\n');
    f.children[0].stderr.emit('data', 'Stream ends prematurely; Error during demuxing: Input/output error');
    f.children[0].emit('close', 0, null);
    const result = f.server.prepare(f.name, 'owner', 1);
    assert.equal(result.status, 'ready'); assert.equal(result.complete, false); assert.equal(result.cueEnd, 10);
    assert.notEqual(f.server.prepare(f.name, 'owner', 600).status, 'ready'); assert.equal(f.children.length, 2);
  } finally { f.close(); }
});
