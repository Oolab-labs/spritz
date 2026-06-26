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

// Cap on a single response body. DLNA descriptions / SOAP replies are a few KB; a hostile or buggy
// LAN renderer could otherwise stream unbounded data into the main process and exhaust memory.
const MAX_BODY = 4 * 1024 * 1024; // 4 MiB
function httpReq(opts, body, cb) {
  let done = false;
  const fin = (e, res, d) => { if (done) return; done = true; cb(e, res, d); };
  const req = http.request(opts, (res) => {
    let d = '', len = 0;
    res.on('data', (c) => {
      if (done) return;
      len += c.length;
      if (len > MAX_BODY) { res.destroy(); req.destroy(); return fin(new Error('response too large')); }
      d += c;
    });
    res.on('end', () => fin(null, res, d));
  });
  req.on('error', (e) => fin(e)); req.setTimeout(6000, () => req.destroy(new Error('timeout')));
  if (body) req.write(body); req.end();
}
const httpGet = (url, cb) => { try { const u = new URL(url); httpReq({ host: u.hostname, port: u.port || 80, path: u.pathname + u.search, method: 'GET' }, null, cb); } catch (e) { cb(e); } };

module.exports = function createDlna() {
  const ev = new EventEmitter();
  const devices = new Map(); // location → device {host,name,avControl,rcControl}
  let sock = null, timer = null, current = null;

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
      // Re-validate the RESOLVED control URLs, not just the LOCATION: a malicious description could set
      // an absolute controlURL pointing off the validated host, redirecting our SOAP POSTs elsewhere.
      if (!isLanUrl(avControl)) { dlog('[dlna] DROPPED "' + name + '" — avControl resolved off-LAN: ' + avControl); return; }
      const rcControl = ctrl(RCS);
      dlog('[dlna] FOUND renderer: "' + name + '" · avControl=' + avControl);
      devices.set(location, { location, host: new URL(location).hostname, name, avControl, rcControl: (rcControl && isLanUrl(rcControl)) ? rcControl : null });
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
  function burst() { [0, 800, 2000, 4000, 8000].forEach((d) => setTimeout(search, d)); }

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
    timer = setInterval(search, 30000);
  }
  function stopDiscovery() { if (timer) { clearInterval(timer); timer = null; } try { if (sock) sock.close(); } catch (e) {} sock = null; }

  // --- SOAP control ---
  function soap(controlUrl, service, action, args, cb) {
    const argsXml = Object.entries(args).map(([k, v]) => `<${k}>${xmlEsc(v)}</${k}>`).join('');
    const body = `<?xml version="1.0" encoding="utf-8"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:${action} xmlns:u="${service}">${argsXml}</u:${action}></s:Body></s:Envelope>`;
    let u; try { u = new URL(controlUrl); } catch (e) { return cb && cb(e); }
    httpReq({ host: u.hostname, port: u.port || 80, path: u.pathname + u.search, method: 'POST',
      headers: { 'Content-Type': 'text/xml; charset="utf-8"', 'SOAPAction': '"' + service + '#' + action + '"', 'Content-Length': Buffer.byteLength(body) }
    }, body, (err, res, d) => cb && cb(err, d));
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
    soap(dev.avControl, AVT, 'SetAVTransportURI', { InstanceID: 0, CurrentURI: media.url, CurrentURIMetaData: meta }, (err, body) => {
      // The LG returns a SOAP fault (HTTP 500 body) when it can't recognise/accept the item — we used to
      // ignore it and report "casting" anyway. Detect it: surface the real reason + fall back to local.
      const fault = err ? err.message : soapFault(body);
      if (fault) { dlog('[dlna] SetAVTransportURI REJECTED: ' + fault); ev.emit('error', { message: 'TV rejected the file (' + fault + ')' }); return cb && cb(new Error(fault)); }
      soap(dev.avControl, AVT, 'Play', { InstanceID: 0, Speed: 1 }, (e2, body2) => {
        const f2 = e2 ? e2.message : soapFault(body2);
        if (f2) { dlog('[dlna] Play REJECTED: ' + f2); ev.emit('error', { message: 'TV could not start playback (' + f2 + ')' }); return cb && cb(new Error(f2)); }
        dlog('[dlna] SetAVTransportURI + Play OK');
        cb && cb();
      });
    });
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

  return { on: (e, fn) => ev.on(e, fn), startDiscovery, stopDiscovery, load, play, pause, stop, seek, setVolume, position, transportState, teardown };
};
