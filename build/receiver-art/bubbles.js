(function (root) {
  'use strict';
  /* Spritz's mark: three soap bubbles, as on the app's home screen. The home screen uses the emoji
   * glyph; this draws the same look procedurally (it does not embed Apple's artwork). One bubble is
   * drawn from layers — tinted glass, a lit window near the top, a soft crescent reflection hugging the
   * bottom, a specular glint, and a broad iridescent rim (a colour wheel masked to a ring) — and placed
   * three times in the emoji's layout (large, small, medium). Browser-only: it needs a canvas.
   *
   * Polish (2026-10): the glass and field used to be near-black (median luma ~11), so the bubbles read
   * as dark holes; a flat-topped reflection drew a hard horizontal band; and small icons were the
   * 1024px drawing downsampled into mush. Small sizes now get a simplified drawing of their own. */
  var TAU = Math.PI * 2;
  var RIM = [[0.00, 'rgba(127,211,255,0.95)'], [0.07, 'rgba(140,196,245,0.95)'], [0.14, 'rgba(160,184,245,1.00)'],
    [0.18, 'rgba(255,143,184,1.00)'], [0.23, 'rgba(255,170,200,1.00)'], [0.28, 'rgba(169,220,255,1.00)'],
    [0.36, 'rgba(184,224,255,1.00)'], [0.44, 'rgba(168,212,255,1.00)'], [0.50, 'rgba(190,186,255,0.95)'],
    [0.545, 'rgba(230,160,236,1.00)'], [0.585, 'rgba(255,140,196,1.00)'], [0.625, 'rgba(255,170,214,1.00)'],
    [0.68, 'rgba(246,222,246,1.00)'], [0.76, 'rgba(236,240,255,1.00)'], [0.86, 'rgba(190,232,255,0.97)'],
    [0.94, 'rgba(140,215,255,0.93)'], [1.00, 'rgba(127,211,255,0.95)']];

  function layer(size) { var c = document.createElement('canvas'); c.width = c.height = size; return c; }
  function rimGradient(c) { var g = c.createConicGradient(0, 0, 0); RIM.forEach(function (s) { g.addColorStop(s[0], s[1]); }); return g; }

  function glint(c, R, alpha) {
    c.save(); c.translate(-0.40 * R, -0.50 * R); c.rotate(-0.62);
    var g = c.createRadialGradient(0, 0, 0, 0, 0, 0.2 * R);
    g.addColorStop(0, 'rgba(255,255,255,' + alpha + ')'); g.addColorStop(0.55, 'rgba(255,255,255,' + alpha * 0.55 + ')'); g.addColorStop(1, 'rgba(255,255,255,0)');
    c.scale(1, 0.5); c.fillStyle = g; c.beginPath(); c.arc(0, 0, 0.2 * R, 0, TAU); c.fill();
    c.restore();
  }

  function bubble(ctx, cx, cy, R) {
    var S = Math.ceil(R * 2.5), o = S / 2, L = layer(S), c = L.getContext('2d'), g;
    c.translate(o, o);

    c.save();
    c.beginPath(); c.arc(0, 0, R, 0, TAU); c.clip();
    // tinted glass: dark at the heart, cooler and lighter toward the edge
    g = c.createRadialGradient(0, 0, 0, 0, 0, R);
    g.addColorStop(0, '#0e1118'); g.addColorStop(0.62, '#141a25'); g.addColorStop(1, '#2a3846');
    c.fillStyle = g; c.fillRect(-R, -R, 2 * R, 2 * R);
    // a faint warm tint on the left, as in the emoji
    g = c.createRadialGradient(-0.62 * R, 0.1 * R, 0, -0.62 * R, 0.1 * R, 0.75 * R);
    g.addColorStop(0, 'rgba(196,128,124,0.14)'); g.addColorStop(1, 'rgba(196,128,124,0)');
    c.fillStyle = g; c.fillRect(-R, -R, 2 * R, 2 * R);
    // the lit window inside the top
    c.filter = 'blur(' + (R * 0.06) + 'px)';
    c.save(); c.translate(0.1 * R, -0.42 * R); c.scale(1, 0.66);
    g = c.createRadialGradient(0, 0, 0, 0, 0, 0.58 * R);
    g.addColorStop(0, 'rgba(232,228,240,0.30)'); g.addColorStop(0.7, 'rgba(232,228,240,0.14)'); g.addColorStop(1, 'rgba(232,228,240,0)');
    c.fillStyle = g; c.beginPath(); c.arc(0, 0, 0.58 * R, 0, TAU); c.fill();
    c.restore();
    // a soft crescent reflection hugging the bottom (replaces a flat-topped band that read as a seam)
    c.filter = 'blur(' + (R * 0.07) + 'px)';
    c.save(); c.translate(0, 0.66 * R); c.scale(1, 0.5);
    g = c.createRadialGradient(0, 0.25 * R, 0.1 * R, 0, 0.25 * R, 0.95 * R);
    g.addColorStop(0, 'rgba(190,228,252,0.62)'); g.addColorStop(0.6, 'rgba(160,206,236,0.34)'); g.addColorStop(1, 'rgba(150,200,230,0)');
    c.fillStyle = g; c.beginPath(); c.arc(0, 0.25 * R, 0.95 * R, 0, TAU); c.fill();
    c.restore();
    c.filter = 'blur(' + (R * 0.012) + 'px)';
    glint(c, R, 0.92);
    c.filter = 'none';
    c.restore();

    // the iridescent rim: a colour wheel, masked to a soft ring
    var ring = layer(S), r = ring.getContext('2d');
    r.translate(o, o);
    r.fillStyle = rimGradient(r); r.beginPath(); r.arc(0, 0, R * 1.02, 0, TAU); r.fill();
    r.globalCompositeOperation = 'destination-in';
    g = r.createRadialGradient(0, 0, 0, 0, 0, R * 1.02);
    g.addColorStop(0.74, 'rgba(0,0,0,0)'); g.addColorStop(0.88, 'rgba(0,0,0,0.5)');
    g.addColorStop(0.95, 'rgba(0,0,0,1)'); g.addColorStop(0.99, 'rgba(0,0,0,0.9)'); g.addColorStop(1, 'rgba(0,0,0,0)');
    r.fillStyle = g; r.fillRect(-S, -S, 2 * S, 2 * S);
    c.filter = 'blur(' + (R * 0.016) + 'px)';
    c.drawImage(ring, -o, -o);
    c.filter = 'none';
    c.strokeStyle = 'rgba(214,232,248,0.45)'; c.lineWidth = Math.max(1, R * 0.012);
    c.beginPath(); c.arc(0, 0, R * 0.995, 0, TAU); c.stroke();

    ctx.drawImage(L, cx - o, cy - o);
  }

  /* Hard-edged bubble for surfaces viewed from a distance (a TV launcher): the same glass, crescent and
   * glint as the detailed bubble, but with no blurs and a crisp iridescent rim, so the launcher's
   * scaling does not turn soft glows into a smudge. */
  function crispBubble(ctx, cx, cy, R) {
    ctx.save(); ctx.translate(cx, cy);
    var g = ctx.createRadialGradient(0, 0, 0, 0, 0, R);
    g.addColorStop(0, '#0f131b'); g.addColorStop(0.62, '#151c28'); g.addColorStop(1, '#2c3b4b');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, R, 0, TAU); ctx.fill();
    ctx.save(); ctx.beginPath(); ctx.arc(0, 0, R, 0, TAU); ctx.clip();
    g = ctx.createRadialGradient(0.1 * R, -0.42 * R, 0, 0.1 * R, -0.42 * R, 0.5 * R);
    g.addColorStop(0, 'rgba(232,228,240,0.22)'); g.addColorStop(1, 'rgba(232,228,240,0)');
    ctx.fillStyle = g; ctx.fillRect(-R, -R, 2 * R, 2 * R);
    g = ctx.createLinearGradient(0, 0.45 * R, 0, R);
    g.addColorStop(0, 'rgba(176,220,248,0)'); g.addColorStop(1, 'rgba(176,220,248,0.5)');
    ctx.fillStyle = g; ctx.beginPath(); ctx.ellipse(0, 0.86 * R, 0.84 * R, 0.42 * R, 0, 0, TAU); ctx.fill();
    glint(ctx, R, 1);
    ctx.restore();
    var w = Math.max(1.2, R * 0.085);
    ctx.strokeStyle = rimGradient(ctx); ctx.lineWidth = w;
    ctx.beginPath(); ctx.arc(0, 0, R - w / 2, 0, TAU); ctx.stroke();
    ctx.strokeStyle = 'rgba(232,242,255,0.55)'; ctx.lineWidth = Math.max(0.6, R * 0.014);
    ctx.beginPath(); ctx.arc(0, 0, R - w * 0.15, 0, TAU); ctx.stroke();
    ctx.restore();
  }

  /* Few-pixel bubble: flat glass, a thick rim and a glint. Blurs and faint layers vanish at this size. */
  function smallBubble(ctx, cx, cy, R) {
    ctx.save(); ctx.translate(cx, cy);
    var g = ctx.createRadialGradient(0, 0, 0, 0, 0, R);
    g.addColorStop(0, '#121722'); g.addColorStop(1, '#2c3a4a');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, R, 0, TAU); ctx.fill();
    ctx.save(); ctx.beginPath(); ctx.arc(0, 0, R, 0, TAU); ctx.clip();
    ctx.fillStyle = 'rgba(176,220,248,0.42)'; ctx.beginPath(); ctx.ellipse(0, 0.8 * R, 0.8 * R, 0.4 * R, 0, 0, TAU); ctx.fill();
    glint(ctx, R, 1);
    ctx.restore();
    var w = Math.max(1.1, R * 0.17);
    ctx.strokeStyle = rimGradient(ctx); ctx.lineWidth = w;
    ctx.beginPath(); ctx.arc(0, 0, R - w / 2, 0, TAU); ctx.stroke();
    ctx.restore();
  }

  /* The field behind the bubbles: lifted off black, lit from above, with a cool glow behind the
   * large bubble so the glass has something to sit in front of. */
  function field(ctx, size, ox, oy) {
    var g = ctx.createLinearGradient(0, oy, 0, oy + size);
    g.addColorStop(0, '#20232c'); g.addColorStop(1, '#0c0d11');
    ctx.fillStyle = g; ctx.fillRect(ox, oy, size, size);
    g = ctx.createRadialGradient(ox + size * 0.35, oy + size * 0.4, 0, ox + size * 0.35, oy + size * 0.4, size * 0.6);
    g.addColorStop(0, 'rgba(110,150,255,0.13)'); g.addColorStop(1, 'rgba(110,150,255,0)');
    ctx.fillStyle = g; ctx.fillRect(ox, oy, size, size);
  }

  /* The mark on a square `size` canvas region at (ox, oy). Below ~72px the detailed bubble turns to
   * mush, so a simplified drawing takes over; at 24px and under the smallest bubble (under 2px) is
   * dropped and the other two grow to fill the tile. */
  function mark(ctx, size, ox, oy, opts) {
    ox = ox || 0; oy = oy || 0; opts = opts || {};
    var k = size / 512;
    if (!opts.noField) field(ctx, size, ox, oy);
    if (size <= 24) {
      smallBubble(ctx, ox + 196 * k, oy + 206 * k, 156 * k);
      smallBubble(ctx, ox + 372 * k, oy + 366 * k, 110 * k);
    } else if (size < 72) {
      smallBubble(ctx, ox + 180 * k, oy + 205 * k, 136 * k);
      smallBubble(ctx, ox + 368 * k, oy + 104 * k, 60 * k);
      smallBubble(ctx, ox + 373 * k, oy + 368 * k, 98 * k);
    } else if (opts.crisp) {
      crispBubble(ctx, ox + 178 * k, oy + 205 * k, 133 * k);
      crispBubble(ctx, ox + 363 * k, oy + 99 * k, 49 * k);
      crispBubble(ctx, ox + 373 * k, oy + 368 * k, 95 * k);
    } else {
      bubble(ctx, ox + 178 * k, oy + 205 * k, 133 * k);
      bubble(ctx, ox + 363 * k, oy + 99 * k, 49 * k);
      bubble(ctx, ox + 373 * k, oy + 368 * k, 95 * k);
    }
  }

  /* Apple's tile: straight sides joined by continuous-curvature corners (the smooth-corner Bézier
   * construction iOS/macOS use), not circular arcs — and not a pure superellipse, which has no straight
   * edges and reads as a pillow. Radius is macOS's 185/824 of the tile; each corner spans 1.5287 r. */
  var CORNER = [[1.52866483, 0], [1.08849323, 0], [0.86840689, 0], [0.63149399, 0.07491100],
    [0.37282392, 0.16905899], [0.16905899, 0.37282392], [0.07491100, 0.63149399],
    [0, 0.86840689], [0, 1.08849323], [0, 1.52866483]];
  function squircle(ctx, x, y, s, ratio) {
    var r = s * (ratio || 185 / 824);
    // each corner as (along-edge, into-corner) offsets from the corner point, rotated per corner
    var corners = [[x + s, y, -1, 1, false], [x + s, y + s, -1, -1, true], [x, y + s, 1, -1, false], [x, y, 1, 1, true]];
    ctx.beginPath();
    corners.forEach(function (k, i) {
      var cx = k[0], cy = k[1], sx = k[2], sy = k[3], swap = k[4];
      var pt = function (p) { var a = p[0] * r, b = p[1] * r; return swap ? [cx + sx * b, cy + sy * a] : [cx + sx * a, cy + sy * b]; };
      var p = CORNER.map(pt);
      if (i === 0) ctx.moveTo(p[0][0], p[0][1]); else ctx.lineTo(p[0][0], p[0][1]);
      ctx.bezierCurveTo(p[1][0], p[1][1], p[2][0], p[2][1], p[3][0], p[3][1]);
      ctx.bezierCurveTo(p[4][0], p[4][1], p[5][0], p[5][1], p[6][0], p[6][1]);
      ctx.bezierCurveTo(p[7][0], p[7][1], p[8][0], p[8][1], p[9][0], p[9][1]);
    });
    ctx.closePath();
  }

  root.SpritzBubbles = { bubble: bubble, crispBubble: crispBubble, smallBubble: smallBubble, field: field, mark: mark, squircle: squircle };
})(window);
