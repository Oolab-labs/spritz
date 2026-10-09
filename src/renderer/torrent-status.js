(function (root) {
  'use strict';
  function model(p, state) {
    const progress = p.fileProgress != null ? p.fileProgress : p.progress;
    if (progress >= 1) return { complete: true };
    const health = p.health || {}, parts = [];
    let dot = 'good';
    if (!(p.peers > 0)) { parts.push('Waiting for peers'); dot = 'poor'; }
    else parts.push(state.prettyBytes(p.speed || 0) + '/s · ' + p.peers + (p.peers === 1 ? ' peer' : ' peers'));
    if (!state.loaded && Number.isFinite(p.buffering)) parts.unshift('Buffering ' + Math.round(Math.min(1, Math.max(0, p.buffering)) * 100) + '%');
    if (state.loaded && Number.isFinite(progress)) parts.push(Math.floor(Math.min(1, Math.max(0, progress)) * 100) + '%');
    if (health.known && Number.isFinite(health.secondsBuffered)) {
      parts.push('~' + Math.max(0, Math.round(health.secondsBuffered)) + 's buffered');
      dot = health.risk === 'high' ? 'poor' : health.risk === 'low' ? 'excellent' : 'good';
      if (health.risk === 'high' && Number.isFinite(health.secondsToEmpty)) parts.push(state.paused
        ? 'download below playback rate' : 'may stall in ~' + Math.max(0, Math.round(health.secondsToEmpty)) + 's at this rate');
    }
    return { complete: false, text: parts.join(' · '), dot };
  }
  const api = { model };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SpritzTorrentStatus = api;
})(typeof window !== 'undefined' ? window : this);
