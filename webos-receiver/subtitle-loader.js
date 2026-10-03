(function (root) {
  'use strict';
  function create(options) {
    var selected = null, generation = 0, timer = null, abort = null, pending = false;
    var attempts = 0, lastPosition = 0, started = 0, nextCheck = 0;
    var schedule = options.schedule || setTimeout, clear = options.clear || clearTimeout;
    var now = options.now || Date.now;
    function later(fn, delay) { timer = schedule(function () { timer = null; fn(); }, delay); }
    function valid(g, binding) { return generation === g && selected === binding; }
    function cancelRequest() {
      clear(timer); timer = null;
      if (abort) abort(); abort = null;
      if (selected && selected.owner) { options.cancel(selected, selected.owner); selected.owner = null; }
      pending = false;
    }
    function covers(binding, position, near) {
      var range = binding.coverage;
      if (!range || position < range.rangeStart) return false;
      return range.complete || position < range.rangeEnd - (near ? 8 : 0);
    }
    function state(binding, value) { binding.loadState = value; options.state(binding, value); }
    function fail(g, binding) {
      if (!valid(g, binding)) return;
      pending = false; abort = null; attempts++;
      state(binding, attempts <= 3 ? 'retrying' : 'unavailable');
      if (attempts <= 3) later(function () { begin(binding, options.position(), false); }, [2000, 5000, 10000][attempts - 1]);
      else nextCheck = now() + 30000;
    }
    function poll(g, binding, position) {
      if (!valid(g, binding)) return;
      abort = options.prepare(binding, position, binding.owner, function (error, result) {
        if (!valid(g, binding)) return;
        abort = null;
        if (error || !result || result.status === 'failed') return fail(g, binding);
        if (result.status === 'pending') {
          if (now() - started > 60000) return fail(g, binding);
          later(function () { poll(g, binding, position); }, Math.max(1000, Math.min(2000, Number(result.retryAfterMs) || 1500)));
          return;
        }
        if (result.status !== 'ready' || typeof result.url !== 'string') return fail(g, binding);
        if (binding.revision === result.revision && binding.node) {
          pending = false; binding.coverage = result; attempts = 0; nextCheck = now() + 30000; options.commit(binding); state(binding, 'ready'); return;
        }
        abort = options.load(binding, result.url, function (loadError, node) {
          if (!valid(g, binding)) { if (node) options.remove(node); return; }
          abort = null;
          if (loadError || !node) return fail(g, binding);
          var old = binding.node;
          if (old && options.preserve) options.preserve(old, node);
          binding.node = node; binding.revision = result.revision; binding.coverage = result;
          pending = false; attempts = 0; nextCheck = now() + 5000;
          options.commit(binding); if (old && old !== node) options.remove(old);
          state(binding, 'ready');
        });
      });
    }
    function begin(binding, position, reset) {
      cancelRequest(); generation++; lastPosition = position;
      if (reset) attempts = 0;
      pending = true; started = now();
      binding.owner = 'sub-' + generation + '-' + now() + '-' + Math.random().toString(36).slice(2, 9);
      state(binding, binding.node ? 'renewing' : 'loading');
      poll(generation, binding, position);
    }
    return {
      select: function (binding, position) {
        if (selected === binding && binding && (pending || binding.node && binding.loadState === 'ready' && covers(binding, position, false))) return;
        cancelRequest(); generation++; selected = binding;
        attempts = 0; nextCheck = 0; lastPosition = position;
        if (!binding) return;
        if (binding.node && binding.loadState === 'ready' && covers(binding, position, false)) { options.commit(binding); return; }
        begin(binding, position, true);
      },
      tick: function (position, seek) {
        if (!selected) return;
        if (seek && Math.abs(position - lastPosition) > 8 && !covers(selected, position, false)) {
          cancelRequest(); generation++; attempts = 0;
          later(function () { begin(selected, options.position(), true); }, 300); lastPosition = position; return;
        }
        if (pending || timer || now() < nextCheck || covers(selected, position, true)) return;
        if (attempts > 3) return;
        var target = selected.coverage && !selected.coverage.complete && position >= selected.coverage.rangeStart && position < selected.coverage.rangeEnd ? selected.coverage.rangeEnd + 1 : position;
        begin(selected, target, false);
      },
      stop: function () { cancelRequest(); generation++; selected = null; },
      covers: covers
    };
  }
  var api = { create: create };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SpritzSubtitleLoader = api;
})(typeof window !== 'undefined' ? window : this);
