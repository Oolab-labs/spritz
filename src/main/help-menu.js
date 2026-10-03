'use strict';

// The Help menu: where the logs and crash reports are, how to report a problem, and which build this is.
// Pure (everything it touches is passed in) so it is unit-tested. Nothing here sends data anywhere: the
// "Report an Issue" item opens a fixed GitHub URL with no query string, and the person writes the report.
const path = require('path');

const REPO = 'https://github.com/Oolab-labs/spritz';

function helpMenu({ shell, userDataDir, logsDir, exists, installer, version, checkForUpdates, licensesDir }) {
  return {
    role: 'help',
    submenu: [
      { label: 'Spritz Help', click: () => shell.openExternal(REPO + '#readme') },
      { label: 'Report an Issue…', click: () => shell.openExternal(REPO + '/issues/new') },
      { label: 'Check for Updates…', click: () => checkForUpdates() },
      { type: 'separator' },
      { label: 'Show Logs in Finder', click: () => {
        const log = path.join(userDataDir, 'mpv.log');
        if (exists(log)) shell.showItemInFolder(log); else shell.openPath(userDataDir);
      } },
      { label: 'Show Crash Reports in Finder', click: () => shell.openPath(logsDir) },
      { label: 'Show Receiver Installer in Finder', enabled: !!installer, click: () => { if (installer) shell.showItemInFolder(installer); } },
      { label: 'Show Licenses in Finder', enabled: !!(licensesDir && exists(licensesDir)), click: () => shell.openPath(licensesDir) },
      { type: 'separator' },
      { label: 'Spritz ' + version, enabled: false }
    ]
  };
}

module.exports = { helpMenu };
