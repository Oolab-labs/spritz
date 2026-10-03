'use strict';

// Presentation snapshots only: service/adoption clocks remain epoch-local.
function presentTargets(list, toLogical, sourceDuration) {
  return (list || []).map(target => {
    const p = target.playback;
    if (!p || !p.epoch) return target;
    let logical = null;
    let duration = null;
    if (typeof sourceDuration === 'function') {
      try { duration = sourceDuration(p.epoch); } catch (e) {}
    }
    if (Number.isFinite(p.currentTime) && p.currentTime >= 0 && typeof toLogical === 'function') {
      try { logical = toLogical(p.epoch, p.currentTime); } catch (e) {}
    }
    return { ...target, playback: { ...p,
      currentTime: Number.isFinite(logical) && logical >= 0 ? logical : null,
      epochLocal: p.currentTime, epochDurationSec: p.durationSec,
      durationSec: Number.isFinite(duration) && duration > 0 ? duration : null
    } };
  });
}
module.exports = { presentTargets };
