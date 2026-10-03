'use strict';

// External helper binaries (yt-dlp/ffmpeg/ffprobe/whisper).
//
// Packaged: ONLY Contents/Resources/bin. Falling back to /opt/homebrew made a package with a
// missing or broken bundled binary work perfectly on the build machine and fail everywhere else —
// the one place it could have been noticed was the one place it was hidden. A missing bundled
// binary now fails at spawn with ENOENT naming the bundled path.
//
// Development (`electron .`, or plain node under test): a GUI app's PATH won't find Homebrew, so
// probe bundled-if-any, then Homebrew/system, then the bare name.
const fs = require('fs');
const path = require('path');

function isPackaged(proc) {
  return !!(proc.versions && proc.versions.electron) && !proc.defaultApp;
}

function resolveBin(name, { packaged, resourcesPath, exists }) {
  const bundled = resourcesPath ? path.join(resourcesPath, 'bin', name) : null;
  if (packaged && bundled) return bundled;
  return [bundled, '/opt/homebrew/bin/' + name, '/usr/local/bin/' + name, '/usr/bin/' + name]
    .filter(Boolean).find((p) => { try { return exists(p); } catch (e) { return false; } }) || name;
}

function binPath(name) {
  return resolveBin(name, { packaged: isPackaged(process), resourcesPath: process.resourcesPath, exists: fs.existsSync });
}

// Optional tools the user installs themselves (whisper.cpp) are never bundled, so even a packaged
// app looks for them on the system. Not for anything the release ships.
function userBinPath(name) {
  return resolveBin(name, { packaged: false, resourcesPath: process.resourcesPath, exists: fs.existsSync });
}

module.exports = { binPath, userBinPath, resolveBin, isPackaged };
