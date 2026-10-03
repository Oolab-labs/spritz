'use strict';

// Stable source keys keep resume independent of temporary playback URLs.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app } = require('electron');
const object = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const finite = (v) => typeof v === 'number' && Number.isFinite(v);

function historyEntry(v) {
  if (!object(v) || typeof v.src !== 'string' || !v.src || !finite(v.pos) || v.pos < 0 ||
      !finite(v.dur) || v.dur <= 0 || !finite(v.ts)) return null;
  return { src: v.src, pos: v.pos, dur: v.dur, title: typeof v.title === 'string' ? v.title : '', ts: v.ts };
}
function preferenceEntry(v) {
  if (!object(v)) return null;
  const out = {};
  for (const k of ['audioLang', 'subLang']) if (typeof v[k] === 'string' && v[k]) out[k] = v[k];
  for (const k of ['subDelay', 'audioDelay']) if (finite(v[k]) && Math.abs(v[k]) <= 30) out[k] = v[k];
  if (finite(v.speed) && v.speed > 0) out.speed = v.speed;
  if (finite(v.zoom) && v.zoom >= -0.5 && v.zoom <= 1) out.zoom = v.zoom;
  if (finite(v.ts)) out.ts = v.ts;
  return out;
}

// Invalid input is retained before a recovered store is published. Never overwrite
// an unreadable file or a store we could not back up.
function store(file, validate) {
  let data = {}, dirty = false, timer = null, writable = true;
  try {
    const raw = fs.readFileSync(file, 'utf8');
    let parsed;
    try { parsed = JSON.parse(raw); } catch (e) { parsed = null; }
    let invalid = !object(parsed);
    if (object(parsed)) {
      for (const [key, value] of Object.entries(parsed)) {
        const entry = validate(value);
        if (!entry || !/^[a-f0-9]{16}$/.test(key)) { invalid = true; continue; }
        data[key] = entry;
        if (JSON.stringify(entry) !== JSON.stringify(value)) invalid = true;
      }
    }
    if (invalid) {
      fs.copyFileSync(file, file + '.invalid-' + crypto.randomBytes(6).toString('hex'), fs.constants.COPYFILE_EXCL);
      dirty = true;
    }
  } catch (e) {
    if (e.code !== 'ENOENT') { writable = false; console.warn('[history] Could not load/preserve store:', e.message); }
  }
  function flush() {
    clearTimeout(timer); timer = null;
    if (!dirty) return true;
    if (!writable) return false;
    const tmp = file + '.tmp-' + crypto.randomBytes(6).toString('hex');
    try {
      fs.writeFileSync(tmp, JSON.stringify(data));
      fs.renameSync(tmp, file);
      dirty = false;
      return true;
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch (_) {}
      console.warn('[history] Could not save store:', e.message);
      return false;
    }
  }
  function changed() { dirty = true; clearTimeout(timer); timer = setTimeout(flush, 1500); }
  return { data, changed, flush };
}

module.exports = function createHistory() {
  const history = store(path.join(app.getPath('userData'), 'watch-history.json'), historyEntry);
  const preferences = store(path.join(app.getPath('userData'), 'lang-prefs.json'), preferenceEntry);
  const data = history.data, prefs = preferences.data;
  const keyOf = (k) => crypto.createHash('sha1').update(String(k)).digest('hex').slice(0, 16);
  function trim(records, limit) {
    Object.keys(records).sort((a, b) => (records[b].ts || 0) - (records[a].ts || 0))
      .slice(limit).forEach((k) => delete records[k]);
  }
  function get(src) { return (src && data[keyOf(src)]) || null; }
  function save(src, pos, dur, title) {
    const entry = historyEntry({ src: src ? String(src) : '', pos, dur, title, ts: Date.now() });
    if (!entry) return;
    data[keyOf(src)] = entry; trim(data, 200); history.changed();
  }
  function remove(src) { if (src) { delete data[keyOf(src)]; history.changed(); } }
  function recents(n) { return Object.values(data).sort((a, b) => b.ts - a.ts).slice(0, n || 30); }
  function getPref(key) { return (key && prefs[keyOf(key)]) || null; }
  function setPref(key, partial) {
    const entry = preferenceEntry(partial);
    if (!key || !entry || !Object.keys(entry).some((k) => k !== 'ts')) return;
    const k = keyOf(key);
    prefs[k] = Object.assign({}, prefs[k], entry, { ts: Date.now() });
    trim(prefs, 300); preferences.changed();
  }
  function flush() {
    // Evaluate both even if one write fails; the existing before-quit hook calls this.
    const a = history.flush(), b = preferences.flush();
    return a && b;
  }
  return { get, save, remove, recents, flush, getPref, setPref };
};
