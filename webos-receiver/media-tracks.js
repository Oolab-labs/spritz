(function (root) {
  'use strict';
  function snapshot(video) {
    function list(tracks, kind) {
      var out = [];
      for (var i = 0; tracks && i < tracks.length && i < (kind === 'audio' ? 32 : 128); i++) {
        var t = tracks[i];
        if (kind === 'subtitle' && t.kind && t.kind !== 'subtitles' && t.kind !== 'captions') continue;
        out.push({ id: String(i), lang: String(t.language || '').slice(0, 64), title: String(t.label || '').slice(0, 128),
          selected: kind === 'audio' ? !!t.enabled : t.mode === 'showing' });
      }
      return out;
    }
    return { audio: list(video.audioTracks, 'audio'), subtitles: list(video.textTracks, 'subtitle') };
  }
  function select(video, kind, id) {
    var available = snapshot(video), items = kind === 'audio' ? available.audio : available.subtitles;
    if (kind !== 'audio' && kind !== 'subtitle') return false;
    id = String(id);
    if (!(kind === 'subtitle' && id === 'off') && !items.some(function (t) { return t.id === id; })) return false;
    var tracks = kind === 'audio' ? video.audioTracks : video.textTracks;
    for (var i = 0; tracks && i < tracks.length; i++) {
      if (kind === 'audio') tracks[i].enabled = String(i) === id;
      else if (!tracks[i].kind || tracks[i].kind === 'subtitles' || tracks[i].kind === 'captions') {
        var mode = String(i) === id ? 'showing' : 'disabled';
        if (tracks[i].mode !== mode) tracks[i].mode = mode;
      }
    }
    return true;
  }
  function boundSubtitles(bindings) {
    return bindings.map(function (binding) {
      var track = binding.node && binding.node.track;
      return { id: binding.id, title: binding.title, lang: binding.lang,
        selected: binding.selected === undefined ? !!track && track.mode === 'showing' : !!binding.selected, readyState: binding.loadState === 'loading' || binding.loadState === 'retrying' ? 1 : binding.loadState === 'unavailable' ? 3 : Number(binding.node && binding.node.readyState) || 0,
        cueCount: track && track.cues ? track.cues.length : 0 };
    });
  }
  function selectBoundSubtitle(video, bindings, id) {
    var binding = bindings.find(function (entry) { return entry.id === id; });
    if (id !== 'off' && !binding) return false;
    bindings.forEach(function (entry) { entry.selected = entry.id === id; });
    var wanted = binding && binding.node && binding.node.track;
    for (var i = 0; video.textTracks && i < video.textTracks.length; i++) {
      var track = video.textTracks[i];
      if (track.kind && track.kind !== 'subtitles' && track.kind !== 'captions') continue;
      if (bindings.some(function (entry) { return entry.selected && entry.loadingNode && entry.loadingNode.track === track; })) {
        if (track.mode !== 'hidden') track.mode = 'hidden';
        continue;
      }
      var mode = track === wanted ? 'showing' : 'disabled';
      if (track.mode !== mode) track.mode = mode;
    }
    if (wanted && wanted.mode !== 'showing') wanted.mode = 'showing';
    return true;
  }
  // A seeked extraction can start after a long currently-visible cue's packet.
  // Carry only still-active old cues into the replacement before its atomic swap.
  function carryActiveCues(video, oldNode, newNode, Cue) {
    var oldTrack = oldNode && oldNode.track, next = newNode && newNode.track;
    var at = Number(video.currentTime);
    if (!oldTrack || !next || typeof Cue !== 'function' || !isFinite(at)) return 0;
    var cues = oldTrack.activeCues || [], count = 0;
    for (var i = 0; i < cues.length; i++) {
      var cue = cues[i];
      if (!(cue.startTime <= at && cue.endTime > at)) continue;
      var duplicate = false;
      for (var j = 0; next.cues && j < next.cues.length; j++) {
        var existing = next.cues[j];
        if (existing.startTime === cue.startTime && existing.endTime === cue.endTime && existing.text === cue.text) { duplicate = true; break; }
      }
      if (duplicate) continue;
      var copy = new Cue(cue.startTime, cue.endTime, cue.text);
      ['id', 'vertical', 'snapToLines', 'line', 'lineAlign', 'position', 'positionAlign', 'size', 'align', 'pauseOnExit'].forEach(function (key) {
        if (cue[key] !== undefined) { try { copy[key] = cue[key]; } catch (e) {} }
      });
      next.addCue(copy); count++;
    }
    return count;
  }
  function remoteChoice(choice, key, select) {
    if (key === 13) { select(choice.value); choice.blur(); return true; }
    if ([461, 27].indexOf(key) !== -1) { choice.blur(); return true; }
    var delta = key === 38 ? -1 : key === 40 ? 1 : 0;
    if (delta) {
      choice.selectedIndex = Math.max(0, Math.min(choice.options.length - 1, choice.selectedIndex + delta));
      return true;
    }
    return false;
  }
  var api = { snapshot: snapshot, select: select, boundSubtitles: boundSubtitles, selectBoundSubtitle: selectBoundSubtitle, carryActiveCues: carryActiveCues, remoteChoice: remoteChoice };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SpritzMediaTracks = api;
})(typeof window !== 'undefined' ? window : this);
