'use strict';
// Exercise the dependency in Electron, without joining a torrent or announcing to trackers.
const path = require('path');
const { execFileSync } = require('child_process');
const root = path.join(__dirname, '..');
const probe = `import('webtorrent').then(async ({default: WebTorrent}) => {
  const client = new WebTorrent({ dht: false, tracker: false, lsd: false });
  await new Promise((resolve, reject) => client.destroy(error => error ? reject(error) : resolve()));
  console.log('torrent runtime: import and client lifecycle passed');
}).catch(error => { console.error(error.message); process.exitCode = 1; });`;
try {
  const output = execFileSync(require('electron'), ['-e', probe], {
    cwd: root, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8', timeout: 20000, maxBuffer: 65536
  });
  process.stdout.write(output);
} catch (error) {
  console.error('Torrent runtime preflight failed. Restore native dependencies before packaging.');
  if (error.stderr) process.stderr.write(String(error.stderr));
  else console.error(error.message);
  process.exitCode = 1;
}
