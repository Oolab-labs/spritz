'use strict';

// Renders the macOS app icon set from build/receiver-art/bubbles.js (the same mark as the TV receiver).
//   electron build/render-mac-icon.js && iconutil -c icns build/Spritz.iconset -o build/icon.icns
// macOS does not mask icons, so the tile and the transparent margin are drawn here: the artwork is an
// 824/1024 tile centred on Apple's app-icon grid, with Apple's continuous-corner (superellipse) shape,
// a top-lit edge and a soft shadow. Every size is drawn natively at its own pixel size — the small
// ones use the mark's simplified drawing — instead of downsampling one 1024px capture into mush.
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

app.commandLine.appendSwitch('force-device-scale-factor', '1');
const BUBBLES = fs.readFileSync(path.join(__dirname, 'receiver-art', 'bubbles.js'), 'utf8');
const OUT = path.join(__dirname, 'Spritz.iconset');
const NAMES = { 16: ['icon_16x16.png'], 32: ['icon_16x16@2x.png', 'icon_32x32.png'], 64: ['icon_32x32@2x.png'],
  128: ['icon_128x128.png'], 256: ['icon_128x128@2x.png', 'icon_256x256.png'], 512: ['icon_256x256@2x.png', 'icon_512x512.png'],
  1024: ['icon_512x512@2x.png'] };

const draw = `function drawIcon(s) {
  const c = document.createElement('canvas'); c.width = c.height = s;
  const x = c.getContext('2d'), T = s * 824 / 1024, O = (s - T) / 2, B = SpritzBubbles;
  x.save(); x.shadowColor = 'rgba(0,0,0,.42)'; x.shadowBlur = s * 28 / 1024; x.shadowOffsetY = s * 12 / 1024;
  B.squircle(x, O, O, T); x.fillStyle = '#0c0d11'; x.fill(); x.restore();
  x.save(); B.squircle(x, O, O, T); x.clip(); B.mark(x, T, O, O);
  // the top-lit edge: a hairline that fades out down the sides
  const g = x.createLinearGradient(0, O, 0, O + T * 0.45);
  g.addColorStop(0, 'rgba(255,255,255,0.20)'); g.addColorStop(1, 'rgba(255,255,255,0)');
  B.squircle(x, O, O, T); x.strokeStyle = g; x.lineWidth = Math.max(1, s * 4 / 1024); x.stroke();
  x.restore();
  return c.toDataURL('image/png');
}`;

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spritz-macicon-'));
  const win = new BrowserWindow({ show: false, width: 64, height: 64 });
  try {
    const html = path.join(tmp, 'icon.html');
    fs.writeFileSync(html, `<!doctype html><meta charset="utf-8"><script>${BUBBLES}</script><script>${draw}</script>`);
    await win.loadFile(html);
    for (const [size, names] of Object.entries(NAMES)) {
      const url = await win.webContents.executeJavaScript(`drawIcon(${size})`);
      const png = Buffer.from(url.slice(url.indexOf(',') + 1), 'base64');
      for (const n of names) fs.writeFileSync(path.join(OUT, n), png);
      console.log('wrote', names.join(', '), `${size}px`);
    }
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); app.quit(); }
}).catch((e) => { console.error(e); app.exit(1); });
