'use strict';
// A load-specific HLS hint. It changes no cached media and is propagated only to
// child playlists; segment URLs and unrelated receivers remain unchanged.
function loadUrl(url, seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return url;
  try {
    const u = new URL(url);
    if (!/^\/hls\/[^/]+\/.*\.m3u8$/.test(u.pathname)) return url;
    u.searchParams.set('spritzStart', String(seconds));
    return u.toString();
  } catch (e) { return url; }
}
function playlist(text, seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return text;
  const hint = '#EXT-X-START:TIME-OFFSET=' + seconds + ',PRECISE=YES';
  return text.replace(/^#EXT-X-START:.*\r?\n/gm, '')
    .replace(/^#EXTM3U\r?\n/, '#EXTM3U\n' + hint + '\n')
    .replace(/URI="([^"]+\.m3u8(?:\?[^"]*)?)"/g, (all, uri) => {
      const u = new URL(uri, 'http://playlist.local/');
      u.searchParams.set('spritzStart', String(seconds));
      return 'URI="' + uri.split('?')[0] + '?' + u.searchParams.toString() + '"';
    })
    .replace(/(^[^#\r\n]+\.m3u8)([^\r\n]*)$/gm, (all, path, query) => {
      const u = new URL(path + query, 'http://playlist.local/');
      u.searchParams.set('spritzStart', String(seconds));
      return path + '?' + u.searchParams.toString();
    });
}
// EVENT playlists start at zero here. Do not announce a replacement while its
// requested start lies beyond the published segments (HLS clamps that to the edge).
function coversPosition(text, seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return false;
  let end = 0;
  for (const match of text.matchAll(/^#EXTINF:([\d.]+)/gm)) end += Number(match[1]) || 0;
  if (/^#EXT-X-ENDLIST/m.test(text)) return end > 0 && seconds <= end;
  const target = /^#EXT-X-TARGETDURATION:(\d+)\s*$/m.exec(text);
  // RFC 8216 4.3.5.2: an unfinished playlist needs three target durations
  // beyond EXT-X-START. Two seconds can still put the request outside LG's window.
  return !!target && Number(target[1]) > 0 && end >= seconds + 3 * Number(target[1]);
}
module.exports = { loadUrl, playlist, coversPosition };
