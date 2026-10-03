'use strict';

// Renders the real home screen, dialogs and menus (src/renderer/index.html + player.css, no scripts)
// at several window sizes inside Electron and measures what a person would see: overlapping blocks,
// content that cannot be reached, dialogs whose action buttons fall outside the window.
//   electron build/check-layout.js   → prints JSON {problems:[…]} and exits 1 if there are any
//
// Why it exists: rc.3 added a taller Devices block to the home screen and nothing noticed that, at the
// default window size, it was drawn on top of "Continue Watching" and that Settings' Done button fell
// off the bottom. Unit tests cannot see layout; this can.
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

app.commandLine.appendSwitch('force-device-scale-factor', '1');
const RENDERER = path.join(__dirname, '..', 'src', 'renderer');
const SIZES = [[950, 560], [640, 480], [520, 400], [1440, 900]];

// Strip scripts and the CSP (a file page's 'self' does not cover its own CSS here) and point relative
// URLs at the renderer directory.
function pageHtml() {
  let h = fs.readFileSync(path.join(RENDERER, 'index.html'), 'utf8');
  h = h.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, '');
  return h.replace('<head>', '<head><base href="file://' + RENDERER + '/">');
}

// Runs inside the page. Builds the busiest realistic state, then measures it.
const MEASURE = `(() => {
  const $ = (s) => document.querySelector(s);
  const out = { problems: [] };
  const show = (el) => el && el.classList.remove('hidden');
  const hide = (el) => el && el.classList.add('hidden');
  // Busiest home: one paired (offline) TV + a TV asking to pair + a full Continue Watching row.
  show($('#home')); hide($('#player'));
  const list = $('#devices-list');
  list.innerHTML = '<div class="device-row"><div><div class="device-name">webOS TV</div><div class="device-meta">Spritz Receiver 0.3.1 · Paired • Offline · last seen Oct 2</div></div><span class="receiver-forget">Forget</span></div>';
  $('#devices-address').textContent = 'If your TV can\\u2019t find this Mac, type this address on the TV: 192.168.1.9';
  hide($('#devices-empty'));
  show($('#home-pair'));
  const row = $('#cw-row'); row.innerHTML = '';
  for (let i = 0; i < 8; i++) row.insertAdjacentHTML('beforeend', '<div class="cw-card"><div class="cw-thumb"><span class="cw-glyph">?</span><div class="cw-prog"><span style="width:40%"></span></div></div><div class="cw-name">Some.Long.Title.S01E0' + i + '.1080p.WEB.x264-GROUP</div></div>');
  show($('#continue-watching'));
  const rect = (el) => { const r = el.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom }; };
  const inter = (a, b) => Math.max(0, Math.min(a.r, b.r) - Math.max(a.l, b.l)) * Math.max(0, Math.min(a.b, b.b) - Math.max(a.t, b.t));
  const blocks = ['.home-inner', '#devices', '#continue-watching'].map((s) => ({ s, el: $(s) })).filter((x) => x.el);
  for (let i = 0; i < blocks.length; i++) for (let j = i + 1; j < blocks.length; j++) {
    const area = inter(rect(blocks[i].el), rect(blocks[j].el));
    if (area > 4) out.problems.push('home: ' + blocks[i].s + ' overlaps ' + blocks[j].s + ' (' + Math.round(area) + ' px²)');
  }
  // Everything on the home screen must be reachable: either inside the window or the home screen scrolls.
  const home = $('#home'), oy = getComputedStyle(home).overflowY;
  const scrollable = (oy === 'auto' || oy === 'scroll') && home.scrollHeight >= home.clientHeight;
  const lowest = Math.max(...blocks.map((b) => rect(b.el).b));
  if (lowest > innerHeight + 1 && !scrollable) out.problems.push('home: content extends to ' + Math.round(lowest) + 'px in a ' + innerHeight + 'px window and does not scroll');
  const logoTop = rect($('.home-inner')).t;
  if (logoTop < 0 && !scrollable) out.problems.push('home: the top of the hero is cut off (' + Math.round(logoTop) + 'px)');
  hide($('#home'));
  // Dialogs: the box must fit the window (or scroll) and its action buttons must be on screen.
  for (const id of ['#settings-modal', '#url-modal']) {
    const m = $(id); if (!m) continue; show(m);
    const box = m.querySelector('.modal-box'), act = m.querySelector('.modal-actions button') || m.querySelector('button');
    const br = rect(box), ar = act && rect(act), boy = getComputedStyle(box).overflowY;
    if (br.b > innerHeight + 1 || br.t < -1) out.problems.push(id + ': dialog is ' + Math.round(br.b - br.t) + 'px tall in a ' + innerHeight + 'px window');
    if (ar && (ar.b > innerHeight + 1)) out.problems.push(id + ': its action button is below the window edge (' + Math.round(ar.b) + 'px)');
    hide(m);
  }
  // Menus: top edge on screen even when long.
  const cast = $('#menu-cast'); show($('#player')); show(cast);
  cast.innerHTML = '<div class="menu-title">Cast</div><ul class="list">' + '<li>[LG] webOS TV NANO80T6A — native 4K/HDR (best)</li>'.repeat(14) + '</ul>';
  const cr = rect(cast); if (cr.t < 0) out.problems.push('#menu-cast: top edge is above the window (' + Math.round(cr.t) + 'px)');
  return out;
})()`;

app.whenReady().then(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spritz-layout-'));
  const file = path.join(tmp, 'index.html');
  fs.writeFileSync(file, pageHtml());
  const problems = [];
  const win = new BrowserWindow({ show: false, width: 950, height: 560, useContentSize: true, frame: false });
  try {
    for (const [w, h] of SIZES) {
      win.setContentSize(w, h);
      await win.loadFile(file);
      await new Promise((r) => setTimeout(r, 250));
      const r = await win.webContents.executeJavaScript(MEASURE);
      for (const p of r.problems) problems.push(w + '×' + h + ' — ' + p);
    }
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  console.log(JSON.stringify({ problems }, null, 1));
  app.exit(problems.length ? 1 : 0);
}).catch((e) => { console.error(e); app.exit(2); });
