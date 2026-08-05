'use strict';

// Fake receivers, so the cast/DLNA logic can be exercised without a physical TV.
//
// Why this exists: every cast fix in this codebase has had to be verified against a real LG that
// sleeps at unpredictable times, moves IP via DHCP, answers its eureka endpoint in anywhere from
// 27ms to 5.4s, and stops responding entirely after a few rapid probes. That made iteration slow
// and, worse, made regressions easy to miss — two were shipped and only caught by the user.
//
// These fakes are deliberately faithful to the REAL device's misbehaviour, because the bugs were
// all in the handling of misbehaviour, not the happy path:
//   - eureka can be configured slow, or to fail the first N probes (the cold-start bug)
//   - the DLNA renderer can be told to time out on Play while still "playing" (the double-playback
//     bug: a Play timeout is not the same as a Play failure)
//   - the DLNA renderer can be wedged in TRANSITIONING and answer 701 to everything (the recovery
//     ladder)
//
// Usage: node test/fake-devices.js   → starts both and prints the addresses to point Spritz at.

const http = require('http');
const os = require('os');

// Bind to the real LAN address, not loopback. dlna.js deliberately refuses non-private LOCATIONs as
// an SSRF guard (isLanUrl rejects 127.0.0.1), so a fake on loopback is never registered and every
// test would fail on "device gone" rather than on the behaviour under test.
function lanAddr() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.internal || (a.family !== 'IPv4' && a.family !== 4)) continue;
      if (/^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)/.test(a.address)) return a.address;
    }
  }
  return '127.0.0.1'; // no private address available; DLNA tests will not be meaningful
}

// ---- fake Chromecast/eureka endpoint (discovery only; castv2 itself is not emulated) ----
function fakeEureka({ port = 8008, name = 'Fake webOS TV', delayMs = 0, failFirst = 0 } = {}) {
  let seen = 0;
  const srv = http.createServer((req, res) => {
    if (!/\/setup\/eureka_info/.test(req.url || '')) { res.writeHead(404); return res.end(); }
    seen++;
    if (seen <= failFirst) { req.socket.destroy(); return; } // cold TV drops the first probe(s)
    const body = JSON.stringify({ name, device_info: { model_name: 'FAKE-1', manufacturer: 'Fake', '4k_blocked': 0 } });
    setTimeout(() => {
      try { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(body); } catch (e) {}
    }, delayMs);
  });
  return new Promise((resolve) => srv.listen(port, lanAddr(), () => resolve({ srv, port: srv.address().port, probes: () => seen })));
}

// ---- fake DLNA MediaRenderer (description XML + AVTransport SOAP) ----
// behaviour: 'ok' | 'playTimeout' (accepts and plays, never answers Play) | 'wedged' (701 to all)
function fakeRenderer({ port = 0, behaviour = 'ok', name = 'Fake DLNA Renderer' } = {}) {
  let state = 'STOPPED';
  const calls = [];
  const srv = http.createServer((req, res) => {
    const url = req.url || '';
    if (req.method === 'GET') { // description XML
      const base = 'http://' + lanAddr() + ':' + srv.address().port;
      res.writeHead(200, { 'Content-Type': 'text/xml' });
      return res.end(`<?xml version="1.0"?><root><URLBase>${base}</URLBase><device>`
        + `<friendlyName>${name}</friendlyName><serviceList><service>`
        + `<serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType>`
        + `<controlURL>/ctrl</controlURL></service></serviceList></device></root>`);
    }
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const action = (/<u:(\w+)/.exec(body) || [])[1] || '?';
      calls.push(action);
      const fault = (code, desc) => {
        res.writeHead(500, { 'Content-Type': 'text/xml' });
        res.end(`<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>`
          + `<s:Fault><detail><UPnPError><errorCode>${code}</errorCode>`
          + `<errorDescription>${desc}</errorDescription></UPnPError></detail></s:Fault></s:Body></s:Envelope>`);
      };
      const ok = (inner) => {
        res.writeHead(200, { 'Content-Type': 'text/xml' });
        res.end(`<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>${inner || ''}</s:Body></s:Envelope>`);
      };
      if (behaviour === 'wedged') return fault(701, 'Transition not available');
      if (action === 'SetAVTransportURI') { state = 'TRANSITIONING'; return ok(); }
      if (action === 'Play') {
        state = 'PLAYING';
        if (behaviour === 'playTimeout') return; // start playing, never answer — the trap
        return ok();
      }
      if (action === 'Stop') { state = 'STOPPED'; return ok(); }
      if (action === 'GetTransportInfo') return ok(`<CurrentTransportState>${state}</CurrentTransportState>`);
      return ok();
    });
  });
  return new Promise((resolve) => srv.listen(port, lanAddr(), () => resolve({
    srv, port: srv.address().port, location: 'http://' + lanAddr() + ':' + srv.address().port + '/',
    state: () => state, calls: () => calls.slice()
  })));
}

module.exports = { fakeEureka, fakeRenderer };

if (require.main === module) {
  (async () => {
    const e = await fakeEureka({ port: 0, delayMs: 4400, failFirst: 1 }); // mimics the real LG cold path
    const r = await fakeRenderer({ behaviour: 'ok' });
    console.log('fake eureka   ' + lanAddr() + ':' + e.port + '  (first probe dropped, then 4.4s replies)');
    console.log('fake renderer ' + r.location);
    console.log('Ctrl+C to stop.');
  })();
}
