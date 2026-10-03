'use strict';

// Remember the main window's size and position between launches.
//
// Pure except for load/save. The hard part is not storing four numbers, it is restoring them safely: a window
// saved on a monitor that has since been unplugged must not open off-screen, a corrupt file must not stop the
// app starting, and a nonsense size must not produce a window nobody can resize.
const fs = require('fs');
const path = require('path');

const MIN_W = 520, MIN_H = 400;            // matches the BrowserWindow minimum
const MIN_VISIBLE = 0.5;                   // at least half the window must be on a screen to keep its position

const finite = (n) => typeof n === 'number' && Number.isFinite(n);

function overlap(a, b) {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

function restore(saved, displays, fallback) {
  if (!saved || typeof saved !== 'object' || !finite(saved.width) || !finite(saved.height) || saved.width <= 0 || saved.height <= 0) {
    return { width: fallback.width, height: fallback.height };
  }
  const areas = (displays || []).map((d) => d && d.workArea).filter((a) => a && finite(a.width) && finite(a.height));
  const maxW = areas.length ? Math.max(...areas.map((a) => a.width)) : Infinity;
  const maxH = areas.length ? Math.max(...areas.map((a) => a.height)) : Infinity;
  const width = Math.round(Math.min(Math.max(saved.width, MIN_W), maxW));
  const height = Math.round(Math.min(Math.max(saved.height, MIN_H), maxH));

  if (finite(saved.x) && finite(saved.y) && areas.length) {
    const box = { x: Math.round(saved.x), y: Math.round(saved.y), width, height };
    const visible = areas.reduce((sum, a) => sum + overlap(box, a), 0);
    if (visible >= MIN_VISIBLE * width * height) return box;
  }
  return { width, height };   // size kept, position left to the OS
}

function load(file) {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch (e) { return null; }
}

function save(file, bounds) {
  const tmp = file + '.tmp-' + process.pid;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify({ x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }));
    fs.renameSync(tmp, file);
  } catch (e) { try { fs.unlinkSync(tmp); } catch (e2) {} }
}

module.exports = { restore, load, save, MIN_W, MIN_H };
