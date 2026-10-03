'use strict';

// Renders the Spritz Receiver's webOS artwork from build/receiver-art/bubbles.js.
//   electron build/render-receiver-icons.js
// webOS wants: icon 80x80, largeIcon 130x130 (launcher), and an optional 1920x1080 splash. The drawing
// is the single master; these PNGs are generated, committed, and checked for size by test/receiver-art.test.js.
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

app.commandLine.appendSwitch('force-device-scale-factor', '1');
const BUBBLES = fs.readFileSync(path.join(__dirname, 'receiver-art', 'bubbles.js'), 'utf8');
const OUT = path.join(__dirname, '..', 'webos-receiver');

// The mark is drawn once at 1024 and scaled with the engine's resampler, so the small icons are
// downsampled from a clean source rather than drawn at their own tiny size.
const page = (w, h, body) => `<!doctype html><meta charset="utf-8"><body style="margin:0;background:#0b0b0d;width:${w}px;height:${h}px"><script>${BUBBLES}</script>${body}`;
const TARGETS = [
  { file: 'icon.png', w: 80, h: 80, win: 1024, html: () => page(1024, 1024, '<canvas id="c" width="1024" height="1024"></canvas><script>SpritzBubbles.mark(document.getElementById("c").getContext("2d"),1024,0,0)</script>') },
  { file: 'largeIcon.png', w: 130, h: 130, win: 1024, html: () => page(1024, 1024, '<canvas id="c" width="1024" height="1024"></canvas><script>SpritzBubbles.mark(document.getElementById("c").getContext("2d"),1024,0,0)</script>') },
  // Splash: the mark as a rounded tile centred on the app's own background, so launch and icon read as one identity.
  { file: 'splash.png', w: 1920, h: 1080, win: null, html: () => page(1920, 1080,
    '<canvas id="c" width="1024" height="1024" style="position:absolute;left:780px;top:360px;width:360px;height:360px;border-radius:72px"></canvas><script>SpritzBubbles.mark(document.getElementById("c").getContext("2d"),1024,0,0)</script>') }
];

app.whenReady().then(async () => {
  // One window, resized per target and pages loaded from temp files: a second BrowserWindow in the
  // same process failed to load (ERR_FAILED), and a file URL is also what a human would debug with.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spritz-art-'));
  const win = new BrowserWindow({ show: false, width: 1024, height: 1024, useContentSize: true, frame: false });
  try {
    for (const t of TARGETS) {
      const html = path.join(tmp, t.file + '.html');
      fs.writeFileSync(html, t.html());
      win.setContentSize(t.win || t.w, t.win || t.h);
      await win.loadFile(html);
      await new Promise((r) => setTimeout(r, 500));
      let img = await win.webContents.capturePage();
      if (img.getSize().width !== t.w || img.getSize().height !== t.h) img = img.resize({ width: t.w, height: t.h, quality: 'best' });
      fs.writeFileSync(path.join(OUT, t.file), img.toPNG());
      console.log('wrote', t.file, `${t.w}x${t.h}`);
    }
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); app.quit(); }
}).catch((e) => { console.error(e); app.exit(1); });
