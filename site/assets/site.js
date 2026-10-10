'use strict';

// Download button. Every release so far is a pre-release, so /releases/latest would 404. Ask the
// API for the newest non-draft release that carries a .dmg and link straight to it; on any failure
// (offline, rate-limited) the button keeps its plain link to the Releases page.
(async () => {
  try {
    const res = await fetch('https://api.github.com/repos/Oolab-labs/spritz/releases?per_page=10');
    if (!res.ok) return;
    for (const rel of await res.json()) {
      if (rel.draft) continue;
      const dmg = rel.assets.find((a) => a.name.endsWith('.dmg'));
      if (!dmg) continue;
      document.getElementById('dl').href = dmg.browser_download_url;
      document.getElementById('dl-size').textContent = Math.round(dmg.size / 1048576) + ' MB';
      document.getElementById('version').textContent =
        rel.tag_name.replace(/^v/, '') + (rel.prerelease ? ' (pre-release)' : '');
      return;
    }
  } catch (_) { /* keep the fallback link */ }
})();

// Copy buttons. If the clipboard is refused, select the text so it can be copied by hand.
document.querySelectorAll('[data-copy]').forEach((btn) => {
  const label = btn.textContent;
  let reset = null;
  const flash = () => {
    btn.textContent = 'Copied';
    clearTimeout(reset);
    reset = setTimeout(() => { btn.textContent = label; }, 1600);
  };
  btn.addEventListener('click', () => {
    const el = document.getElementById(btn.dataset.copy);
    navigator.clipboard.writeText(el.textContent).then(flash, () => getSelection().selectAllChildren(el));
  });
});
