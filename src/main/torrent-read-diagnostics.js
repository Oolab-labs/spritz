'use strict';

// Observe response sockets without wrapping writes or changing stream scheduling.
// The byte delta includes HTTP headers and any pipelined replies on that socket.
function observeTorrentReads(server, { log, schedule = setInterval, clear = clearInterval, now = Date.now }) {
  let next = 0;
  server.on('request', (req, res) => {
    const id = ++next, began = now(), socket = res.socket || req.socket;
    const base = socket && socket.bytesWritten || 0;
    const range = /^bytes=(\d+)-(\d*)$/.exec(String(req.headers && req.headers.range || ''));
    const agent = String(req.headers && req.headers['user-agent'] || '');
    const reader = /mpv/i.test(agent) ? 'mpv' : /lavf|ffmpeg/i.test(agent) ? 'ffmpeg' : 'other';
    const facts = { id, reader, clientPort: req.socket && req.socket.remotePort,
      rangeStart: range ? Number(range[1]) : null, rangeEnd: range && range[2] ? Number(range[2]) : null };
    let done = false, timer;
    const emit = event => log({ ...facts, event, elapsedMs: now() - began, status: res.statusCode,
      headersSent: !!res.headersSent, connectionBytesWrittenDelta: Math.max(0, (socket && socket.bytesWritten || base) - base) });
    function finish() { if (done) return; done = true; clear(timer); emit(res.writableFinished ? 'finished' : 'closed'); }
    res.once('finish', finish); res.once('close', finish);
    emit('request'); timer = schedule(() => emit('progress'), 2000);
    if (timer && typeof timer.unref === 'function') timer.unref();
  });
}
module.exports = { observeTorrentReads };
