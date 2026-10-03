(function (root) {
  'use strict';
  function open(kind, tracks) {
    var items = kind === 'subtitle' ? [{ id: 'off', title: 'Off', selected: !tracks.some(function (t) { return t.selected; }) }].concat(tracks) : tracks.slice();
    var selected = items.findIndex(function (t) { return t.selected; });
    return { kind: kind, items: items, index: Math.max(0, selected) };
  }
  function move(menu, delta) {
    menu.index = Math.max(0, Math.min(menu.items.length - 1, menu.index + delta));
    return menu.items[menu.index] || null;
  }
  function choice(menu) { return menu.items[menu.index] || null; }
  function refresh(menu, tracks) {
    var item = choice(menu), next = open(menu.kind, tracks);
    var index = item ? next.items.findIndex(function (t) { return t.id === item.id; }) : -1;
    if (index !== -1) next.index = index;
    return next;
  }
  function label(item) {
    if (item.id === 'off') return 'Off';
    var language = item.lang && item.lang !== 'und' ? item.lang : '';
    try { if (language && typeof Intl !== 'undefined' && Intl.DisplayNames) language = new Intl.DisplayNames(['en'], { type: 'language' }).of(language); } catch (e) {}
    return language || item.title || 'Track';
  }
  function detail(item) {
    if (item.id === 'off') return 'No subtitles';
    var parts = [], title = item.title || '';
    if (title && title.toLowerCase() !== label(item).toLowerCase()) parts.push(title);
    if (item.selected) parts.push(item.readyState === 1 ? 'Preparing…' : item.readyState === 3 ? 'Unavailable · select to retry' : '');
    // Unselected rows need no repeated instruction; OK already selects the focused row.
    return parts.filter(function (part) { return !!part; }).join(' · ');
  }
  var api = { open: open, move: move, choice: choice, refresh: refresh, label: label, detail: detail };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SpritzTrackMenu = api;
})(typeof window !== 'undefined' ? window : this);
