(function (root) {
  'use strict';
  /* Spritz's mark: three soap bubbles, as on the app's home screen. The home screen uses the emoji
   * glyph; this draws the same look procedurally (it does not embed Apple's artwork). One bubble is
   * drawn from layers — near-black glass, a lighter disc near the top, a flat-topped reflection across
   * the lower part, and a broad iridescent rim (a colour wheel masked to a ring) — and placed three
   * times in the emoji's layout (large, small, medium). Browser-only: it needs a canvas. */
  var TAU = Math.PI * 2;
  var RIM = [[0.00, 'rgba(127,211,255,0.91)'], [0.07, 'rgba(140,196,245,0.91)'], [0.14, 'rgba(160,184,245,0.98)'],
    [0.18, 'rgba(255,143,184,1.00)'], [0.23, 'rgba(255,170,200,1.00)'], [0.28, 'rgba(169,220,255,1.00)'],
    [0.36, 'rgba(184,224,255,1.00)'], [0.44, 'rgba(168,212,255,1.00)'], [0.50, 'rgba(190,186,255,0.91)'],
    [0.545, 'rgba(230,160,236,1.00)'], [0.585, 'rgba(255,140,196,1.00)'], [0.625, 'rgba(255,170,214,1.00)'],
    [0.68, 'rgba(246,222,246,1.00)'], [0.76, 'rgba(236,240,255,1.00)'], [0.86, 'rgba(190,232,255,0.94)'],
    [0.94, 'rgba(140,215,255,0.88)'], [1.00, 'rgba(127,211,255,0.91)']];

  function layer(size) { var c = document.createElement('canvas'); c.width = c.height = size; return c; }

  function bubble(ctx, cx, cy, R) {
    var S = Math.ceil(R * 2.5), o = S / 2, L = layer(S), c = L.getContext('2d'), g;
    c.translate(o, o);

    c.save();
    c.beginPath(); c.arc(0, 0, R, 0, TAU); c.clip();
    // near-black glass, a hair lighter toward the edge
    g = c.createRadialGradient(0, 0, 0, 0, 0, R);
    g.addColorStop(0, '#040404'); g.addColorStop(0.75, '#070707'); g.addColorStop(1, '#14181c');
    c.fillStyle = g; c.fillRect(-R, -R, 2 * R, 2 * R);
    // a faint warm tint on the left, as in the emoji
    g = c.createRadialGradient(-0.62 * R, 0.1 * R, 0, -0.62 * R, 0.1 * R, 0.75 * R);
    g.addColorStop(0, 'rgba(184,122,114,0.09)'); g.addColorStop(1, 'rgba(184,122,114,0)');
    c.fillStyle = g; c.fillRect(-R, -R, 2 * R, 2 * R);
    // the lighter disc inside the top: broad and faint, with a barely-there edge
    g = c.createLinearGradient(0, -R, 0, -0.1 * R);
    g.addColorStop(0, 'rgba(214,208,222,0.26)'); g.addColorStop(1, 'rgba(214,208,222,0)');
    c.fillStyle = g; c.fillRect(-R, -R, 2 * R, 0.9 * R);
    c.filter = 'blur(' + (R * 0.06) + 'px)';
    c.save(); c.translate(0.12 * R, -0.40 * R); c.scale(1, 0.70);
    g = c.createRadialGradient(0, 0, 0, 0, 0, 0.55 * R);
    g.addColorStop(0, 'rgba(226,222,228,0.20)'); g.addColorStop(0.7, 'rgba(226,222,228,0.10)'); g.addColorStop(1, 'rgba(226,222,228,0)');
    c.fillStyle = g; c.beginPath(); c.arc(0, 0, 0.55 * R, 0, TAU); c.fill();
    c.restore();
    // one faint arc along the top of that disc
    c.filter = 'blur(' + (R * 0.02) + 'px)';
    c.save(); c.translate(0.12 * R, -0.40 * R); c.scale(1, 0.70);
    c.strokeStyle = 'rgba(232,228,234,0.13)'; c.lineWidth = R * 0.03; c.beginPath(); c.arc(0, 0, 0.52 * R, Math.PI * 1.1, Math.PI * 1.9); c.stroke();
    c.restore();
    // the flat-topped reflection across the lower part
    c.filter = 'blur(' + (R * 0.035) + 'px)';
    g = c.createLinearGradient(0, 0.34 * R, 0, R);
    g.addColorStop(0, 'rgba(120,175,195,0.16)'); g.addColorStop(0.5, 'rgba(150,200,226,0.36)'); g.addColorStop(1, 'rgba(180,222,248,0.62)');
    c.fillStyle = g; c.fillRect(-1.1 * R, 0.36 * R, 2.2 * R, R);
    c.fillStyle = 'rgba(207,232,242,0.12)'; c.fillRect(-1.1 * R, 0.352 * R, 2.2 * R, R * 0.012);
    c.filter = 'none';
    c.restore();

    // the iridescent rim: a colour wheel, masked to a soft ring
    var ring = layer(S), r = ring.getContext('2d');
    r.translate(o, o);
    g = r.createConicGradient(0, 0, 0);
    RIM.forEach(function (s) { g.addColorStop(s[0], s[1]); });
    r.fillStyle = g; r.beginPath(); r.arc(0, 0, R * 1.02, 0, TAU); r.fill();
    r.globalCompositeOperation = 'destination-in';
    g = r.createRadialGradient(0, 0, 0, 0, 0, R * 1.02);
    g.addColorStop(0.76, 'rgba(0,0,0,0)'); g.addColorStop(0.89, 'rgba(0,0,0,0.38)');
    g.addColorStop(0.955, 'rgba(0,0,0,0.95)'); g.addColorStop(0.99, 'rgba(0,0,0,0.80)'); g.addColorStop(1, 'rgba(0,0,0,0)');
    r.fillStyle = g; r.fillRect(-S, -S, 2 * S, 2 * S);
    c.filter = 'blur(' + (R * 0.018) + 'px)';
    c.drawImage(ring, -o, -o);
    c.filter = 'none';
    c.strokeStyle = 'rgba(207,227,245,0.30)'; c.lineWidth = Math.max(1, R * 0.012);
    c.beginPath(); c.arc(0, 0, R * 0.995, 0, TAU); c.stroke();

    ctx.drawImage(L, cx - o, cy - o);
  }

  /* The mark on a square `size` canvas region at (ox, oy): the near-black field plus three bubbles. */
  function mark(ctx, size, ox, oy) {
    ox = ox || 0; oy = oy || 0;
    var k = size / 512, g = ctx.createRadialGradient(ox + size * 0.5, oy + size * 0.46, 0, ox + size * 0.5, oy + size * 0.46, size * 0.72);
    g.addColorStop(0, '#0e0f11'); g.addColorStop(1, '#0a0a0b');
    ctx.fillStyle = g; ctx.fillRect(ox, oy, size, size);
    bubble(ctx, ox + 178 * k, oy + 205 * k, 133 * k);
    bubble(ctx, ox + 363 * k, oy + 99 * k, 49 * k);
    bubble(ctx, ox + 373 * k, oy + 368 * k, 95 * k);
  }

  root.SpritzBubbles = { bubble: bubble, mark: mark };
})(window);
