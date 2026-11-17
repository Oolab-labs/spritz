'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

// The mini player must not be remembered as the normal window. macOS clamps setSize to the window's minimum,
// so the "tiny" mini window comes out at the 520x400 minimum, passes any size threshold, and used to be written
// to window-state.json by the debounced resize save: the next launch then opened as a small window in the mini
// player's corner. These run the real createMainWindow and window:toggleMini code from main.js against a fake
// BrowserWindow that clamps the way macOS does.
const MAIN = path.join(__dirname, '../src/main/main.js');
const src = fs.readFileSync(MAIN, 'utf8');

function slice(startMarker, endMarker) {
  const start = src.indexOf(startMarker);
  assert.ok(start >= 0, 'could not find ' + startMarker);
  const end = src.indexOf(endMarker, start);
  assert.ok(end > start, 'could not find the end of ' + startMarker);
  return src.slice(start, end);
}

function harness(saved) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spritz-mini-'));
  if (saved) fs.writeFileSync(path.join(dir, 'window-state.json'), JSON.stringify(saved));
  const ipc = {};
  const timers = new Map();
  let nextTimer = 1;
  const windows = [];

  class FakeWindow {
    constructor(opts) {
      this.handlers = {};
      this.min = [opts.minWidth || 0, opts.minHeight || 0];
      this.bounds = { x: opts.x == null ? 0 : opts.x, y: opts.y == null ? 0 : opts.y, width: opts.width, height: opts.height };
      this.destroyed = false;
      this.webContents = { on() {}, setWindowOpenHandler() {}, session: { setPermissionRequestHandler() {}, setPermissionCheckHandler() {} } };
      windows.push(this);
    }
    on(ev, fn) { (this.handlers[ev] = this.handlers[ev] || []).push(fn); }
    once(ev, fn) { this.on(ev, fn); }
    emit(ev) { (this.handlers[ev] || []).forEach((fn) => fn({ preventDefault() {} })); }
    loadFile() {}
    show() {}
    isDestroyed() { return this.destroyed; }
    getBounds() { return { ...this.bounds }; }
    getNormalBounds() { return { ...this.bounds }; }
    setMinimumSize(w, h) { this.min = [w, h]; }
    // NativeWindowMac::SetBounds clamps to the minimum size; setFrame would not.
    setSize(w, h) { this.bounds.width = Math.max(w, this.min[0]); this.bounds.height = Math.max(h, this.min[1]); this.emit('resize'); }
    setBounds(b) { this.bounds = { ...this.bounds, ...b }; this.emit('resize'); this.emit('move'); }
    setAlwaysOnTop() {}
    close() { this.emit('close'); this.destroyed = true; this.emit('closed'); }
  }

  const ctx = {
    require: require('module').createRequire(MAIN), __dirname: path.dirname(MAIN), path, console: { log() {}, warn() {}, error() {} },
    app: { getPath: () => dir }, screen: { getAllDisplays: () => [{ workArea: { x: 0, y: 25, width: 1440, height: 875 } }] },
    BrowserWindow: FakeWindow, ipcMain: { on: (ch, fn) => { ipc[ch] = fn; } },
    isAllowedNavigation: () => true, attachPlayer() {}, send() {},
    mpvAddon: null, torrent: { teardown() {} }, receivers: null, lan: { teardown() {} }, cast: { teardown() {} }, dlna: { teardown() {} },
    mainWindow: null,
    setTimeout: (fn) => { const id = nextTimer++; timers.set(id, fn); return id; },
    clearTimeout: (id) => { timers.delete(id); }
  };
  vm.createContext(ctx);
  const code = slice('  function createMainWindow() {', '\n  function send(') + '\n'
    + slice('  // Float-on-top + mini-player', "  ipcMain.on('window:close'")
    + '\nthis.createMainWindow = createMainWindow;';
  vm.runInContext(code, ctx);

  const flush = () => { const fns = [...timers.values()]; timers.clear(); fns.forEach((fn) => fn()); };
  const stored = () => JSON.parse(fs.readFileSync(path.join(dir, 'window-state.json'), 'utf8'));
  return { ctx, ipc, flush, stored, windows, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const NORMAL = { x: 100, y: 120, width: 1200, height: 700 };

test('entering the mini player does not overwrite the saved normal window', () => {
  const h = harness(NORMAL);
  try {
    h.ctx.createMainWindow();
    h.ipc['window:toggleMini']();
    h.flush();   // the debounced save setSize's resize event scheduled
    assert.deepStrictEqual(h.stored(), NORMAL);
  } finally { h.cleanup(); }
});

test('quitting while in the mini player leaves the pre-mini bounds on disk', () => {
  const h = harness(NORMAL);
  try {
    h.ctx.createMainWindow();
    h.ipc['window:toggleMini']();
    h.ctx.mainWindow.setBounds({ x: 900, y: 500 });   // the person drags the mini window into a corner
    h.ctx.mainWindow.close();
    h.flush();
    assert.deepStrictEqual(h.stored(), NORMAL);
  } finally { h.cleanup(); }
});

test('leaving the mini player resumes remembering the window', () => {
  const h = harness(NORMAL);
  try {
    h.ctx.createMainWindow();
    h.ipc['window:toggleMini']();
    h.flush();
    h.ipc['window:toggleMini']();
    h.ctx.mainWindow.setBounds({ x: 50, y: 60, width: 1000, height: 650 });
    h.flush();
    assert.deepStrictEqual(h.stored(), { x: 50, y: 60, width: 1000, height: 650 });
  } finally { h.cleanup(); }
});

test('a window re-created after closing in mini mode (dock activate) is remembered again', () => {
  const h = harness(NORMAL);
  try {
    h.ctx.createMainWindow();
    h.ipc['window:toggleMini']();
    h.ctx.mainWindow.close();
    h.ctx.createMainWindow();
    h.ctx.mainWindow.setBounds({ x: 10, y: 40, width: 900, height: 600 });
    h.flush();
    assert.deepStrictEqual(h.stored(), { x: 10, y: 40, width: 900, height: 600 });
  } finally { h.cleanup(); }
});

test('the BrowserWindow minimum is the one window-state.js clamps restored sizes to', () => {
  const W = require('../src/main/window-state');
  const h = harness(null);
  try {
    h.ctx.createMainWindow();
    assert.deepStrictEqual(h.windows[0].min, [W.MIN_W, W.MIN_H]);
  } finally { h.cleanup(); }
});
