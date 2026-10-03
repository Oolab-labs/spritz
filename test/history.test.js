'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const source = fs.readFileSync(path.join(__dirname, '../src/main/history.js'), 'utf8');
const key = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);
function setup(t, io = fs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spritz-history-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const timers = new Map(); let next = 0;
  function load() {
    const ctx = { module: { exports: {} }, console: { warn() {} },
      require: (n) => n === 'electron' ? { app: { getPath: () => dir } } : n === 'fs' ? io : require(n),
      setTimeout: (cb) => { timers.set(++next, cb); return next; }, clearTimeout: (id) => timers.delete(id) };
    vm.runInNewContext(source, ctx);
    return ctx.module.exports();
  }
  return { dir, load, timers };
}
test('orderly flush saves the latest history and preferences, clears debounce, and reloads', (t) => {
  const { load, timers } = setup(t), h = load();
  h.save('film', 40, 100, 'Film');
  h.setPref('show', { audioLang: 'eng', subDelay: 0.1 });
  h.setPref('show', { audioLang: 'jpn', subDelay: 0.7 });
  assert.equal(h.flush(), true); assert.equal(timers.size, 0);
  const reopened = load();
  assert.equal(reopened.get('film').pos, 40);
  assert.equal(reopened.getPref('show').audioLang, 'jpn');
  assert.equal(reopened.getPref('show').subDelay, 0.7);
});
for (const seed of ['[]', 'true', 'null', '{broken']) {
  test('malformed stores recover and preserve original bytes: ' + seed, (t) => {
    const { dir, load } = setup(t);
    for (const name of ['watch-history.json', 'lang-prefs.json']) fs.writeFileSync(path.join(dir, name), seed);
    const h = load(); h.save('film', 10, 100); h.setPref('show', { subLang: 'fra' });
    assert.equal(h.flush(), true);
    const reopened = load(); assert.equal(reopened.get('film').pos, 10); assert.equal(reopened.getPref('show').subLang, 'fra');
    const copies = fs.readdirSync(dir).filter((n) => n.includes('.invalid-'));
    assert.equal(copies.length, 2);
    for (const n of copies) assert.equal(fs.readFileSync(path.join(dir, n), 'utf8'), seed);
  });
}
test('valid entries survive mixed malformed entries; invalid preferences never reach playback', (t) => {
  const { dir, load } = setup(t);
  fs.writeFileSync(path.join(dir, 'watch-history.json'), JSON.stringify({
    [key('film')]: { src: 'film', pos: 20, dur: 100, title: 'Film', ts: 1 }, [key('bad')]: null }));
  fs.writeFileSync(path.join(dir, 'lang-prefs.json'), JSON.stringify({
    [key('show')]: { audioLang: 'jpn', speed: 'fast', zoom: 100, subDelay: 40, ts: 1 } }));
  const h = load(); assert.equal(h.get('film').pos, 20); assert.equal(h.recents().length, 1);
  assert.equal(h.getPref('show').audioLang, 'jpn'); assert.equal(h.getPref('show').speed, undefined);
  h.setPref('show', { speed: NaN, audioDelay: Infinity }); h.save('bad', NaN, 10);
  assert.equal(h.get('bad'), null); assert.equal(h.flush(), true);
  assert.equal(load().get('film').pos, 20);
});
test('failed writes keep prior files intact and a later flush retries both stores', (t) => {
  let fail = false;
  const io = Object.create(fs); io.renameSync = (...args) => { if (fail) throw new Error('disk unavailable'); return fs.renameSync(...args); };
  const { load, dir } = setup(t, io); const h = load();
  h.save('film', 10, 100); h.setPref('show', { subLang: 'eng' }); h.flush();
  fail = true; h.save('film', 20, 100); h.setPref('show', { subLang: 'fra' }); assert.equal(h.flush(), false);
  assert.equal(load().get('film').pos, 10); assert.equal(load().getPref('show').subLang, 'eng');
  assert.equal(fs.readdirSync(dir).some((n) => n.includes('.tmp-')), false);
  fail = false; assert.equal(h.flush(), true);
  assert.equal(load().get('film').pos, 20); assert.equal(load().getPref('show').subLang, 'fra');
});
test('failed preservation never overwrites malformed original storage', (t) => {
  const io = Object.create(fs); io.copyFileSync = () => { throw new Error('backup unavailable'); };
  const { dir, load } = setup(t, io); const file = path.join(dir, 'watch-history.json');
  fs.writeFileSync(file, '[]'); const h = load(); h.save('film', 10, 100); assert.equal(h.flush(), false);
  assert.equal(fs.readFileSync(file, 'utf8'), '[]');
});
