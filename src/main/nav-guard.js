'use strict';

// Navigation policy for the one window Spritz has.
//
// The renderer had no navigation guards at all. That matters because the preload bridge hands the
// page a lot of authority — mpv control, torrent add, cast load, local file reads — and all of it
// is granted to whatever document happens to be loaded, not to the document we shipped. Anything
// that can talk the renderer into navigating (a crafted playlist entry, a subtitle payload, a
// stream page title that ends up in a link) would inherit `window.soda` wholesale.
//
// The app never navigates: no window.open, no target=_blank, no <a href>, no <webview>, one
// BrowserWindow, and a single loadFile at startup. So the policy is deny-everything-else, and
// nothing legitimate is affected.
//
// Kept separate from main.js so the predicate can be unit-tested; that is the only part with any
// logic in it, and it is the part that has to be right.

const path = require('path');
const { pathToFileURL } = require('url');

// The one document allowed to occupy the window. Compared by resolved file path rather than by
// string, so ./x, //x and percent-encoded spellings of the same file all agree.
function appDocumentUrl(indexPath) {
  return pathToFileURL(path.resolve(indexPath)).href;
}

// May the window navigate to `target`? Only to the exact document we loaded.
//
// Note that a same-document fragment change ('#foo') does not raise will-navigate, so refusing
// anything with a hash here costs nothing and avoids reasoning about it.
function isAllowedNavigation(target, indexPath) {
  if (typeof target !== 'string' || !target) return false;
  let u;
  try { u = new URL(target); } catch (e) { return false; }
  if (u.protocol !== 'file:') return false;   // http(s), data:, blob:, javascript: — all refused
  if (u.hash || u.search) return false;
  try {
    return path.resolve(decodeURIComponent(u.pathname)) === path.resolve(indexPath);
  } catch (e) {
    return false;                              // malformed percent-encoding
  }
}

module.exports = { isAllowedNavigation, appDocumentUrl };
