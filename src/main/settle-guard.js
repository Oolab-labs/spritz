'use strict';

// "Is a re-cast in flight, or did one just finish?" While a cast is being rebuilt the receiver reports
// whatever it happens to hold: an empty track list during the new LOAD, then the previous selection a
// moment after setTrack. Reading either as the viewer's choice from the TV remote bounces the subtitle
// pick back and forth and re-casts again, each time rewinding to where the last stream began.
//
// begin() when a re-cast starts; end(settleMs) when it finishes or fails, which keeps the guard shut for
// a short settling period so the receiver's trailing reports are ignored too.
function createSettleGuard(now = Date.now) {
  let open = 0, until = 0;
  return {
    begin() { open++; },
    end(settleMs) {
      open = Math.max(0, open - 1);
      until = Math.max(until, now() + (Number(settleMs) > 0 ? Number(settleMs) : 0));
    },
    active() { return open > 0 || now() < until; }
  };
}

// What the receiver has selected, learned while it was quiet. A receiver may report a selection nobody
// asked for (an LG activates the first text track on its own); that is the starting state, not a choice.
// observe() returns true only when the selection DIFFERS from the last quiet one, i.e. the viewer
// changed it on the TV. While the guard is shut it forgets the baseline, so the first quiet report
// after a (re)load becomes the new starting state.
function createSelectionBaseline() {
  let baseline = null;
  return {
    observe(ids, guardActive) {
      if (!Array.isArray(ids)) return false;
      if (guardActive) { baseline = null; return false; }
      const key = ids.slice().sort((a, b) => a - b).join(',');
      if (baseline === null) { baseline = key; return false; }
      if (key === baseline) return false;
      baseline = key;
      return true;
    },
    reset() { baseline = null; }
  };
}

module.exports = { createSettleGuard, createSelectionBaseline };
