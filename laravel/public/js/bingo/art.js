/*
 * Bingo Pinball: the pixel art. Everything on the 320 x 180 screen is drawn here with whole-pixel rectangles: a tiny 3 x 5 font, the wooden cabinet, the backglass with
 * the card and the paytable, the slanted playfield with its pins and 25 holes, the balls and the plunger. The table's geometry is table.js (shared with the path generator).
 * window.BingoArt.create(canvas) -> { draw(scene) }.
 */
(function () {
  'use strict';
  var T = window.BingoTable;

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

  /* ---------- little drawing helpers ---------- */
  function rect(g, x, y, w, h, c) { g.fillStyle = c; g.fillRect(x, y, w, h); }
  function disc(g, cx, cy, r, c) {                       // a filled circle from whole pixels
    g.fillStyle = c;
    for (var y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) for (var x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
      var dx = x + 0.5 - cx, dy = y + 0.5 - cy;
      if (dx * dx + dy * dy <= r * r) g.fillRect(x, y, 1, 1);
    }
  }
  function ring(g, cx, cy, r, w, c) {
    g.fillStyle = c;
    for (var y = Math.floor(cy - r - 1); y <= Math.ceil(cy + r + 1); y++) for (var x = Math.floor(cx - r - 1); x <= Math.ceil(cx + r + 1); x++) {
      var d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      if (d <= r && d > r - w) g.fillRect(x, y, 1, 1);
    }
  }
  function line(g, x0, y0, x1, y1, c, t) {               // a line of whole pixels, t pixels thick
    g.fillStyle = c;
    var dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0), n = Math.max(dx, dy, 1), i;
    for (i = 0; i <= n; i++) g.fillRect(Math.round(x0 + (x1 - x0) * i / n - t / 2 + 0.5), Math.round(y0 + (y1 - y0) * i / n - t / 2 + 0.5), t, t);
  }

  var C = {
    wood: '#5a3414', woodHi: '#9a6a30', woodLo: '#2e1808', woodMid: '#7a4a20',
    navy: '#0a1030', panel: '#101a40', panelHi: '#2c3a78', gold: '#ffd23c', goldLo: '#b88a10', white: '#ffffff', cyan: '#3cd8ff', green: '#7dff7d', red: '#ff5a4a',
    field: '#0c3a46', fieldHi: '#14566a', fieldLo: '#08262e', rail: '#d0d6e8', railLo: '#6a7290', hole: '#050810', brass: '#a87a30', brassHi: '#e8b860'
  };

  /* ---------- the static picture: cabinet, backglass, playfield ---------- */
  function paintStatic(g, pt) {
    var F = T.FIELD, L = T.LANE, i, x, y;
    rect(g, 0, 0, 320, 180, C.woodLo);
    for (y = 0; y < 180; y += 3) rect(g, 0, y, 320, 1, (y / 3) % 2 ? C.wood : C.woodMid);                       // the grain of the wood
    rect(g, 0, 0, 320, 1, C.woodHi); rect(g, 0, 0, 1, 180, C.woodHi); rect(g, 319, 0, 1, 180, '#1c0e04'); rect(g, 0, 179, 320, 1, '#1c0e04');
    // the marquee
    rect(g, 4, 2, 312, 10, C.navy); rect(g, 4, 2, 312, 1, C.panelHi); rect(g, 4, 11, 312, 1, '#000');
    textShadow(g, 'BINGO PINBALL', 10, 3, C.gold, '#7a3a00', 1);
    // the backglass (left)
    rect(g, 6, 14, 116, 160, '#000'); rect(g, 7, 15, 114, 158, C.panel); rect(g, 7, 15, 114, 1, C.panelHi); rect(g, 7, 15, 1, 158, C.panelHi);
    // the playfield frame (right)
    rect(g, 124, 13, 184, 163, '#000'); rect(g, 125, 14, 182, 161, C.fieldLo);
    // the felt of the field: a gentle diamond pattern
    g.save(); g.beginPath(); g.rect(F.l, F.t, F.r - F.l, F.b - F.t); g.clip();
    rect(g, F.l, F.t, F.r - F.l, F.b - F.t, C.field);
    for (y = F.t; y < F.b; y += 6) for (x = F.l + ((y / 6) % 2) * 6; x < F.r; x += 12) rect(g, x, y, 2, 2, C.fieldHi);
    g.restore();
    // the lane
    rect(g, L.l, 44, L.r - L.l, T.LANE.startY + 8 - 44, '#07202a');
    for (y = 60; y < 164; y += 10) rect(g, L.x - 1, y, 2, 4, '#145060');                                         // arrows up the lane
    // the arch and the walls (rails)
    for (i = 0; i < T.walls.length; i++) { var w = T.walls[i]; line(g, w[0] + 1, w[1] + 1, w[2] + 1, w[3] + 1, '#02060c', 2); }
    for (i = 0; i < T.walls.length; i++) { var w2 = T.walls[i]; line(g, w2[0], w2[1], w2[2], w2[3], C.rail, 2); }
    // the pins
    for (i = 0; i < T.pins.length; i++) { var p = T.pins[i]; rect(g, Math.round(p.x) - 1, Math.round(p.y) - 1, 3, 3, C.railLo); rect(g, Math.round(p.x) - 1, Math.round(p.y) - 1, 2, 2, C.rail); }
    // the holes with their numbers
    for (i = 0; i < T.holes.length; i++) {
      var h = T.holes[i];
      disc(g, h.x, h.y, T.HOLE_R + 1, C.brass); disc(g, h.x, h.y, T.HOLE_R, C.hole);
      rect(g, Math.round(h.x - T.HOLE_R), Math.round(h.y - T.HOLE_R) + 1, 2, 2, C.brassHi);
      var s = String(h.n);
      text(g, s, Math.round(h.x - textWidth(s) / 2), Math.round(h.y - 2), '#35507a', 1);
    }
    // the paytable on the backglass
    textShadow(g, 'PAYS', 12, 98, C.gold, '#000', 1);
    var rows = [[3, 'LINES OF 3'], [4, 'LINES OF 4'], [5, 'LINES OF 5']];
    for (i = 0; i < 3; i++) {
      text(g, rows[i][1], 12, 106 + i * 8, C.cyan, 1);
      textRight(g, (pt ? pt.pays[rows[i][0]] : '?') + 'X', 117, 106 + i * 8, C.gold, 1);
    }
    rect(g, 12, 130, 104, 1, C.panelHi);
  }

  /* ---------- the card on the backglass ---------- */
  var CARD = { x: 12, y: 21, cell: 14 };
  function cellOf(i) { return { x: CARD.x + (i % 5) * CARD.cell, y: CARD.y + Math.floor(i / 5) * CARD.cell }; }

  function create(canvas) {
    var g = canvas.getContext('2d');
    g.imageSmoothingEnabled = false;
    var stat = document.createElement('canvas'); stat.width = 320; stat.height = 180;
    var sg = stat.getContext('2d');
    var paintedFor = null;

    /**
     * scene: { paytable:{pays,card}, filled:{holeNo:true}, lit:{cell:true}, lineCells:[cell...], flash:0..1, ball:{x,y}|null, balls:{left:n,total:5}, pull:0..1,
     *          launched:0..1, sparks:[{x,y,t}], pinFlash:{index:t}, caught:[{x,y,t}], time:ms, hint:bool }
     */
    function draw(scene) {
      var pt = scene.paytable || null, key = pt ? pt.id : '-';
      if (paintedFor !== key) { paintStatic(sg, pt); paintedFor = key; }
      g.drawImage(stat, 0, 0);
      var time = scene.time || 0, i, h;
      // the marquee bulbs
      for (i = 0; i < 12; i++) rect(g, 112 + i * 7, 2 + (i % 2 ? 0 : 8), 2, 2, ((Math.floor(time / 250) + i) % 3 === 0) ? C.gold : '#5a4a10');
      // the card
      if (pt) {
        var lineSet = {}, k;
        for (k = 0; k < (scene.lineCells || []).length; k++) lineSet[scene.lineCells[k]] = true;
        for (i = 0; i < 25; i++) {
          var c = cellOf(i), lit = scene.lit && scene.lit[i], inLine = lineSet[i], flash = inLine && (Math.floor(time / 140) % 2 === 0);
          rect(g, c.x, c.y, CARD.cell - 1, CARD.cell - 1, lit ? (flash ? C.green : C.gold) : '#0a1236');
          rect(g, c.x, c.y, CARD.cell - 1, 1, lit ? '#fff7b0' : C.panelHi); rect(g, c.x, c.y, 1, CARD.cell - 1, lit ? '#fff7b0' : C.panelHi);
          var n = String(pt.card[i]);
          text(g, n, c.x + Math.round((CARD.cell - 1 - textWidth(n)) / 2), c.y + 4, lit ? '#3a2400' : '#7aa0e0', 1);
        }
      }
      // balls left to play
      var b = scene.balls || { left: 5, total: 5 };
      textShadow(g, 'BALLS', 90, 23, C.cyan, '#000', 1);
      for (i = 0; i < b.total; i++) {
        var by = 32 + i * 10;
        if (i < b.left) { disc(g, 100, by + 3, 3, '#7a5a08'); disc(g, 99.5, by + 2.5, 3, C.gold); rect(g, 98, by + 1, 2, 1, '#fff7b0'); }
        else { ring(g, 100, by + 3, 3, 1, '#2a3a70'); }
      }
      // the holes that hold a ball
      for (i = 0; i < T.holes.length; i++) {
        h = T.holes[i];
        if (scene.filled && scene.filled[h.n]) { ring(g, h.x, h.y, T.HOLE_R + 2, 1, C.gold); disc(g, h.x, h.y, 2.6, '#7a5a08'); disc(g, h.x - 0.3, h.y - 0.3, 2.5, C.gold); rect(g, Math.round(h.x) - 2, Math.round(h.y) - 2, 1, 1, '#fff7b0'); }
      }
      // pins that were just hit
      var pf = scene.pinFlash || {};
      for (var pi in pf) { if (pf[pi] > 0) { var p = T.pins[pi]; rect(g, Math.round(p.x) - 1, Math.round(p.y) - 1, 3, 3, '#fff'); } }
      // the plunger
      var L = T.LANE, pull = scene.pull || 0, kneeY = T.LANE.startY + 7 + Math.round(pull * 7);
      rect(g, L.x - 1, kneeY, 2, 174 - kneeY + 2, '#9aa0b8');
      for (i = 0; i < 4; i++) rect(g, L.x - 3, kneeY + 2 + i * 2 - (i * Math.round(pull * 3)) % 3, 6, 1, '#6a7290');       // the spring
      rect(g, L.x - 3, kneeY - 2, 6, 3, C.red); rect(g, L.x - 3, kneeY - 2, 6, 1, '#ff9a8a');
      // the ball
      if (scene.ball) ballSprite(g, scene.ball.x, scene.ball.y);
      // a ball that has just dropped in: a ring spreads
      (scene.caught || []).forEach(function (c) { ring(g, c.x, c.y, 5 + c.t * 14, 1, c.t < 0.6 ? C.white : C.gold); });
      // sparks
      (scene.sparks || []).forEach(function (s) { rect(g, Math.round(s.x + s.dx * s.t * 8), Math.round(s.y + s.dy * s.t * 8 + s.t * s.t * 6), 1, 1, s.t < 0.5 ? C.white : C.gold); });
      // the power gauge next to the lane
      if (scene.hint || pull > 0) {
        rect(g, 306, 64, 7, 98, '#000'); rect(g, 307, 65, 5, 96, '#0a1236');
        var hgt = Math.round(94 * pull);
        rect(g, 308, 160 - hgt, 3, hgt, pull < 0.4 ? C.green : pull < 0.75 ? C.gold : C.red);
      }
    }
    return { draw: draw, cell: cellOf };
  }

  function ballSprite(g, x, y) {
    var X = Math.round(x), Y = Math.round(y);
    rect(g, X - 1, Y + 3, 4, 1, 'rgba(0,0,0,.45)');                                  // the shadow
    var P = ['.ooo.', 'oHyyo', 'oyyyo', 'oyyso', '.ooo.'], col = { o: '#8a5a08', H: '#fff7b0', y: '#ffd23c', s: '#c08a10' };
    for (var r = 0; r < 5; r++) for (var c = 0; c < 5; c++) { var ch = P[r][c]; if (ch !== '.') rect(g, X - 2 + c, Y - 2 + r, 1, 1, col[ch]); }
  }

  window.BingoArt = { create: create, text: text, textWidth: textWidth, cellOf: cellOf, ballSprite: ballSprite };
})();
