'use strict';

// libmpv error-level log lines, kept on disk.
//
// Why: libmpv 0.41.0's CoreAudio output registers its device-hotplug listener before the audio unit
// is initialised, so a failed init leaves a listener pointing at freed memory and the next audio
// device change crashes the app (see IMPLEMENTATION-PROGRESS 2026-10-01). The failed init logs an
// error first — but with no log capture that line vanished and the crash was unattributable.
//
// Bounded (one backup), best-effort (a full disk must never reach the mpv event path).
const fs = require('fs');

function createMpvLog({ file, maxBytes = 256 * 1024, now = () => new Date().toISOString() }) {
  let size = null;
  function handle(ev) {
    if (!ev || ev.type !== 'log') return false;
    try {
      const line = now() + ' [' + (ev.name || '?') + '] ' + String(ev.value == null ? '' : ev.value).replace(/\n+$/, '') + '\n';
      if (size === null) { try { size = fs.statSync(file).size; } catch (e) { size = 0; } }
      if (size + line.length > maxBytes) {
        try { fs.renameSync(file, file + '.1'); } catch (e) {}
        size = 0;
      }
      fs.appendFileSync(file, line);
      size += line.length;
    } catch (e) { /* best effort */ }
    return true;
  }
  return { handle };
}

module.exports = { createMpvLog };
