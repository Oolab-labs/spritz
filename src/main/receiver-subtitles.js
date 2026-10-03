'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { trimToCompleteCues, coverageEnd } = require('./vtt-window');
const { createDiagnostics } = require('./subtitle-extraction-diagnostics');

// Receiver-only preparation. Legacy AirPlay rendition publication is intentionally separate.
function createReceiverSubtitles({ input, tracks, dir, baseUrl, ffmpeg, duration = 0,
  acquireInput = null, spawnProcess = spawn, budgetMs = 25000, sampleMs = 500, retryMs = 5000, sniffCharenc = () => 'UTF-8', log = () => {} }) {
  let disposed = false, serial = 0;
  const tasks = new Map(), activeWorkers = new Set();
  for (const [index, track] of tracks.entries()) {
    const name = 'sub_' + index + '_' + String(track.lang || 'und').replace(/[^a-z0-9_-]/gi, '') + '.vtt';
    tasks.set(name, { track, name, owners: new Map(), revision: null, revisions: [], worker: null, failedAt: 0 });
  }
  const entries = [...tasks.values()].map(task => ({ id: task.track.id, lang: task.track.lang,
    name: task.track.name, forced: !!task.track.forced, sdh: !!task.track.sdh, default: !!task.track.default, format: task.track.format, url: baseUrl + task.name, prepare: true }));
  function covers(revision, position) {
    return revision && position >= revision.rangeStart && (revision.complete || position < revision.rangeEnd);
  }
  function retire(worker) {
    if (worker.source) { const source = worker.source; worker.source = null; source.dispose(); }
    clearTimeout(worker.budget); clearTimeout(worker.grace); clearInterval(worker.sample);
  }
  function stop(task) {
    const worker = task.worker;
    if (!worker) return;
    task.worker = null; retire(worker);
    try { worker.child.kill('SIGKILL'); } catch (error) { log('receiver subtitle cancellation: ' + error.message); }
  }
  function publish(task, worker, complete, closed = false) {
    let raw;
    try { raw = fs.readFileSync(worker.file, 'utf8'); }
    catch (error) { if (error.code !== 'ENOENT') log('receiver subtitle read: ' + error.message); return; }
    // During a write, only blank-line-terminated blocks are safe to publish.
    if (!complete && !closed) {
      const boundary = raw.lastIndexOf('\n\n');
      raw = boundary < 0 ? '' : raw.slice(0, boundary + 2);
    }
    const safe = trimToCompleteCues(raw);
    if (!safe && !complete) return;
    const body = safe || 'WEBVTT\n\n';
    if (!complete && body === worker.lastBody) return;
    worker.lastBody = body;
    const revision = ++serial, name = 'receiver_sub_' + revision + '.vtt';
    const file = path.join(dir, name), temporary = file + '.tmp';
    try { fs.writeFileSync(temporary, body); fs.renameSync(temporary, file); }
    catch (error) { log('receiver subtitle publish: ' + error.message); return; }
    const cueEnd = coverageEnd(body);
    task.revision = { revision, url: baseUrl + name, complete, eof: complete, rangeStart: worker.start,
      rangeEnd: complete ? (duration || cueEnd) : cueEnd, cueEnd, coverageEstimated: !complete };
    task.revisions.push({ file, at: Date.now() });
    // Retain the current and preceding revisions while a television completes a node swap.
    while (task.revisions.length > 4) {
      const old = task.revisions.shift();
      try { fs.unlinkSync(old.file); } catch (error) { if (error.code !== 'ENOENT') log('receiver subtitle revision cleanup: ' + error.message); }
    }
    log('receiver subtitle revision=' + revision + ', complete=' + complete + ', cueEnd=' + cueEnd);
  }
  function launch(task, position) {
    const start = task.track.path ? 0 : Math.max(0, Math.floor(position - 15));
    const file = path.join(dir, 'receiver_work_' + (++serial) + '.vtt');
    let source = null;
    if (!task.track.path && acquireInput) {
      source = acquireInput(input);
      if (!source) { task.failedAt = Date.now(); log('receiver subtitle source ownership unavailable'); return; }
    }
    const args = ['-loglevel', 'error', '-xerror', '-y', '-rw_timeout', '5000000',
      ...(task.track.path ? ['-sub_charenc', sniffCharenc(task.track.path), '-i', task.track.path] : [...(start > 0 ? ['-ss', String(start), '-copyts'] : []), '-i', source ? source.url : input, '-map', '0:s:' + task.track.idx]),
      '-c:s', 'webvtt', '-flush_packets', '1', '-f', 'webvtt', file];
    let child;
    try { child = spawnProcess(ffmpeg, args); }
    catch (error) { if (source) source.dispose(); task.failedAt = Date.now(); log('receiver subtitle spawn: ' + error.message); return; }
    const worker = { child, source, file, start, lastBody: null, timedOut: false, sawError: false, diagnostics: createDiagnostics([input, task.track.path, dir]) };
    task.worker = worker; activeWorkers.add(worker);
    if (source) source.setActive(true);
    child.stderr.on('data', chunk => { if (String(chunk).trim()) worker.sawError = true; worker.diagnostics.capture(chunk); });
    worker.sample = setInterval(() => { if (!disposed && task.worker === worker) publish(task, worker, false); }, sampleMs);
    worker.budget = setTimeout(() => {
      worker.timedOut = true;
      try { child.kill('SIGTERM'); } catch (error) { log('receiver subtitle deadline: ' + error.message); }
      worker.grace = setTimeout(() => { try { child.kill('SIGKILL'); } catch (error) { log('receiver subtitle kill: ' + error.message); } }, 1000);
    }, budgetMs);
    child.once('error', error => { task.failedAt = Date.now(); log('receiver subtitle process: ' + error.message); });
    child.once('close', (code, signal) => {
      retire(worker); activeWorkers.delete(worker);
      const owned = !disposed && task.worker === worker;
      const cleanEof = code === 0 && !signal && !worker.timedOut && !worker.sawError;
      if (owned) publish(task, worker, cleanEof, true);
      try { fs.unlinkSync(file); } catch (error) { if (error.code !== 'ENOENT') log('receiver subtitle work cleanup: ' + error.message); }
      if (!owned) return;
      task.worker = null; task.failedAt = cleanEof ? 0 : Date.now(); task.failedPosition = position;
      const summary = worker.diagnostics.summarize({ code, signal, timedOut: worker.timedOut, bytes: worker.lastBody ? Buffer.byteLength(worker.lastBody) : 0 });
      log('receiver subtitle exit=' + code + ', signal=' + (signal || 'none') + ', reason=' + summary.category + (summary.stderr ? ', stderr=' + summary.stderr : ''));
    });
  }
  function prepare(name, owner, position) {
    const task = tasks.get(name);
    if (disposed || !task) return null;
    if (!/^[a-z0-9_-]{1,160}$/i.test(owner) || !Number.isFinite(position) || position < 0) return { status: 'failed', retryAfterMs: 5000 };
    // Bound client owner bookkeeping; old disconnected selection generations cannot accumulate.
    for (const [key, value] of task.owners) if (Date.now() - value.at > 60000) task.owners.delete(key);
    if (!task.owners.has(owner) && task.owners.size >= 8) return { status: 'failed', retryAfterMs: 5000 };
    task.owners.set(owner, { at: Date.now(), position });
    const ready = covers(task.revision, position);
    if (!ready && !task.worker && (Date.now() - task.failedAt >= retryMs || Number.isFinite(task.failedPosition) && Math.abs(position - task.failedPosition) > 15)) {
      if (activeWorkers.size < 2) launch(task, position);
    }
    return { ...(task.revision || {}), status: covers(task.revision, position) ? 'ready' : task.worker ? 'pending' : 'failed', retryAfterMs: task.worker ? 1000 : 5000 };
  }
  function cancel(name, owner) {
    const task = tasks.get(name);
    if (!task) return false;
    task.owners.delete(owner);
    if (!task.owners.size) stop(task);
    return true;
  }
  function destroy() { disposed = true; for (const task of tasks.values()) stop(task); }
  return { entries, prepare, cancel, destroy, has: name => tasks.has(name) };
}
module.exports = { createReceiverSubtitles };
