'use strict';

// DLNA / UPnP "play to" (main process). For TVs that speak neither AirPlay nor Google
// Cast but DO expose a UPnP MediaRenderer (many LG/Samsung/Sony sets, and DLNA boxes).
//
// Discovery: SSDP M-SEARCH for MediaRenderer → fetch each device's description XML →
// pull friendlyName + the AVTransport/RenderingControl control URLs.
// Control: SOAP to AVTransport — SetAVTransportURI(LAN media URL + DIDL) then Play;
// plus Pause/Stop/Seek/GetPositionInfo and RenderingControl SetVolume.
// The media URL is the same 0.0.0.0 LAN server URL used by AirPlay/Cast (remux-aware).

const EventEmitter = require('events');
const dgram = require('dgram');
const http = require('http');
const os = require('os');
const fs = require('fs');
const { URL } = require('url');

// Opt-in plain-file diagnostic log (set SPRITZ_DEBUG=1 to enable; open /tmp/spritz-dlna.log in Finder).
// Off by default so a public build never writes device names / media URLs to world-readable /tmp.
const DBG = !!process.env.SPRITZ_DEBUG;
const DLOG = '/tmp/spritz-dlna.log';
if (DBG) { try { fs.writeFileSync(DLOG, '[dlna] log started\n'); } catch (e) {} }
function dlog(m) { if (!DBG) return; try { fs.appendFileSync(DLOG, m + '\n'); } catch (e) {} try { console.log(m); } catch (e) {} }

const SSDP_ADDR = '239.255.255.250', SSDP_PORT = 1900;
const AVT = 'urn:schemas-upnp-org:service:AVTransport:1';
const RCS = 'urn:schemas-upnp-org:service:RenderingControl:1';

// Only follow LOCATION URLs on the local/private network (SSRF guard). The LOCATION
// comes from an unauthenticated SSDP response, so be strict: require a real dotted-quad
// in a private range (rejects octal/hex/decimal/short-form IP tricks and IPv6) or a
// .local name, and never loopback (no self-targeting).
function isLanUrl(u) {
  try {
    const h = new URL(u).hostname.toLowerCase();
    if (!h || h === 'localhost' || h.includes(':')) return false; // no IPv6 / loopback
    if (/\.local$/.test(h)) return true;
    const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (!m) return false;
    const o = m.slice(1).map(Number);
    if (o.some((x) => x > 255)) return false;
    // RFC1918 + link-local. (169.254/16 kept so a TV without DHCP is still reachable; the cloud
    // metadata-endpoint SSRF that motivated dropping it doesn't apply to a desktop app on a home LAN.)
    return o[0] === 10 || (o[0] === 192 && o[1] === 168) || (o[0] === 172 && o[1] >= 16 && o[1] <= 31) || (o[0] === 169 && o[1] === 254);
  } catch (e) { return false; }
}
const xmlEsc = (s) => String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
const tag = (xml, name) => { const m = new RegExp('<' + name + '[^>]*>([\\s\\S]*?)</' + name + '>', 'i').exec(xml); return m ? m[1].trim() : null; };
// A UPnP control response carries a fault on rejection: a SOAP <Fault> wrapping
// <UPnPError><errorCode>714</errorCode><errorDescription>…</errorDescription></UPnPError>. Returns e.g.
// "714 Illegal MIME-type" so we can SURFACE the TV's real reason instead of silently reporting success.
function soapFault(xml) {
  if (!xml) return null;
  const code = tag(xml, 'errorCode');
  if (code) { const d = tag(xml, 'errorDescription'); return code + (d ? ' ' + d : ''); }
  if (/<(?:\w+:)?Fault\b/i.test(xml)) return tag(xml, 'faultstring') || 'SOAP fault';
  return null;
}

function httpReq(opts, body, cb, timeoutMs) {
  const req = http.request(opts, (res) => { let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => cb(null, res, d)); });
  req.on('error', (e) => cb(e)); req.setTimeout(timeoutMs || 6000, () => req.destroy(new Error('timeout')));
  if (body) req.write(body); req.end();
}
// Per-action SOAP budgets. A blanket 6s was wrong in both directions: Play/SetAVTransportURI make
// the TV open and buffer the stream before answering (an LG can sit well past 6s on a cold start,
// and a spurious timeout there leaves a session half-established), while a status poll that hasn't
// answered in 2s is simply not going to. Polls stay tight so the UI can't stall behind them.
// SPRITZ_SOAP_TIMEOUT_SCALE shrinks every budget proportionally. The timeout behaviour itself is
// what the regression tests exercise — a Play that times out while the renderer is in fact playing
// must not be reported as failure — so they have to wait one out, and at full scale that single
// test took 30s of a 30s suite. A suite that slow stops being run, which costs more than it saves.
// Tests set 0.02 (Play: 20s -> 400ms); anything unset or unparseable leaves production untouched.
const TSCALE = (() => {
  const v = parseFloat(process.env.SPRITZ_SOAP_TIMEOUT_SCALE || '');
  return Number.isFinite(v) && v > 0 && v <= 1 ? v : 1;
})();
const SOAP_TIMEOUT = { SetAVTransportURI: 20000, Play: 20000, Stop: 10000, Seek: 10000,
  GetPositionInfo: 2500, GetTransportInfo: 2500, SetVolume: 4000 };
for (const k of Object.keys(SOAP_TIMEOUT)) SOAP_TIMEOUT[k] = Math.max(50, Math.round(SOAP_TIMEOUT[k] * TSCALE));
const httpGet = (url, cb) => { try { const u = new URL(url); httpReq({ host: u.hostname, port: u.port || 80, path: u.pathname + u.search, method: 'GET' }, null, cb); } catch (e) { cb(e); } };

// Physical-LAN private IPv4s only (skip loopback + VPN/tunnel interfaces) — same rule as cast.js,
// so the unicast SSDP sweep below walks exactly the subnets the eureka sweep does.
function lanSubnets() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
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
// User-entered addresses (Settings) merged with the SPRITZ_DLNA_HOSTS env var — probed by the
// unicast sweep alongside normal SSDP, for renderers that never answer a broadcast.
let userHosts = [];
function setManualHosts(csv) {
  userHosts = String(csv || '').split(',').map((x) => x.trim())
    .filter((x) => /^\d{1,3}(\.\d{1,3}){3}$/.test(x));
}
function manualHosts() {
  const env = String(process.env.SPRITZ_DLNA_HOSTS || '').split(',').map((s) => s.trim()).filter(Boolean);
  return [...new Set(userHosts.concat(env))];
}

// Durable last-good renderer cache. The LG's SSDP responder is INTERMITTENT — it answers unicast
// M-SEARCH right after cast activity and goes silent when idle, while its UPnP HTTP stack stays up
// (description XML at :1366 answers in ~16ms regardless). So SSDP alone makes DLNA "come and go".
// Remembering the LOCATION URLs lets startDiscovery() re-fetch them over plain HTTP and find the TV
// with no SSDP reply at all. Advisory only: the full /24 sweep still runs unconditionally, so a
// DHCP lease change can't strand discovery on a stale cache.
const CACHE_FILE = (() => {
  try { return require('path').join(require('electron').app.getPath('userData'), 'dlna-renderers.json'); }
  catch (e) { return require('path').join(os.homedir(), '.spritz-dlna-renderers.json'); } // non-Electron (tests)
})();
function loadCache() {
  try { const j = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); return Array.isArray(j) ? j.filter((x) => x && x.location) : []; }
  catch (e) { return []; }
}
function saveCache(list) { try { fs.writeFileSync(CACHE_FILE, JSON.stringify(list.slice(0, 8))); } catch (e) {} }
function knownHosts() { return loadCache().map((c) => c.host).filter(Boolean); }

module.exports = function createDlna() {
  const ev = new EventEmitter();
  const devices = new Map(); // location → device {host,name,avControl,rcControl}
  let sock = null, timer = null, current = null;
  let burstTimers = []; // pending M-SEARCH probes, cancelled by stopDiscovery()

  function emitDevices() {
    const list = [...devices.values()].map((d) => ({ id: 'dlna-' + d.location, type: 'dlna', name: d.name, location: d.location }));
    dlog('[dlna] emitDevices -> ' + list.length + ' device(s): ' + (list.map((d) => d.name).join(', ') || '(none)'));
    ev.emit('devices', list);
  }

  function fetchDevice(location) {
    if (devices.has(location)) { dlog('[dlna] (already known) ' + location); return; }
    if (!isLanUrl(location)) { dlog('[dlna] IGNORED non-LAN LOCATION: ' + location); return; }
    httpGet(location, (err, res, xml) => {
      if (err || !xml) { dlog('[dlna] description fetch FAILED: ' + location + ' · ' + (err && err.message)); return; }
      // only MediaRenderers (must have an AVTransport service)
      if (!new RegExp(AVT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(xml)) { dlog('[dlna] not a MediaRenderer (no AVTransport service): ' + location); return; }
      const name = tag(xml, 'friendlyName') || 'DLNA Renderer';
      const base = (tag(xml, 'URLBase')) || new URL(location).origin;
      // Resolve the SOAP control URL exactly like the original known-working build (no host filtering —
      // that's what was dropping the LG). The LOCATION itself was already LAN-validated above.
      const ctrl = (svcType) => {
        const blocks = xml.match(/<service>[\s\S]*?<\/service>/gi) || [];
        for (const b of blocks) if (b.includes(svcType)) {
          const c = tag(b, 'controlURL'); if (!c) continue;
          try { return new URL(c, base).href; } catch (e) {}
        }
        return null;
      };
      const avControl = ctrl(AVT);
      if (!avControl) { dlog('[dlna] DROPPED "' + name + '" — has AVTransport in XML but no controlURL parsed · ' + location); return; }
      dlog('[dlna] FOUND renderer: "' + name + '" · avControl=' + avControl);
      const host = new URL(location).hostname;
      devices.set(location, { location, host, name, avControl, rcControl: ctrl(RCS) });
      // Remember it: this exact LOCATION is re-fetchable over HTTP even when SSDP goes quiet.
      saveCache([{ location, host, name }].concat(loadCache().filter((c) => c.location !== location)));
      emitDevices();
    });
  }

  // Query several search targets — some renderers (incl. LG webOS) answer one ST but not another.
  const STS = [AVT, 'urn:schemas-upnp-org:device:MediaRenderer:1', 'ssdp:all'];
  function search() {
    if (!sock) return;
    for (const st of STS) {
      const msg = Buffer.from(['M-SEARCH * HTTP/1.1', 'HOST: ' + SSDP_ADDR + ':' + SSDP_PORT,
        'MAN: "ssdp:discover"', 'MX: 2', 'ST: ' + st, '', ''].join('\r\n'));
      try { sock.send(msg, 0, msg.length, SSDP_PORT, SSDP_ADDR); } catch (e) {}
    }
  }
  // A single UDP M-SEARCH is easily lost, so fire a short burst — the TV appears in ~1–6s instead of
  // possibly waiting for the 60s periodic re-search (which is why DLNA seemed to come and go).
  // Burst timers are tracked so stopDiscovery() can cancel them. They used to be fire-and-forget:
  // after teardown the remaining probes still fired, up to 8s later, against a socket that had just
  // been closed and set to null — pointless work for a discovery the caller explicitly stopped, and
  // enough to hold the event loop open (which is why the test suite idled for 8s after finishing).
  function burst() {
    [0, 800, 2000, 4000, 8000].forEach((d) => burstTimers.push(setTimeout(search, d)));
    [300, 5000].forEach((d) => burstTimers.push(setTimeout(unicastSweep, d))); // multicast-less networks (see below)
  }

  // Unicast M-SEARCH fallback. Plenty of home routers/APs silently drop 239.255.255.250 between
  // wireless clients (IGMP snooping with no querier, "multicast optimization"/Airtime Fairness) —
  // the TV is perfectly reachable by unicast but answers no multicast probe at all, so the renderer
  // list stays empty forever and DLNA looks dead. SSDP is just HTTPU, so the SAME M-SEARCH sent
  // straight at the TV's :1900 gets a normal reply. Sweep the local /24 exactly like cast.js's
  // eureka fallback — that unicast sweep is the only reason Chromecast kept working on such a LAN.
  // (Verified on an LG webOS NANO80T6A: zero multicast replies, instant unicast reply.)
  const UNI_STS = [AVT, 'urn:schemas-upnp-org:device:MediaRenderer:1']; // skip ssdp:all — 254 hosts × all-services is a lot of noise
  // A unicast M-SEARCH is NOT the multicast datagram sent to a different address: UDA 1.1 requires
  // HOST to name the TARGET, and MX is defined as multicast-only (it exists so many responders can
  // jitter their replies apart — a strict stack discards a unicast probe carrying it, and a lenient
  // one may sit on the reply for up to MX seconds for no reason). Build the unicast form properly.
  const uniMsg = (host, st) => Buffer.from([
    'M-SEARCH * HTTP/1.1', 'HOST: ' + host + ':' + SSDP_PORT, 'MAN: "ssdp:discover"',
    'ST: ' + st, 'USER-AGENT: darwin/' + os.release() + ' UPnP/1.1 Spritz', '', ''
  ].join('\r\n'));
  // …but the ONLY form ever observed to get a reply out of the LG is the multicast-shaped one
  // (HOST: 239.255.255.250, MX: 2) — and that observation couldn't be re-confirmed afterwards
  // because the TV's SSDP responder sleeps when idle, so neither form is proven against it.
  // Until one is, the first sweep sends BOTH and lets the device answer whichever it prefers;
  // later sweeps send only the spec-correct form to keep the traffic halved.
  const legacyMsg = (st) => Buffer.from(['M-SEARCH * HTTP/1.1', 'HOST: ' + SSDP_ADDR + ':' + SSDP_PORT,
    'MAN: "ssdp:discover"', 'MX: 2', 'ST: ' + st, '', ''].join('\r\n'));
  let sweptOnce = false;
  function unicastSweep() {
    if (!sock) return;
    const hosts = knownHosts().concat(manualHosts()); // last-good renderers answer first
    for (const ip of lanSubnets()) {
      const base = ip.replace(/\.\d+$/, '.');
      for (let n = 1; n <= 254; n++) { const h = base + n; if (h !== ip && hosts.indexOf(h) < 0) hosts.push(h); }
    }
    if (!hosts.length) return;
    const both = !sweptOnce; // first sweep probes with both datagram forms (see uniMsg/legacyMsg)
    dlog('[dlna] unicast SSDP sweep over ' + hosts.length + ' host(s)' + (both ? ' (both forms)' : ''));
    // Stagger the sends: ~500 datagrams back-to-back can overrun the socket send buffer and looks
    // like a port scan to some APs. Spread them over ~1s in small chunks instead.
    let i = 0;
    const CHUNK = 16;
    const pump = () => {
      if (!sock || i >= hosts.length) return;
      for (let c = 0; c < CHUNK && i < hosts.length; c++, i++) {
        const h = hosts[i];
        for (const st of UNI_STS) {
          const msg = uniMsg(h, st);
          try { sock.send(msg, 0, msg.length, SSDP_PORT, h); } catch (e) {}
          if (both) { const lm = legacyMsg(st); try { sock.send(lm, 0, lm.length, SSDP_PORT, h); } catch (e) {} }
        }
      }
      setTimeout(pump, 40);
    };
    pump();
    sweptOnce = true;
  }

  function startDiscovery() {
    if (sock) { emitDevices(); burst(); return; }
    sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    sock.on('error', () => {});
    sock.on('message', (msg, rinfo) => {
      const s = msg.toString();
      const m = /LOCATION:\s*(\S+)/i.exec(s);
      if (m) { const srv = /SERVER:\s*(.*)/i.exec(s); dlog('[dlna] SSDP resp from ' + (rinfo && rinfo.address) + ' LOCATION=' + m[1].trim() + (srv ? ' SERVER=' + srv[1].trim().slice(0, 60) : '')); fetchDevice(m[1].trim()); }
    });
    sock.bind(() => { try { sock.setBroadcast(true); } catch (e) {} dlog('[dlna] discovery started — SSDP socket bound, sending M-SEARCH burst'); burst(); });
    // Don't wait on SSDP at all for renderers we've already met — re-fetch their description
    // directly. This is what makes the TV appear instantly when its SSDP responder is asleep.
    for (const c of loadCache()) { dlog('[dlna] re-probing cached renderer ' + c.location); fetchDevice(c.location); }
    timer = setInterval(() => { search(); unicastSweep(); }, 30000);
  }
  function stopDiscovery() {
    if (timer) { clearInterval(timer); timer = null; }
    burstTimers.forEach(clearTimeout); burstTimers = [];
    try { if (sock) sock.close(); } catch (e) {} sock = null;
  }

  // --- SOAP control ---
  function soap(controlUrl, service, action, args, cb) {
    const argsXml = Object.entries(args).map(([k, v]) => `<${k}>${xmlEsc(v)}</${k}>`).join('');
    const body = `<?xml version="1.0" encoding="utf-8"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:${action} xmlns:u="${service}">${argsXml}</u:${action}></s:Body></s:Envelope>`;
    let u; try { u = new URL(controlUrl); } catch (e) { return cb && cb(e); }
    httpReq({ host: u.hostname, port: u.port || 80, path: u.pathname + u.search, method: 'POST',
      // Connection: close — the LG's UPnP server handles keep-alive poorly and a reused socket is a
      // common cause of it going unresponsive after a few control requests.
      headers: { 'Content-Type': 'text/xml; charset="utf-8"', 'SOAPAction': '"' + service + '#' + action + '"', 'Content-Length': Buffer.byteLength(body), 'Connection': 'close' }
    }, body, (err, res, d) => cb && cb(err, d), SOAP_TIMEOUT[action]);
  }

  // UPnP res@duration format: H+:MM:SS.mmm
  function durHms(sec) {
    const s = Math.max(0, Math.floor(Number(sec) || 0));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
    const ms = Math.round(((Number(sec) || 0) - Math.floor(Number(sec) || 0)) * 1000);
    return h + ':' + String(m).padStart(2, '0') + ':' + String(ss).padStart(2, '0') + '.' + String(Math.min(999, ms)).padStart(3, '0');
  }

  function didl(url, title, contentType, subUrl, size, duration) {
    // 4th protocolInfo field carries DLNA flags — MUST be byte-identical to the HTTP
    // contentFeatures.dlna.org header lanserver.js sends for the SAME url, or strict webOS rejects.
    //   • /dlna/ proxy URL = a still-downloading torrent (growing source): OP=00 (no byte-seek, so the
    //     LG reads linearly and never seeks onto undownloaded pieces) + S0/SN_INCREASE + CONNECTION_STALL.
    //   • everything else = a complete, fully-seekable file: OP=01 byte-range seek. CI=0 = not transcoded.
    const isLive = /\/dlna\//.test(String(url));
    const dlnaFlags = isLive
      ? 'DLNA.ORG_OP=00;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=0D500000000000000000000000000000'
      : 'DLNA.ORG_OP=01;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=01700000000000000000000000000000';
    // External-subtitle sidecar (webOS/Samsung): a text/srt <res> the TV fetches alongside the video,
    // plus the sec:CaptionInfoEx / pv:subtitleFileUri vendor extensions (different firmwares honour
    // different ones — all harmless if ignored). Embedded subs need none of this (TV reads them).
    const sub = subUrl
      ? '<res protocolInfo="http-get:*:text/srt:*">' + xmlEsc(subUrl) + '</res>' +
        '<sec:CaptionInfoEx sec:type="srt">' + xmlEsc(subUrl) + '</sec:CaptionInfoEx>' +
        '<sec:CaptionInfo sec:type="srt">' + xmlEsc(subUrl) + '</sec:CaptionInfo>' +
        '<pv:subtitleFileUri>' + xmlEsc(subUrl) + '</pv:subtitleFileUri><pv:subtitleFileType>srt</pv:subtitleFileType>'
      : '';
    // Standard UPnP <res> attributes. Strict webOS firmwares reject an item whose <res> they can't
    // profile — an attribute-less res is a known "this file cannot be recognized" cause. size + duration
    // are what every DLNA server (MiniDLNA/Plex/Serviio) sends; both are purely additive (a renderer that
    // doesn't need them ignores them) so this can't break a file that already plays. Omitted when unknown
    // (e.g. a still-downloading torrent proxy has no fixed size) so we never advertise a wrong value.
    // (Deliberately NO guessed DLNA.ORG_PN profile token — a wrong PN is itself a documented reject cause.)
    let resAttrs = '';
    if (size && Number(size) > 0) resAttrs += ' size="' + Math.floor(Number(size)) + '"';
    if (duration && Number(duration) > 0) resAttrs += ' duration="' + durHms(duration) + '"';
    return '<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" xmlns:sec="http://www.sec.co.kr/" xmlns:pv="http://www.pv.com/pvns/">' +
      '<item id="0" parentID="-1" restricted="1"><dc:title>' + xmlEsc(title || 'Spritz') + '</dc:title>' +
      '<upnp:class>object.item.videoItem</upnp:class>' +
      '<res protocolInfo="http-get:*:' + (contentType || 'video/mp4') + ':' + dlnaFlags + '"' + resAttrs + '>' + xmlEsc(url) + '</res>' + sub + '</item></DIDL-Lite>';
  }

  // load(location, media, cb) — media = {url, title, contentType, subtitleUrl}
  function load(location, media, cb) {
    const dev = devices.get(location); if (!dev) return cb && cb(new Error('device gone'));
    current = dev;
    const meta = didl(media.url, media.title, media.contentType, media.subtitleUrl, media.size, media.duration);
    dlog('[dlna] load "' + (media.title || '') + '" ct=' + media.contentType + ' url=' + String(media.url).slice(0, 90));
    dlog('[dlna] DIDL=' + meta);
    // D2 recovery ladder. An LG renderer that was left mid-session sticks in TRANSITIONING and
    // answers UPnP 701 "Transition not available" to everything — including the SetAVTransportURI
    // we are about to send — until something resets it. A plain Stop first clears the vast majority
    // of those, so always try it and ignore its result (a healthy renderer answers Stop happily,
    // and a wedged one times out, which is exactly the case we are recovering from). Only then load.
    soap(dev.avControl, AVT, 'Stop', { InstanceID: 0 }, () => setAndPlay());
    function setAndPlay() {
    soap(dev.avControl, AVT, 'SetAVTransportURI', { InstanceID: 0, CurrentURI: media.url, CurrentURIMetaData: meta }, (err, body) => {
      // The LG returns a SOAP fault (HTTP 500 body) when it can't recognise/accept the item — we used to
      // ignore it and report "casting" anyway. Detect it: surface the real reason + fall back to local.
      const fault = err ? err.message : soapFault(body);
      if (fault) {
        dlog('[dlna] SetAVTransportURI REJECTED: ' + fault);
        // 701 after the Stop above means the renderer is genuinely wedged, not that the file is bad.
        // Say so, because "TV rejected the file" sends the user hunting the wrong problem entirely.
        const wedged = /^701\b/.test(fault);
        ev.emit('error', { message: wedged
          ? 'The TV’s DLNA player is stuck and won’t accept new media. Stop playback on the TV, or restart it, then try again.'
          : 'TV rejected the file (' + fault + ')' });
        return cb && cb(new Error(fault));
      }
      soap(dev.avControl, AVT, 'Play', { InstanceID: 0, Speed: 1 }, (e2, body2) => {
        const f2 = e2 ? e2.message : soapFault(body2);
        if (f2) {
          // A Play that TIMED OUT has not necessarily failed. This LG regularly starts playing and
          // answers late, or never. Reporting failure here makes the orchestrator resume local
          // playback while the TV is already playing the same file, so it plays on BOTH screens at
          // once. Ask the renderer what it is actually doing before deciding. A genuine SOAP fault
          // (an errorCode, not a timeout) is still a real rejection and skips the grace check.
          const timedOut = !!(e2 && /timeout/i.test(e2.message || ''));
          const fail = (tstate) => {
            dlog('[dlna] Play REJECTED: ' + f2 + (tstate ? ' (TV state=' + tstate + ')' : ''));
            ev.emit('error', { message: 'TV could not start playback (' + f2 + ')' });
            cb && cb(new Error(f2));
          };
          if (!timedOut) return fail(null);
          dlog('[dlna] Play timed out — verifying what the TV is ACTUALLY doing before giving up');
          return setTimeout(() => transportState((tstate) => {
            if (tstate && tstate !== 'STOPPED' && tstate !== 'NO_MEDIA_PRESENT') {
              dlog('[dlna] ...TV reports ' + tstate + ' — the cast DID start; treating as success');
              return cb && cb();
            }
            fail(tstate);
          }), Math.max(50, Math.round(2000 * TSCALE))); // scaled with the SOAP budgets, see TSCALE
        }
        dlog('[dlna] SetAVTransportURI + Play OK');
        cb && cb();
      });
    });
    }
  }
  const withAv = (action, args) => { if (current) soap(current.avControl, AVT, action, Object.assign({ InstanceID: 0 }, args), () => {}); };
  function play() { withAv('Play', { Speed: 1 }); }
  function pause() { withAv('Pause', {}); }
  function stop() { withAv('Stop', {}); current = null; }
  function seek(t) { // REL_TIME hh:mm:ss
    const s = Math.max(0, Math.floor(t)), hh = String(Math.floor(s / 3600)).padStart(2, '0'),
      mm = String(Math.floor(s % 3600 / 60)).padStart(2, '0'), ss = String(s % 60).padStart(2, '0');
    withAv('Seek', { Unit: 'REL_TIME', Target: hh + ':' + mm + ':' + ss });
  }
  function setVolume(f) { if (current && current.rcControl) soap(current.rcControl, RCS, 'SetVolume', { InstanceID: 0, Channel: 'Master', DesiredVolume: Math.round(f * 100) }, () => {}); }
  const hmsToSec = (s) => { const m = /(\d+):(\d{2}):(\d{2})/.exec(s || ''); return m ? (+m[1] * 3600 + +m[2] * 60 + +m[3]) : 0; };
  // GetPositionInfo → elapsed/duration so the renderer's remote scrubber actually advances during
  // a DLNA cast (otherwise it sits frozen at 0:00 — the renderer already handles a 'status' event).
  function position(cb) {
    if (!current) return cb(null);
    soap(current.avControl, AVT, 'GetPositionInfo', { InstanceID: 0 }, (err, xml) => {
      if (err || !xml) return cb(null);
      cb({ cur: hmsToSec(tag(xml, 'RelTime')), dur: hmsToSec(tag(xml, 'TrackDuration')) });
    });
  }
  // GetTransportInfo → PLAYING/PAUSED_PLAYBACK/STOPPED/NO_MEDIA_PRESENT (drives play icon +
  // detects the user stopping playback on the TV itself).
  function transportState(cb) {
    if (!current) return cb(null);
    soap(current.avControl, AVT, 'GetTransportInfo', { InstanceID: 0 }, (err, xml) => {
      cb(err ? null : tag(xml, 'CurrentTransportState'));
    });
  }

  function teardown() { try { if (current) stop(); } catch (e) {} stopDiscovery(); current = null; } // stop the TV, not just discovery

  return { on: (e, fn) => ev.on(e, fn), startDiscovery, stopDiscovery, load, play, pause, stop, seek, setVolume, position, transportState, teardown, setManualHosts };
};
