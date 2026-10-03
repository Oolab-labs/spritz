'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { helpMenu } = require('../src/main/help-menu');

// UI audit R2: there was no Help menu, so mpv.log and crash reports lived in ~/Library with no way to find them
// and no way to report a problem.
function deps(over = {}) {
  const calls = [];
  return Object.assign({
    calls,
    shell: { openExternal: (u) => calls.push(['openExternal', u]), showItemInFolder: (p) => calls.push(['showItemInFolder', p]), openPath: (p) => calls.push(['openPath', p]) },
    userDataDir: '/Users/x/Library/Application Support/Spritz',
    logsDir: '/Users/x/Library/Logs/DiagnosticReports',
    exists: () => true, installer: '/Applications/Spritz.app/Contents/Resources/receiver/com.spritz.receiver_0.3.2_all.ipk',
    version: '2.0.0-rc.7', checkForUpdates: () => calls.push(['checkForUpdates']),
  }, over);
}
const find = (m, label) => m.submenu.find((i) => i.label && i.label.startsWith(label));

test('it is the macOS Help menu, with the app version shown as a disabled line', () => {
  const m = helpMenu(deps());
  assert.strictEqual(m.role, 'help');
  const v = m.submenu.find((i) => /2\.0\.0-rc\.7/.test(i.label || ''));
  assert.ok(v && v.enabled === false);
});

test('Report an Issue and Help open fixed https GitHub URLs only', () => {
  const d = deps(); const m = helpMenu(d);
  find(m, 'Report an Issue').click(); find(m, 'Spritz Help').click();
  const urls = d.calls.filter((c) => c[0] === 'openExternal').map((c) => c[1]);
  assert.strictEqual(urls.length, 2);
  for (const u of urls) assert.match(u, /^https:\/\/github\.com\/Oolab-labs\/spritz(\/|#|$)/);
});

test('Show Logs reveals mpv.log when it exists, otherwise opens the data folder', () => {
  const d = deps(); find(helpMenu(d), 'Show Logs').click();
  assert.deepStrictEqual(d.calls[0], ['showItemInFolder', path.join(d.userDataDir, 'mpv.log')]);
  const d2 = deps({ exists: () => false }); find(helpMenu(d2), 'Show Logs').click();
  assert.deepStrictEqual(d2.calls[0], ['openPath', d2.userDataDir]);
});

test('Show Crash Reports opens the system diagnostic reports folder', () => {
  const d = deps(); find(helpMenu(d), 'Show Crash Reports').click();
  assert.deepStrictEqual(d.calls[0], ['openPath', d.logsDir]);
});

test('the receiver installer item is enabled only when an installer exists, and reveals it', () => {
  const d = deps(); const item = find(helpMenu(d), 'Show Receiver Installer');
  assert.ok(item.enabled !== false); item.click();
  assert.deepStrictEqual(d.calls[0], ['showItemInFolder', d.installer]);
  assert.strictEqual(find(helpMenu(deps({ installer: null })), 'Show Receiver Installer').enabled, false);
});

test('nothing in the menu sends any data anywhere (URLs carry no query, version or paths)', () => {
  const d = deps(); const m = helpMenu(d);
  m.submenu.forEach((i) => { if (i.click) i.click(); });
  for (const c of d.calls.filter((c) => c[0] === 'openExternal')) assert.ok(!/[?&]/.test(c[1]), c[1]);
});

test('Check for Updates is a menu item that only runs when clicked (no check at startup)', () => {
  const d = deps(); const m = helpMenu(d);
  assert.deepStrictEqual(d.calls, [], 'building the menu must not trigger a check');
  find(m, 'Check for Updates').click();
  assert.deepStrictEqual(d.calls, [['checkForUpdates']]);
});

// The app conveys GPL binaries and Chromium; the licence texts ride inside it, and the Help menu is where a
// person finds them.
test('Show Licenses in Finder reveals the bundled licence folder, and is disabled when there is none', () => {
  const opened = [];
  const shell = { openExternal() {}, openPath: (p) => opened.push(['openPath', p]), showItemInFolder: (p) => opened.push(['show', p]) };
  const base = { shell, userDataDir: '/u', logsDir: '/l', exists: () => true, installer: null, version: '1', checkForUpdates() {} };
  const present = helpMenu({ ...base, licensesDir: '/app/Resources/licenses' }).submenu.find((i) => /Licenses/.test(i.label || ''));
  assert.ok(present, 'the item exists');
  assert.strictEqual(present.enabled, true);
  present.click();
  assert.deepStrictEqual(opened, [['openPath', '/app/Resources/licenses']]);
  const absent = helpMenu({ ...base, licensesDir: '/app/Resources/licenses', exists: () => false }).submenu.find((i) => /Licenses/.test(i.label || ''));
  assert.strictEqual(absent.enabled, false, 'running from source has no bundled folder');
  const none = helpMenu(base).submenu.find((i) => /Licenses/.test(i.label || ''));
  assert.strictEqual(none.enabled, false, 'no folder given');
});
