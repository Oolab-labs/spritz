'use strict';

// Renders the Spritz Receiver's webOS artwork from build/receiver-art/bubbles.js.
//   electron build/render-receiver-icons.js
// webOS wants: icon 80x80, largeIcon 130x130 (launcher), and a 1920x1080 splash. The drawing is the
// single master; these PNGs are generated, committed, and checked by test/receiver-art.test.js.
// Each is drawn natively at its own size and read back losslessly from the canvas.
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

app.commandLine.appendSwitch('force-device-scale-factor', '1');
const BUBBLES = fs.readFileSync(path.join(__dirname, 'receiver-art', 'bubbles.js'), 'utf8');
const OUT = path.join(__dirname, '..', 'webos-receiver');

const draw = `
// Launcher icons are full-bleed squares: the launcher applies its own tile shape. They use the crisp
// bubble: the webOS 24 launcher scales them up, and the soft glass read as blurry from the sofa even at
// 2x source resolution (checked on an LG 55NANO80T6A, 2026-10-09).
function icon(s) { const c = document.createElement('canvas'); c.width = c.height = s; SpritzBubbles.mark(c.getContext('2d'), s, 0, 0, { crisp: true }); return c.toDataURL('image/png'); }
// Splash: the mark as a tile above the same wordmark the receiver's home screen shows, on its background.
function splash() {
  const c = document.createElement('canvas'); c.width = 1920; c.height = 1080; const x = c.getContext('2d'), B = SpritzBubbles;
  let g = x.createLinearGradient(0, 0, 0, 1080); g.addColorStop(0, '#15171d'); g.addColorStop(1, '#0a0b0e');
  x.fillStyle = g; x.fillRect(0, 0, 1920, 1080);
  const T = 340, X = (1920 - T) / 2, Y = 270;
  x.save(); x.shadowColor = 'rgba(0,0,0,.55)'; x.shadowBlur = 40; x.shadowOffsetY = 16; B.squircle(x, X, Y, T); x.fillStyle = '#0c0d11'; x.fill(); x.restore();
  x.save(); B.squircle(x, X, Y, T); x.clip(); B.mark(x, T, X, Y);
  g = x.createLinearGradient(0, Y, 0, Y + T * 0.45); g.addColorStop(0, 'rgba(255,255,255,0.18)'); g.addColorStop(1, 'rgba(255,255,255,0)');
  B.squircle(x, X, Y, T); x.strokeStyle = g; x.lineWidth = 2; x.stroke(); x.restore();
  x.font = '200 72px "Helvetica Neue", Helvetica, Arial, sans-serif'; x.letterSpacing = '0.26em';
  x.fillStyle = '#e6e6ea'; x.textAlign = 'center'; x.textBaseline = 'alphabetic';
  // letter-spacing trails the last glyph; shift by half of it so the word is optically centred
  x.fillText('SPRITZ', 960 + 72 * 0.13, Y + T + 140);
  return c.toDataURL('image/png');
}`;
const TARGETS = [['icon.png', 'icon(80)'], ['largeIcon.png', 'icon(130)'], ['splash.png', 'splash()']];

app.whenReady().then(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spritz-art-'));
  const win = new BrowserWindow({ show: false, width: 64, height: 64 });
  try {
    const html = path.join(tmp, 'art.html');
    fs.writeFileSync(html, `<!doctype html><meta charset="utf-8"><script>${BUBBLES}</script><script>${draw}</script>`);
    await win.loadFile(html);
    await win.webContents.executeJavaScript('document.fonts.ready.then(() => 1)');
    for (const [file, call] of TARGETS) {
      const url = await win.webContents.executeJavaScript(call);
      fs.writeFileSync(path.join(OUT, file), Buffer.from(url.slice(url.indexOf(',') + 1), 'base64'));
      console.log('wrote', file);
    }
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); app.quit(); }
}).catch((e) => { console.error(e); app.exit(1); });
