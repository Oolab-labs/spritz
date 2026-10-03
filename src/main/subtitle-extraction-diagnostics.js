'use strict';

function classify(stderr, { timedOut, bytes, code, signal }) {
  const text = String(stderr || '').toLowerCase();
  if (/non[- ]monoton(?:ic|ically).*dts|error muxing a packet|error submitting a packet to the muxer/.test(text)) return 'timestamp-or-mux-error';
  if (/matches no streams|invalid stream specifier/.test(text)) return 'stream-map-error';
  if (/connection refused|server returned|http error|404 not found/.test(text)) return 'source-request-error';
  if (/timed out|timeout|connection reset|broken pipe/.test(text)) return 'source-read-error';
  if (/invalid data|error parsing|could not find codec parameters/.test(text)) return 'probe-or-demux-error';
  if (/encoder.*not found|unsupported.*codec|conversion failed/.test(text)) return 'conversion-error';
  if (bytes > 12) return timedOut ? 'partial-output' : 'output-available';
  if (timedOut) return 'deadline-before-output';
  if (signal || code) return 'process-failed';
  return 'no-output';
}
function createDiagnostics(redactions = []) {
  let tail = '', terminalMuxFailure = false;
  return {
    capture(chunk) {
      tail = (tail + String(chunk)).slice(-4096);
      if (/error muxing a packet|error submitting a packet to the muxer/i.test(tail)) terminalMuxFailure = true;
    },
    hasTerminalMuxFailure() { return terminalMuxFailure; },
    summarize(facts) {
      let safe = tail;
      for (const value of redactions) if (value) safe = safe.split(String(value)).join('[source]');
      safe = safe.replace(/https?:\/\/[^\s'"<>]+/gi, '[url]').replace(/(?:\/[\w.-]+){2,}/g, '[path]');
      return { category: classify(tail, facts), stderr: safe.slice(-512).replace(/[\r\n]+/g, ' ').trim() };
    }
  };
}
module.exports = { createDiagnostics, classify };
