'use strict';

// Presentation snapshots only: the renderer is given film (logical) time, and the epoch-local clock
// stays in the service, where adoption needs it. The input list is never mutated.
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
      durationSec: Number.isFinite(duration) && duration > 0 ? duration : null
    } };
  });
}
module.exports = { presentTargets };
