'use strict';

// Renders the macOS app icon set from build/receiver-art/bubbles.js (the same mark as the TV receiver).
//   electron build/render-mac-icon.js && iconutil -c icns build/Spritz.iconset -o build/icon.icns
// macOS does not mask icons, so the rounded tile and the transparent margin are drawn here: the
// artwork is an 824px tile centred in a 1024 canvas (Apple's app-icon grid), with a soft shadow.
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

app.commandLine.appendSwitch('force-device-scale-factor', '1');
const BUBBLES = fs.readFileSync(path.join(__dirname, 'receiver-art', 'bubbles.js'), 'utf8');
const OUT = path.join(__dirname, 'Spritz.iconset');
const SIZES = [16, 32, 64, 128, 256, 512, 1024];
const NAMES = { 16: ['icon_16x16.png'], 32: ['icon_16x16@2x.png', 'icon_32x32.png'], 64: ['icon_32x32@2x.png'],
  128: ['icon_128x128.png'], 256: ['icon_128x128@2x.png', 'icon_256x256.png'], 512: ['icon_256x256@2x.png', 'icon_512x512.png'],
  1024: ['icon_512x512@2x.png'] };

const page = `<!doctype html><meta charset="utf-8"><body style="margin:0;background:transparent;width:1024px;height:1024px"><canvas id="c" width="1024" height="1024"></canvas>
<script>${BUBBLES}</script><script>
const c = document.getElementById('c'), x = c.getContext('2d'), T = 824, O = 100, RAD = 185;
const tile = document.createElement('canvas'); tile.width = tile.height = T; SpritzBubbles.mark(tile.getContext('2d'), T, 0, 0);
x.save(); x.shadowColor = 'rgba(0,0,0,.45)'; x.shadowBlur = 28; x.shadowOffsetY = 14;
x.beginPath(); x.roundRect(O, O, T, T, RAD); x.fillStyle = '#0a0a0b'; x.fill(); x.restore();
x.save(); x.beginPath(); x.roundRect(O, O, T, T, RAD); x.clip(); x.drawImage(tile, O, O); x.restore();
</script>`;

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spritz-macicon-'));
  const win = new BrowserWindow({ show: false, width: 1024, height: 1024, useContentSize: true, frame: false, transparent: true });
  try {
    const html = path.join(tmp, 'icon.html');
    fs.writeFileSync(html, page);
    await win.loadFile(html);
    await new Promise((r) => setTimeout(r, 300));
    let big = await win.webContents.capturePage();
    if (big.getSize().width !== 1024) big = big.resize({ width: 1024, height: 1024, quality: 'best' });
    for (const size of SIZES) {
      const img = size === 1024 ? big : big.resize({ width: size, height: size, quality: 'best' });
      for (const name of NAMES[size]) fs.writeFileSync(path.join(OUT, name), img.toPNG());
    }
    console.log('wrote', OUT);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); app.quit(); }
}).catch((e) => { console.error(e); app.exit(1); });
