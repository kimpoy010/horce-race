/*
 * Bingo Pinball: the geometry of the table. One description for everything that needs it: the path generator (bin/bingo-paths.js) simulates balls on it and the
 * page draws it. Units are pixels of the 320 x 180 game screen, y grows downwards, gravity pulls the ball down the slanted playfield.
 * Works in the browser (window.BingoTable) and in Node (require).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BingoTable = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var W = 320, H = 180;
  var T = {
    W: W, H: H,
    BALL_R: 2.6,
    // the playfield (inside the walls) and the plunger lane on its right
    FIELD: { l: 128, r: 288, t: 14, b: 172 },
    LANE: { l: 291, r: 303, x: 297, startY: 166 },       // the ball is launched from (x, startY) straight up
    HOLE_R: 4.6,
    GRAVITY: 90,
    // launch power 0..1 -> speed up the lane
    V_MIN: 172, V_MAX: 318,
    // paths are stored at this many frames per second
    FPS: 20
  };

  // 25 holes in 5 rows of 5 (row by row: hole 1 top left, hole 25 bottom right), the rows staggered
  T.holes = [];
  for (var row = 0; row < 5; row++) {
    for (var col = 0; col < 5; col++) {
      T.holes.push({ n: row * 5 + col + 1, x: 150 + col * 28 + (row % 2) * 13, y: 60 + row * 23 });
    }
  }

  // pins between the holes (a staggered forest) and the walls
  T.pins = [];
  for (var r = 0; r < 12; r++) {
    for (var c = 0; c < 9; c++) {
      var px = 139 + c * 18 + (r % 2) * 9, py = 36 + r * 11;
      if (px > T.FIELD.r - 8 || px < T.FIELD.l + 6) continue;
      var tooClose = false;
      for (var h = 0; h < T.holes.length; h++) {
        var dx = px - T.holes[h].x, dy = py - T.holes[h].y;
        if (dx * dx + dy * dy < 9 * 9) { tooClose = true; break; }
      }
      if (!tooClose) T.pins.push({ x: px, y: py, r: 1.6 });
    }
  }

  // walls as line segments [x1, y1, x2, y2]: left wall, lane divider, outer wall, the arch over the top (a quarter circle) and the top
  T.walls = [];
  var F = T.FIELD, L = T.LANE;
  T.walls.push([F.l, F.t + 20, F.l, F.b]);                  // left wall
  T.walls.push([F.l + 20, F.t, F.l, F.t + 20]);             // the top left corner is cut
  T.walls.push([L.l, 60, L.l, L.startY + 8]);               // the lane divider: from the lane up to where the arch begins
  T.walls.push([L.r, 44, L.r, L.startY + 8]);               // the outer wall of the lane
  T.walls.push([L.l, L.startY + 8, L.r, L.startY + 8]);     // the floor of the lane
  var cx = 258, cy = 50, R = L.r - cx;                      // the arch: from the outer wall round to the top
  var prev = [L.r, cy];
  for (var i = 1; i <= 14; i++) {
    var a = -(Math.PI / 2) * (i / 14);
    var p = [cx + R * Math.cos(a), cy + R * Math.sin(a)];
    T.walls.push([prev[0], prev[1], p[0], p[1]]);
    prev = p;
  }
  T.walls.push([prev[0], prev[1], F.l + 20, F.t]);          // the top wall, ball leaves the arch along it
  T.walls.push([L.l, 60, L.l - 10, 40]);                    // a guide above the divider, so a ball does not fall back into the lane
  T.arch = { cx: cx, cy: cy, r: R };

  return T;
});
