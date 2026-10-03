'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const pkg = JSON.parse(read('package.json'));
const receiver = JSON.parse(read('webos-receiver/appinfo.json'));
const readme = read('README.md');
const notes = read('RELEASE-NOTES-v' + pkg.version + '.md');
const QUARANTINE = 'xattr -dr com.apple.quarantine /Applications/Spritz.app';

// The README's Install section and the GitHub release notes both tell someone how to get past macOS the first
// time, and they had drifted: the README said right-click → Open, the notes said Open Anyway, and macOS 15
// removed the right-click route. They are one set of instructions and are tested as one.

test('there are release notes for the version being released', () => {
  assert.ok(notes.length > 500);
  assert.ok(notes.includes(pkg.version));
});

test('both documents give the same command for clearing the quarantine flag', () => {
  assert.ok(readme.includes(QUARANTINE), 'README');
  assert.ok(notes.includes(QUARANTINE), 'release notes');
});

test('both documents name the System Settings route that macOS 15 and later requires', () => {
  for (const [name, text] of [['README', readme], ['release notes', notes]]) {
    assert.ok(/Open Anyway/.test(text), name + ' says Open Anyway');
    assert.ok(/Privacy (&|and) Security/.test(text), name + ' says where it is');
    assert.ok(/macOS 15/.test(text), name + ' says which macOS needs it');
  }
});

test('the release notes name the files this version produces', () => {
  assert.ok(notes.includes('Spritz-' + pkg.version + '-arm64.dmg'), 'dmg');
  assert.ok(notes.includes('com.spritz.receiver_' + receiver.version + '_all.ipk'), 'receiver package at the receiver version');
  assert.ok(notes.includes('SHA256SUMS'));
});

test('the README does not promise an installer that "a later release" will add', () => {
  assert.ok(!/from the first release that includes it/i.test(readme), 'the receiver package ships with this release');
});

test('the README says what the Mac app does about a receiver version mismatch', () => {
  assert.ok(!/doesn.t yet warn you about a mismatch/i.test(readme), 'it flags a TV running an older receiver');
});

test('the links both documents rely on exist', () => {
  assert.ok(/^## Spritz Receiver for LG webOS$/m.test(readme));
  assert.ok(/^## Install$/m.test(readme));
  assert.ok(/\(#install\)/.test(notes) || /README/.test(notes), 'the notes point at the README for details');
});

// The share-alike components' source is hosted on the release itself, so nobody has to ask for it. The file name
// is derived from the version, and both documents have to point at it.
test('the release notes and the README point at the corresponding-source file for this version', () => {
  const file = 'Spritz-' + pkg.version + '-corresponding-source.tar';
  assert.ok(notes.includes(file), 'release notes');
  assert.ok(readme.includes('corresponding-source'), 'README');
});
