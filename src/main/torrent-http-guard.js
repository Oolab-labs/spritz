'use strict';

// Install BEFORE listen(): WebTorrent binds wrapRequest as its sole request handler there.
// A separate/prepended listener cannot short-circuit EventEmitter dispatch.
function guardTorrentServer(server, selected) {
  const dispatch = server.wrapRequest.bind(server);
  // WebTorrent's constructor coerces origin:false back to '*', so set it after construction.
  server.opts.origin = false;
  server.wrapRequest = (req, res) => {
    const reject = status => {
      res.writeHead(status, { 'Content-Length': '0', 'Connection': 'close' });
      res.end();
    };
    const port = server.server.address().port;
    if (![`localhost:${port}`, `127.0.0.1:${port}`].includes(req.headers.host) ||
        req.headers.origin !== undefined ||
        ['cross-site', 'same-site'].includes(req.headers['sec-fetch-site'])) return reject(403);
    if (req.method !== 'GET' && req.method !== 'HEAD') return reject(405);
    let pathname;
    try {
      // Accept origin-form requests only, and validate escapes before the library's async handler.
      if (!req.url.startsWith('/') || req.url.startsWith('//')) return reject(400);
      pathname = new URL(req.url, 'http://localhost').pathname;
      decodeURIComponent(pathname);
    } catch (e) { return reject(400); }
    const m = /^\/webtorrent\/([0-9a-f]{40})\/(.+)$/.exec(pathname);
    const current = selected();
    if (!m || !current || m[1] !== current.infoHash ||
        decodeURIComponent(m[2]) !== current.path.replace(/\\/g, '/')) return reject(404);
    return dispatch(req, res);
  };
}

module.exports = { guardTorrentServer };
