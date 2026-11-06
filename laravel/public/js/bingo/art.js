/*
 * Bingo Pinball: the pixel art. An upright pinball cabinet on a 180 x 320 screen (scaled by whole numbers by the page), drawn with whole-pixel rectangles: a tiny 3 x 5 font,
 * the wooden cabinet with its brass trim and marquee lights, the backglass (title, the lit 5 x 5 card, the paytable, the balls still to play), the slanted playfield (the flat
 * table of table.js seen in perspective: far end narrow and short, near end wide) with pins, 25 holes and the plunger lane on the right, and the coin-door deck under it
 * (the page lays its buttons over the deck). The ball paths are computed on the flat table; project() turns a table position into a screen position, so nothing about
 * the physics, the path library or the result depends on how the table is drawn.
 * window.BingoArt.create(canvas) -> { draw(scene), project }.
 */
(function () {
  'use strict';
  var T = window.BingoTable;
  var SW = 180, SH = 320;

  /* ---------- a 3 x 5 pixel font ---------- */
  var G = {
    '0': '111101101101111', '1': '010110010010111', '2': '111001111100111', '3': '111001111001111', '4': '101101111001001', '5': '111100111001111', '6': '111100111101111',
    '7': '111001010010010', '8': '111101111101111', '9': '111101111001111',
    A: '010101111101101', B: '110101110101110', C: '011100100100011', D: '110101101101110', E: '111100110100111', F: '111100110100100', G: '011100101101011',
    H: '101101111101101', I: '111010010010111', J: '001001001101010', K: '101101110101101', L: '100100100100111', M: '101111111101101', N: '110101101101101',
    O: '010101101101010', P: '110101110100100', Q: '010101101110011', R: '110101110101101', S: '011100010001110', T: '111010010010010', U: '101101101101111',
    V: '101101101101010', W: '101101111111101', X: '101101010101101', Y: '101101010010010', Z: '111001010100111',
    ' ': '000000000000000', '.': '000000000000010', ',': '000000000010100', ':': '000010000010000', '-': '000000111000000', '+': '000010111010000', '%': '101001010100101',
    '/': '001001010100100', '!': '010010010000010', '?': '111001010000010', '=': '000111000111000', '>': '100010001010100', '<': '001010100010001'
  };
  function textWidth(s, scale) { return (s.length * 4 - 1) * (scale || 1); }
  function text(g, s, x, y, color, scale) {
    scale = scale || 1; g.fillStyle = color;
    for (var i = 0; i < s.length; i++) {
      var glyph = G[s[i].toUpperCase()] || G['?'];
      for (var k = 0; k < 15; k++) if (glyph.charAt(k) === '1') g.fillRect(x + (i * 4 + (k % 3)) * scale, y + Math.floor(k / 3) * scale, scale, scale);
    }
  }
  function textShadow(g, s, x, y, color, shadow, scale) { text(g, s, x + (scale || 1), y + (scale || 1), shadow, scale); text(g, s, x, y, color, scale); }
  function textRight(g, s, rx, y, color, scale) { text(g, s, rx - textWidth(s, scale), y, color, scale); }
  function textCentre(g, s, cx, y, color, scale) { text(g, s, Math.round(cx - textWidth(s, scale) / 2), y, color, scale); }

  /* ---------- little drawing helpers ---------- */
  function rect(g, x, y, w, h, c) { g.fillStyle = c; g.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h)); }
  function disc(g, cx, cy, r, c) {
    g.fillStyle = c;
    for (var y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) for (var x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
      var dx = x + 0.5 - cx, dy = y + 0.5 - cy;
      if (dx * dx + dy * dy <= r * r) g.fillRect(x, y, 1, 1);
    }
  }
  function ellipse(g, cx, cy, rx, ry, c) {                         // a filled ellipse (a circle on the table, seen at a slant)
    g.fillStyle = c;
    for (var y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++) for (var x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
      var dx = (x + 0.5 - cx) / rx, dy = (y + 0.5 - cy) / ry;
      if (dx * dx + dy * dy <= 1) g.fillRect(x, y, 1, 1);
    }
  }
  function ellipseRing(g, cx, cy, rx, ry, w, c) {
    g.fillStyle = c;
    for (var y = Math.floor(cy - ry - 1); y <= Math.ceil(cy + ry + 1); y++) for (var x = Math.floor(cx - rx - 1); x <= Math.ceil(cx + rx + 1); x++) {
      var dx = (x + 0.5 - cx) / rx, dy = (y + 0.5 - cy) / ry, d = dx * dx + dy * dy, inner = Math.max(0, 1 - w / Math.min(rx, ry));
      if (d <= 1 && d > inner * inner) g.fillRect(x, y, 1, 1);
    }
  }
  function line(g, x0, y0, x1, y1, c, t) {
    g.fillStyle = c;
    var dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0), n = Math.max(dx, dy, 1), i;
    for (i = 0; i <= n; i++) g.fillRect(Math.round(x0 + (x1 - x0) * i / n - t / 2 + 0.5), Math.round(y0 + (y1 - y0) * i / n - t / 2 + 0.5), t, t);
  }
  function rng(seed) { var s = seed >>> 0; return function () { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

  var C = {
    wood: '#5a3414', woodHi: '#9a6a30', woodLo: '#2e1808', woodMid: '#7a4a20', woodDark: '#1c0e04',
    navy: '#0a1030', panel: '#101a40', panelHi: '#2c3a78', gold: '#ffd23c', goldLo: '#b88a10', white: '#ffffff', cyan: '#3cd8ff', green: '#7dff7d', red: '#ff5a4a',
    field: '#0c3a46', fieldHi: '#14566a', fieldLo: '#08262e', rail: '#d0d6e8', railLo: '#6a7290', hole: '#050810', brass: '#a87a30', brassHi: '#e8b860', metal: '#1a2236', metalHi: '#34425e'
  };

  /* ---------- the layout of the cabinet (screen pixels) ---------- */
  var GLASS = { x: 9, y: 8, w: 162, h: 96 };                         // the backglass
  var CARD = { x: 14, y: 30, cell: 12 };                             // the 5 x 5 card on it
  var PLAY = { cx: 90, y0: 108, h: 150, w: 160 };                    // the playfield: centre, top row, height, width of the near (bottom) edge
  var DECK = { y: 266 };                                             // the coin-door deck (the page lays its controls over it)
  var A = 0.62;                                                      // how much narrower and shorter the far end of the table looks than the near end

  /* ---------- the slanted table: flat table coordinates -> screen ---------- */
  var XL = 127, XR = 304, YT = 4, YB = 176;
  var NORM = A + (1 - A) / 2;
  /** @returns {{x:number,y:number,sx:number,sy:number}} screen position and how much a table pixel is stretched sideways (sx) and up-down (sy) there */
  function project(x, y) {
    var u = (x - XL) / (XR - XL), v = Math.max(0, Math.min(1.05, (y - YT) / (YB - YT))), s = A + (1 - A) * v;
    return { x: PLAY.cx + (u - 0.5) * PLAY.w * s, y: PLAY.y0 + PLAY.h * (A * v + (1 - A) * v * v / 2) / NORM, sx: PLAY.w * s / (XR - XL), sy: PLAY.h * s / NORM / (YB - YT) };
  }
  function vAtRow(sy) {                                              // the inverse: which table depth (0 far .. 1 near) is on this screen row
    var t = (sy - PLAY.y0) / PLAY.h, k = 1 - A;
    return k === 0 ? t : (-A + Math.sqrt(A * A + 2 * k * t * NORM)) / k;
  }

  /* ---------- the static picture ---------- */
  function wood(g, x, y, w, h, vertical, seed) {
    var r = rng(seed), i;
    rect(g, x, y, w, h, C.wood);
    if (vertical) for (i = 0; i < w; i += 2) rect(g, x + i, y, 1, h, i % 4 ? C.woodMid : C.woodLo);
    else for (i = 0; i < h; i += 2) rect(g, x, y + i, w, 1, i % 4 ? C.woodMid : C.woodLo);
    for (i = 0; i < w * h / 90; i++) rect(g, x + r() * w, y + r() * h, vertical ? 1 : 3, vertical ? 3 : 1, C.woodHi);        // knots and highlights
  }
  function bevel(g, x, y, w, h, hi, lo) { rect(g, x, y, w, 1, hi); rect(g, x, y, 1, h, hi); rect(g, x, y + h - 1, w, 1, lo); rect(g, x + w - 1, y, 1, h, lo); }

  function paintStatic(g, pt) {
    var i, x, y, r = rng(7);
    // the cabinet: wooden sides, headboard and foot, with a brass inlay
    rect(g, 0, 0, SW, SH, C.woodDark);
    wood(g, 0, 0, 8, SH, true, 1); wood(g, SW - 8, 0, 8, SH, true, 2); wood(g, 0, 0, SW, 8, false, 3); wood(g, 0, SH - 6, SW, 6, false, 4);
    bevel(g, 0, 0, SW, SH, C.woodHi, C.woodDark);
    rect(g, 7, 7, 1, SH - 13, C.brass); rect(g, SW - 8, 7, 1, SH - 13, C.brass); rect(g, 7, 7, SW - 14, 1, C.brass); rect(g, 7, SH - 7, SW - 14, 1, C.brass);
    // the backglass: a night sky with stars and a neon frame
    rect(g, GLASS.x - 1, GLASS.y - 1, GLASS.w + 2, GLASS.h + 2, '#000');
    for (y = 0; y < GLASS.h; y++) rect(g, GLASS.x, GLASS.y + y, GLASS.w, 1, y < 30 ? '#14104a' : y < 60 ? '#101a52' : '#0a1236');
    for (i = 0; i < 46; i++) rect(g, GLASS.x + 2 + r() * (GLASS.w - 4), GLASS.y + 2 + r() * (GLASS.h - 4), 1, 1, i % 5 ? '#4a5aa0' : '#fff7b0');
    bevel(g, GLASS.x, GLASS.y, GLASS.w, GLASS.h, C.panelHi, '#000');
    textShadow(g, 'BINGO PINBALL', Math.round(GLASS.x + GLASS.w / 2 - textWidth('BINGO PINBALL', 2) / 2), 11, C.gold, '#7a1a00', 2);
    rect(g, GLASS.x + 8, 24, GLASS.w - 16, 1, C.cyan); rect(g, GLASS.x + 8, 26, GLASS.w - 16, 1, '#1a6a8a');
    // the card's frame and the paytable
    rect(g, CARD.x - 2, CARD.y - 2, CARD.cell * 5 + 4, CARD.cell * 5 + 4, '#000'); bevel(g, CARD.x - 2, CARD.y - 2, CARD.cell * 5 + 4, CARD.cell * 5 + 4, C.brass, C.goldLo);
    var px = 84;
    textShadow(g, 'PAYS', px, 30, C.gold, '#000', 1);
    rect(g, px, 37, 78, 1, C.panelHi);
    var rows = [[3, 'LINES OF 3'], [4, 'LINES OF 4'], [5, 'LINES OF 5']];
    for (i = 0; i < 3; i++) {
      text(g, rows[i][1], px, 41 + i * 9, C.cyan, 1);
      textRight(g, (pt ? pt.pays[rows[i][0]] : '?') + 'X', px + 78, 40 + i * 9, C.gold, 1);
    }
    // the rail between the backglass and the playfield
    rect(g, 8, GLASS.y + GLASS.h + 1, SW - 16, 3, C.brass); rect(g, 8, GLASS.y + GLASS.h + 1, SW - 16, 1, C.brassHi); rect(g, 8, GLASS.y + GLASS.h + 3, SW - 16, 1, C.goldLo);

    // the slanted playfield: row by row, a trapezoid (narrow far end, wide near end)
    rect(g, 8, PLAY.y0 - 1, SW - 16, PLAY.h + 3, '#05080e');
    for (y = PLAY.y0; y < PLAY.y0 + PLAY.h; y++) {
      var v = vAtRow(y + 0.5), s = A + (1 - A) * v, half = PLAY.w * s / 2, lx = Math.round(PLAY.cx - half), rx = Math.round(PLAY.cx + half);
      rect(g, lx, y, rx - lx, 1, C.field);
      var band = Math.floor(v * 26);                                // lighter stripes that bunch up in the distance: depth
      if (band % 2) rect(g, lx, y, rx - lx, 1, '#0e4250');
      for (x = lx + ((band % 4) * 3 + y % 3); x < rx; x += 9) rect(g, x, y, 1, 1, C.fieldHi);
    }
    // the plunger lane (darker), and the walls as rails seen from above
    for (y = PLAY.y0; y < PLAY.y0 + PLAY.h; y++) {
      var v2 = vAtRow(y + 0.5), ty = YT + v2 * (YB - YT);
      if (ty < 44) continue;
      var a = project(T.LANE.l, ty), b = project(T.LANE.r, ty);
      rect(g, a.x, y, b.x - a.x, 1, '#06202a');
    }
    var seg;
    for (i = 0; i < T.walls.length; i++) { seg = T.walls[i]; var p0 = project(seg[0], seg[1]), p1 = project(seg[2], seg[3]); line(g, p0.x, p0.y + 2, p1.x, p1.y + 2, '#02060c', 2); }
    for (i = 0; i < T.walls.length; i++) { seg = T.walls[i]; var q0 = project(seg[0], seg[1]), q1 = project(seg[2], seg[3]); line(g, q0.x, q0.y, q1.x, q1.y, C.railLo, 3); line(g, q0.x, q0.y - 1, q1.x, q1.y - 1, C.rail, 1); }
    for (y = 60; y < 164; y += 14) { var ar = project(T.LANE.x, y); rect(g, ar.x - 1, ar.y, 2, Math.max(2, 4 * ar.sy), '#1a6a80'); }       // arrows up the lane
    // the pins, each with a little shadow
    for (i = 0; i < T.pins.length; i++) {
      var pn = project(T.pins[i].x, T.pins[i].y), pr = Math.max(1, Math.round(T.pins[i].r * pn.sx * 0.9));
      ellipse(g, pn.x + 1, pn.y + 1.5, pr + 0.5, pr * 0.8 + 0.4, '#04141a');
      ellipse(g, pn.x, pn.y - 0.5, pr, pr * 0.9, C.railLo); rect(g, pn.x - pr / 2, pn.y - pr, Math.max(1, pr * 0.7), 1, '#fff');
    }
    // the 25 holes: a brass rim, a dark hole, and the number painted on the felt below it
    for (i = 0; i < T.holes.length; i++) {
      var h = T.holes[i], hp = project(h.x, h.y), rx2 = T.HOLE_R * hp.sx, ry2 = T.HOLE_R * hp.sy;
      ellipse(g, hp.x, hp.y + 1, rx2 + 1.2, ry2 + 1.2, '#04141a');
      ellipse(g, hp.x, hp.y, rx2 + 1, ry2 + 1, C.brass); ellipse(g, hp.x, hp.y, rx2, ry2, C.hole);
      rect(g, hp.x - rx2, hp.y - ry2 * 0.4, 1, 1, C.brassHi);
      var sn = String(h.n); textCentre(g, sn, hp.x, Math.round(hp.y + ry2 + 2), '#3f6a8a', 1);
    }
    // the lip under the table, and the coin-door deck
    rect(g, 8, PLAY.y0 + PLAY.h, SW - 16, 4, C.brass); rect(g, 8, PLAY.y0 + PLAY.h, SW - 16, 1, C.brassHi); rect(g, 8, PLAY.y0 + PLAY.h + 3, SW - 16, 1, C.goldLo);
    rect(g, 8, DECK.y - 4, SW - 16, SH - 8 - (DECK.y - 4), C.metal); bevel(g, 8, DECK.y - 4, SW - 16, SH - 8 - (DECK.y - 4), C.metalHi, '#05080e');
    for (i = 0; i < 2; i++) { disc(g, 13 + i * 154, DECK.y, 1.5, '#7a8aa8'); disc(g, 13 + i * 154, SH - 12, 1.5, '#7a8aa8'); }       // rivets
  }

  /* ---------- the card on the backglass ---------- */
  function cellOf(i) { return { x: CARD.x + (i % 5) * CARD.cell, y: CARD.y + Math.floor(i / 5) * CARD.cell }; }

  function ballAt(g, p) {                                              // a ball on the table: round, shaded, with a shadow, bigger when nearer
    var r = Math.max(2.1, T.BALL_R * p.sx * 1.15);
    ellipse(g, p.x + 1, p.y + r * 0.75, r * 0.95, r * 0.5, '#031016');
    disc(g, p.x, p.y, r, '#7a5a08'); disc(g, p.x - 0.4, p.y - 0.4, r - 0.6, C.gold); rect(g, p.x - r * 0.5, p.y - r * 0.55, Math.max(1, r * 0.4), 1, '#fff7b0');
  }
  function ballSprite(g, x, y) { ballAt(g, project(x, y)); }

  function create(canvas) {
    var g = canvas.getContext('2d');
    g.imageSmoothingEnabled = false;
    var stat = document.createElement('canvas'); stat.width = SW; stat.height = SH;
    var sg = stat.getContext('2d');
    var paintedFor = null;

    /**
     * scene: { paytable:{pays,card}, filled:{holeNo:true}, lit:{cell:true}, lineCells:[cell...], ball:{x,y}|null (table coordinates), balls:{left:n,total:5}, pull:0..1,
     *          sparks:[{x,y,dx,dy,t}], pinFlash:{index:t}, caught:[{x,y,t}] (table coordinates), time:ms, hint:bool }
     */
    function draw(scene) {
      var pt = scene.paytable || null, key = pt ? pt.id : '-';
      if (paintedFor !== key) { paintStatic(sg, pt); paintedFor = key; }
      g.drawImage(stat, 0, 0);
      var time = scene.time || 0, i, h, p;
      // the marquee lights along the headboard
      for (i = 0; i < 20; i++) rect(g, 12 + i * 8, 3, 2, 2, ((Math.floor(time / 220) + i) % 3 === 0) ? C.gold : '#5a4a10');
      // the card
      if (pt) {
        var lineSet = {}, k;
        for (k = 0; k < (scene.lineCells || []).length; k++) lineSet[scene.lineCells[k]] = true;
        for (i = 0; i < 25; i++) {
          var c = cellOf(i), lit = scene.lit && scene.lit[i], flash = lineSet[i] && (Math.floor(time / 140) % 2 === 0);
          rect(g, c.x, c.y, CARD.cell - 1, CARD.cell - 1, lit ? (flash ? C.green : C.gold) : '#0a1236');
          rect(g, c.x, c.y, CARD.cell - 1, 1, lit ? '#fff7b0' : C.panelHi); rect(g, c.x, c.y, 1, CARD.cell - 1, lit ? '#fff7b0' : C.panelHi);
          var n = String(pt.card[i]);
          text(g, n, c.x + Math.round((CARD.cell - 1 - textWidth(n)) / 2), c.y + 3, lit ? '#3a2400' : '#7aa0e0', 1);
        }
      }
      // the balls still to play, under the card
      var b = scene.balls || { left: 5, total: 5 };
      text(g, 'BALLS', 84, 80, C.cyan, 1);
      for (i = 0; i < b.total; i++) {
        var bx = 91 + i * 13 + 8;
        if (i < b.left) { disc(g, bx, 93, 4, '#7a5a08'); disc(g, bx - 0.5, 92.5, 3.5, C.gold); rect(g, bx - 2, 90, 2, 1, '#fff7b0'); }
        else { ellipseRing(g, bx, 93, 4, 4, 1, '#2a3a70'); }
      }
      // holes that hold a ball
      for (i = 0; i < T.holes.length; i++) {
        h = T.holes[i];
        if (scene.filled && scene.filled[h.n]) { p = project(h.x, h.y); ellipseRing(g, p.x, p.y, T.HOLE_R * p.sx + 2, T.HOLE_R * p.sy + 2, 1, C.gold); ellipse(g, p.x, p.y, T.HOLE_R * p.sx * 0.8, T.HOLE_R * p.sy * 0.8, '#7a5a08'); ellipse(g, p.x - 0.3, p.y - 0.4, T.HOLE_R * p.sx * 0.7, T.HOLE_R * p.sy * 0.7, C.gold); }
      }
      // pins that were just hit
      var pf = scene.pinFlash || {};
      for (var pi in pf) { if (pf[pi] > 0) { var pp = project(T.pins[pi].x, T.pins[pi].y); rect(g, pp.x - 1.5, pp.y - 1.5, 3, 3, '#fff'); } }
      // the plunger in its lane: rod, spring and red knob, pulled down by the player
      var L = T.LANE, pull = scene.pull || 0, kneeY = L.startY + 7 + pull * 7, kn = project(L.x, kneeY), bot = project(L.x, 174);
      rect(g, kn.x - 1, kn.y, 2, bot.y - kn.y + 2, '#9aa0b8');
      for (i = 0; kn.y + 3 + i * 3 < bot.y; i++) rect(g, kn.x - 3, kn.y + 3 + i * 3 - (i * pull) % 2, 6, 1, '#6a7290');
      rect(g, kn.x - 3.5, kn.y - 3, 7, 4, C.red); rect(g, kn.x - 3.5, kn.y - 3, 7, 1, '#ff9a8a');
      // the ball
      if (scene.ball) ballAt(g, project(scene.ball.x, scene.ball.y));
      // a ball that has just dropped in: a ring spreads
      (scene.caught || []).forEach(function (cc) { var q = project(cc.x, cc.y); ellipseRing(g, q.x, q.y, 5 + cc.t * 12, (5 + cc.t * 12) * q.sy / q.sx, 1, cc.t < 0.6 ? C.white : C.gold); });
      (scene.sparks || []).forEach(function (s) { var q = project(s.x, s.y); rect(g, q.x + s.dx * s.t * 8, q.y + s.dy * s.t * 8 + s.t * s.t * 6, 1, 1, s.t < 0.5 ? C.white : C.gold); });
      // the power meter on the lip under the table
      if (scene.hint || pull > 0) {
        var mx = 36, my = PLAY.y0 + PLAY.h + 6, mw = 132, fill = Math.round((mw - 2) * pull);
        text(g, 'POWER', 12, my, '#6a7ec0', 1);
        rect(g, mx, my, mw, 5, '#000'); rect(g, mx + 1, my + 1, mw - 2, 3, '#0a1236');
        rect(g, mx + 1, my + 1, fill, 3, pull < 0.4 ? C.green : pull < 0.75 ? C.gold : C.red);
      }
    }
    return { draw: draw, cell: cellOf, project: project };
  }

  window.BingoArt = { create: create, text: text, textWidth: textWidth, cellOf: cellOf, ballSprite: ballSprite, project: project, SW: SW, SH: SH };
})();
