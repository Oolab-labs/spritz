'use strict';

// The DLNA content-feature flags, in one place because they have to be byte-identical in two.
//
// A strict webOS renderer compares the `contentFeatures.dlna.org` HTTP header against the
// protocolInfo in the SOAP DIDL and refuses the item when they differ. Those two strings were
// written out separately — in lanserver.js and dlna.js — each carrying a comment telling the next
// person to keep them in step. That works right up until someone changes one of them, which is
// what adding a third case would have been.
//
//   STATIC — a complete, fully seekable source. OP=01 (byte-range seek) plus
//            STREAMING|BACKGROUND|CONNECTION_STALL|DLNA_V15.
//   LIVE   — a still-downloading torrent served through the /dlna/ proxy. OP=00, NO byte-seek, so
//            the television reads linearly and never seeks onto pieces that have not arrived; plus
//            S0_INCREASE|SN_INCREASE, a source with no fixed end. This is the conservative answer,
//            and it costs the viewer the scrubber for the whole film.
//
// CI=0 in both: not transcoded.
const STATIC = 'DLNA.ORG_OP=01;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=01700000000000000000000000000000';
const LIVE = 'DLNA.ORG_OP=00;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=0D500000000000000000000000000000';

// Letting the television seek inside a still-downloading torrent.
//
// OFF BY DEFAULT AND UNVERIFIED ON HARDWARE. The claim it makes to the TV — this source is complete
// and you may byte-seek anywhere in it — is only true because the proxy prioritises the pieces
// behind a range before serving it (see seek-window.js and torrent.js's ensureBytes). If that
// priority does not land fast enough on a real swarm, the failure is the mid-play drop OP=00 was
// chosen to avoid, so it stays opt-in until it has been watched on the LG.
//
//   SPRITZ_TORRENT_SEEK=1
//
// Rollback is removing the variable: without it not one byte of the advertised profile changes.
const SEEK_ENABLED = () => process.env.SPRITZ_TORRENT_SEEK === '1';

// Which profile a URL gets. The /dlna/ path is the torrent proxy and nothing else — every other URL
// this app hands a renderer is a complete file served by /file/.
function flagsFor(url) {
  const proxied = /\/dlna\//.test(String(url || ''));
  if (!proxied) return STATIC;
  return SEEK_ENABLED() ? STATIC : LIVE;
}

module.exports = { STATIC, LIVE, flagsFor, SEEK_ENABLED };
