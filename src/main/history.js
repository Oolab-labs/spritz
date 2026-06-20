'use strict';

// Watch history / resume positions (main process). Persists per-source playback position
// to userData/watch-history.json, keyed by a hash of the ORIGINAL source string (file path,
// magnet, or page URL — stable across sessions, unlike the resolved localhost/temp URLs).
// Stores the source too, so the "recents" feature can re-open entries later.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app } = require('electron');

module.exports = function createHistory() {
  const FILE = path.join(app.getPath('userData'), 'watch-history.json');
  let data = {};
  try { data = JSON.parse(fs.readFileSync(FILE, 'utf8')) || {}; } catch (e) { data = {}; }

  let writeTimer = null;
  function flush() { try { fs.writeFileSync(FILE, JSON.stringify(data)); } catch (e) {} }
  function scheduleFlush() { clearTimeout(writeTimer); writeTimer = setTimeout(flush, 1500); }
  const keyOf = (k) => crypto.createHash('sha1').update(String(k)).digest('hex').slice(0, 16);

  function get(src) { return (src && data[keyOf(src)]) || null; }

  function save(src, pos, dur, title) {
    if (!src || !dur || pos == null) return;
    data[keyOf(src)] = { src: String(src), pos, dur, title: title || '', ts: Date.now() };
    const keys = Object.keys(data);
    if (keys.length > 200) { // cap: drop the oldest beyond 200
      keys.sort((a, b) => (data[b].ts || 0) - (data[a].ts || 0)).slice(200).forEach((k) => delete data[k]);
    }
    scheduleFlush();
  }

  function remove(src) { if (src) { delete data[keyOf(src)]; scheduleFlush(); } } // call on finish
  function recents(n) {
    return Object.values(data).sort((a, b) => (b.ts || 0) - (a.ts || 0)).slice(0, n || 30);
  }

  // ---- per-show audio/subtitle language preferences (keyed by the show's folder/group) ----
  // So every episode of a series doesn't revert to the file's default track. Stored separately from
  // resume positions; merged-update so an audio pick and a sub pick can be recorded independently.
  const PFILE = path.join(app.getPath('userData'), 'lang-prefs.json');
  let prefs = {};
  try { prefs = JSON.parse(fs.readFileSync(PFILE, 'utf8')) || {}; } catch (e) { prefs = {}; }
  let pTimer = null;
  function pFlush() { try { fs.writeFileSync(PFILE, JSON.stringify(prefs)); } catch (e) {} }
  function getPref(key) { return (key && prefs[keyOf(key)]) || null; }
  function setPref(key, partial) {
    if (!key || !partial) return;
    const k = keyOf(key);
    prefs[k] = Object.assign({}, prefs[k], partial, { ts: Date.now() });
    const keys = Object.keys(prefs);
    if (keys.length > 300) keys.sort((a, b) => (prefs[b].ts || 0) - (prefs[a].ts || 0)).slice(300).forEach((x) => delete prefs[x]);
    clearTimeout(pTimer); pTimer = setTimeout(pFlush, 1500);
  }

  return { get, save, remove, recents, flush, getPref, setPref };
};
