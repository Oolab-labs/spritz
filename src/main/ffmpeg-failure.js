'use strict';

// Why did ffmpeg produce nothing?
//
// The cast path retries once with the software encoder whenever a run ends without emitting a byte.
// That is right for a hardware encoder that could not start, and wrong for everything else: when the
// input is the problem — a torrent that went quiet, a URL that 404s, a socket that timed out —
// relaunching with a different ENCODER changes nothing, wastes the receiver's patience on a second
// doomed attempt, and reads in the log as an encoder problem when it never was.
//
// The old player distinguished these by matching stderr for specific hardware failures. Those
// strings are stable across ffmpeg versions because they come from VideoToolbox itself.

// The encoder could not be created or used. A software retry is exactly the right answer.
const ENCODER_FAILURE = [
  /cannot create compression session/i,
  /no device available for encoder/i,
  /hardware encoder may be busy/i,
  /error encoding frame/i,
  /videotoolbox.*(fail|error|unsupported)/i,
  /encoder .* not (found|available)/i
];

// The source is the problem. A software retry cannot help, and trying is worse than failing.
const INPUT_FAILURE = [
  /error opening input/i,
  /server returned \d{3}/i,
  /connection timed out/i,
  /operation timed out/i,
  /input\/output error/i,
  /end of file/i,
  /invalid data found when processing input/i,
  /no such file or directory/i
];

const anyMatch = (patterns, text) => patterns.some((re) => re.test(text));

// Returns 'encoder' | 'input' | 'unknown'. Unknown deliberately keeps the old behaviour — retrying
// once costs little, and this should not become a way to silently stop trying.
function classifyFailure(stderr) {
  const text = String(stderr || '');
  if (!text.trim()) return 'unknown';
  // Input errors are checked first: a run that failed to open its source often also prints encoder
  // noise on the way down, and the first cause is the real one.
  if (anyMatch(INPUT_FAILURE, text)) return 'input';
  if (anyMatch(ENCODER_FAILURE, text)) return 'encoder';
  return 'unknown';
}

// Should a run that produced nothing be retried with the software encoder?
function shouldRetryInSoftware(stderr) {
  return classifyFailure(stderr) !== 'input';
}

module.exports = { classifyFailure, shouldRetryInSoftware, ENCODER_FAILURE, INPUT_FAILURE };
