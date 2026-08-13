'use strict';

// Validators for renderer-supplied values that reach the filesystem or a spawned process.
//
// Threat model, stated plainly so these stay proportionate. Spritz is a local player and the user
// can already open any file they like through the file dialog, so "the renderer named an arbitrary
// local path" is NOT privilege escalation and these are not path-traversal guards. What actually
// matters is narrower:
//
//   1. `src` values reach `ffmpeg -i`, and ffmpeg speaks far more than files — http, tcp, concat,
//      subfile and friends. A renderer compromised by malicious subtitle text or torrent metadata
//      could use that to reach hosts on the user's network that it cannot reach itself. Pinning
//      these inputs to real local files removes the protocol surface entirely.
//   2. Unbounded reads. readFileSync on a renderer-named path will happily allocate a 10GB file
//      into the main process and take the app down with it.
//
// All three callers (thumb:at, subtitle:generate, subtitle:online) pass `currentLocalPath`, which
// the renderer only sets for paths beginning with '/'. So requiring a local regular file matches
// what the app genuinely does — a guard stricter than real usage gets loosened until it stops
// guarding, and one looser than real usage is not a guard.

const fs = require('fs');
const path = require('path');

// An existing, regular, absolute local file — or null. Returns the path so callers can use the
// validated value rather than the raw one.
function localMediaPath(p) {
  if (typeof p !== 'string' || !p) return null;
  if (p.includes('\0')) return null;               // truncation tricks in the C layer below
  if (!path.isAbsolute(p)) return null;            // no cwd-relative resolution
  // A URL is not a path. Rejected explicitly rather than left to statSync, so the intent is clear:
  // these channels are for local media, and anything with a scheme belongs to a different route.
  if (/^[a-z][a-z0-9+.-]*:/i.test(p)) return null;
  try {
    const st = fs.statSync(p);
    return st.isFile() ? p : null;                 // not a directory, socket, fifo or device
  } catch (e) {
    return null;
  }
}

// Read a text file the renderer named, refusing anything implausibly large for its purpose.
// Returns null rather than throwing: every caller already degrades gracefully.
function readTextCapped(p, maxBytes) {
  const cap = typeof maxBytes === 'number' && maxBytes > 0 ? maxBytes : 2 * 1024 * 1024;
  if (typeof p !== 'string' || !p || p.includes('\0')) return null;
  let fd = null;
  try {
    const st = fs.statSync(p);
    if (!st.isFile() || st.size > cap) return null;
    // Size-then-read is a TOCTOU in principle; read through a held descriptor with an explicit
    // length so a file that grows between the two cannot widen the read.
    fd = fs.openSync(p, 'r');
    const buf = Buffer.allocUnsafe(Math.min(st.size, cap));
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    return buf.slice(0, n).toString('utf8');
  } catch (e) {
    return null;
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch (e) {} }
  }
}

// Resolve `rel` inside `root`, or null if it lands anywhere else.
//
// Used by the LAN HTTP server, which is bound to 0.0.0.0 so televisions can reach it. That route
// previously rejected traversal with a blacklist — splitting on '/' and looking for a '..' segment.
// That happens to hold today, but blacklists answer "does this look dangerous" when the question
// is "does this resolve inside the directory I meant". Only the second one stays true as callers
// change, and it is not a harder check to write.
//
// The trailing-separator comparison matters: a plain startsWith(root) would accept '/tmp/hls-evil'
// as being inside '/tmp/hls'.
function containedPath(root, rel) {
  if (typeof root !== 'string' || !root || typeof rel !== 'string' || !rel) return null;
  if (rel.includes('\0') || root.includes('\0')) return null;
  const base = path.resolve(root);
  const full = path.resolve(base, rel);
  if (full === base) return null;                      // the directory itself is not a file in it
  return full.startsWith(base + path.sep) ? full : null;
}

// An http(s) URL, or null. Returned normalised so callers pass on the parsed value.
//
// This exists because the string goes into yt-dlp's argv. yt-dlp has --exec (runs a command),
// --config-location (loads a config that can itself carry --exec) and -o (writes anywhere), so a
// value beginning with '-' is not a bad URL, it is an instruction. The renderer does check for
// http(s) before asking, but that is the wrong side of the trust boundary — main must not depend
// on the renderer having been careful.
function httpUrl(u) {
  if (typeof u !== 'string' || !u) return null;
  if (u.length > 2048) return null;                      // no unbounded argv entries
  if (/[\s\0]/.test(u)) return null;                     // a URL has no whitespace or NULs
  let p;
  try { p = new URL(u); } catch (e) { return null; }
  if (p.protocol !== 'http:' && p.protocol !== 'https:') return null;
  if (!p.hostname) return null;
  return p.href;
}

// A dotted-quad IPv4 literal, or null. Used where a host reaches a command line (arp) or a
// socket, so that a value like '-x' cannot arrive as a flag.
function ipv4(h) {
  if (typeof h !== 'string') return null;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return null;
  return m.slice(1).every((o) => Number(o) <= 255 && String(Number(o)) === o) ? h : null;
}

module.exports = { localMediaPath, readTextCapped, containedPath, httpUrl, ipv4 };
