'use strict';

// Host lists shared by the Cast eureka sweep (cast.js) and the DLNA unicast SSDP sweep (dlna.js),
// so both walk exactly the same subnets and accept exactly the same manual addresses.

// Physical-LAN private IPv4s only (skip loopback + VPN/tunnel interfaces). Takes the interface
// map rather than reading `os` itself: the callers' `os` is the one tests stub
// (test/discovery-retry.test.js), and a direct require here would read the real machine's NICs.
function lanSubnets(ifaces) {
  const out = [];
  for (const name of Object.keys(ifaces || {})) {
    if (!/^(en|eth)/i.test(name)) continue; // physical NICs only
    for (const a of ifaces[name] || []) {
      if (a.internal) continue;
      if (a.family !== 'IPv4' && a.family !== 4) continue;
      if (!/^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)/.test(a.address)) continue;
      out.push(a.address);
    }
  }
  return out;
}

// The Settings "Manual TV addresses" CSV. IPv4 literals only, because these get probed directly;
// de-duplicated so a repeated address is not probed twice per sweep.
function parseHosts(csv) {
  return [...new Set(String(csv || '').split(',').map((x) => x.trim())
    .filter((x) => /^\d{1,3}(\.\d{1,3}){3}$/.test(x)))];
}

module.exports = { lanSubnets, parseHosts };
