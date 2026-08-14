'use strict';

// Persistence for device-memory.js, in the same shape as history.js: read once at startup, write
// through on change, and treat every failure as "no memory" rather than an error — a corrupt or
// unreadable file must degrade to the conservative defaults, never prevent casting.

const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const dm = require('./device-memory');

module.exports = function createDeviceMemory() {
  const FILE = path.join(app.getPath('userData'), 'device-memory.json');
  let mem;
  try {
    const parsed = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    // A file from a future version is not ours to interpret. Starting over loses only observations,
    // which are re-learned the next time something plays.
    mem = (parsed && parsed.version === 1 && parsed.devices) ? parsed : dm.emptyMemory();
  } catch (e) {
    mem = dm.emptyMemory();
  }
  const flush = () => { try { fs.writeFileSync(FILE, JSON.stringify(mem)); } catch (e) {} };

  return {
    keyFor: dm.deviceKey,
    // Fold what this device has been seen to play into a profile before the plan uses it.
    profileFor(key, profile) { return dm.applyMemory(profile, mem, key, require('./device-profile')); },
    noteSuccess(key, traits) { if (!key) return; dm.recordSuccess(mem, key, traits); flush(); },
    noteFailure(key, traits, reason) { if (!key) return; dm.recordFailure(mem, key, traits, reason); flush(); },
    describe(key) { return dm.describe(mem, key); },
    forget(key) { if (key && mem.devices[key]) { delete mem.devices[key]; flush(); } }
  };
};
