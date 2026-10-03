'use strict';

const crypto = require('crypto');
const MAX_RECEIVER_SUBTITLES = 128;

// Receiver sidecars are lazy: retain distinct text variants instead of applying
// AirPlay's eager-rendition language cap. Embedded IDs use the source subtitle
// ordinal, never the index after filtering bitmap tracks or languages.
function buildReceiverSubtitleCatalog(subs) {
  if (!Array.isArray(subs)) throw new TypeError('Subtitle catalog must be an array');
  const text = subs.filter(s => s && !s.bitmap);
  if (text.length > MAX_RECEIVER_SUBTITLES) throw new RangeError('Receiver supports at most 128 text subtitle tracks');
  const ids = new Set(), names = new Set();
  return text.map(s => {
    const external = typeof s.path === 'string' && s.path.length > 0;
    if (!external && (!Number.isInteger(s.idx) || s.idx < 0 || s.idx >= MAX_RECEIVER_SUBTITLES)) {
      throw new RangeError('Receiver subtitle source ordinal must be between 0 and 127');
    }
    const id = external ? 'external-subtitle-' + crypto.createHash('sha256').update(s.path).digest('hex').slice(0, 12) : 'source-subtitle-' + s.idx;
    if (ids.has(id)) throw new RangeError('Duplicate receiver subtitle source identity');
    ids.add(id);
    const disposition = s.disposition || {};
    const forced = s.forced === true || s.forced === 1 || disposition.forced === 1;
    const sdh = s.sdh === true || s.sdh === 1 || disposition.hearing_impaired === 1 || /\bSDH\b|hearing.impaired/i.test(s.name || '');
    const isDefault = s.default === true || s.default === 1 || disposition.default === 1;
    const format = String(s.format || s.codec || s.codec_name || '').slice(0, 64);
    const lang = String(s.lang || 'und').slice(0, 64);
    let base = String(s.name || s.title || (lang === 'und' ? 'Subtitle' : lang.toUpperCase())).slice(0, 90);
    const tags = [forced ? 'Forced' : '', sdh ? 'SDH' : '', isDefault ? 'Default' : ''].filter(Boolean);
    if (tags.length) base += ' (' + tags.join(', ') + ')';
    base = base.slice(0, 118);
    let name = base, n = 2;
    while (names.has(name.toLowerCase())) name = base + ' · ' + n++;
    names.add(name.toLowerCase());
    return { ...s, id, lang, name, forced, sdh, default: isDefault, ...(format ? { format } : {}) };
  });
}

module.exports = { buildReceiverSubtitleCatalog, MAX_RECEIVER_SUBTITLES };
