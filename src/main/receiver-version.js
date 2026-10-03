'use strict';

// Which Spritz Receiver build this Mac app was released with, and whether a connected TV is behind it.
// Kept in src/ (the TV's own files are not packaged into the Mac app) and pinned to the receiver's
// appinfo.json by test/receiver-version.test.js so the two cannot drift apart.
const RECOMMENDED_RECEIVER_VERSION = '0.3.2';

function majorMinor(v) {
  const m = /^(\d+)\.(\d+)\.\d+/.exec(String(v == null ? '' : v));
  return m ? [Number(m[1]), Number(m[2])] : null;
}

// 'update' when the receiver is older by major or minor; 'unknown' when it did not announce a
// version; patch differences never matter.
function status(receiverVersion, recommended = RECOMMENDED_RECEIVER_VERSION) {
  const r = majorMinor(receiverVersion), want = majorMinor(recommended);
  if (!r || !want) return 'unknown';
  return (r[0] < want[0] || (r[0] === want[0] && r[1] < want[1])) ? 'update' : 'ok';
}

module.exports = { RECOMMENDED_RECEIVER_VERSION, status };
