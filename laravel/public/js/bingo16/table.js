/*
 * Bingo Pinball 16: the geometry of the board, in the units of the design's pin-board drawing (600 x 776). One file for three users: the page draws the board from it,
 * the path generator (bin/bingo16-paths.cjs) simulates balls on it, and the tests check it. UMD: window.BingoTable16, or require() in Node.
 *
 * The board: a rounded box with a plunger lane on the right (x 540..592) up which the ball is shot; at the top it turns left and falls through staggered rows of round
 * pegs towards 16 slots, side by side across the whole floor (33 wide). Three baskets stand among the pegs, in the place of three pegs; a ball that falls into one is a missed ball.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(); else root.BingoTable16 = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var W = 600, H = 776;
  var BALL_R = 4.5, PEG_R = 3, GRAVITY = 700, FPS = 30;
  var V_MIN = 1000, V_MAX = 1900;                     // launch speed up the lane (units/s) for the weakest and the strongest pull: a hard pull reaches the top in 0.4 s, a weak one in 0.9 s of the plunger
  var LANE = { l: 540, r: 592, x: 566, startY: 704, floorY: 766 };
  var RIM_Y = 676, SLOT_BOTTOM = 728, SLOT_W = 33, SLOT_STEP = 33, SLOT_X0 = 10;

  var slots = [], i, j;
  for (i = 0; i < 16; i++) slots.push({ n: i + 1, xl: SLOT_X0 + SLOT_STEP * i, xr: SLOT_X0 + SLOT_STEP * i + SLOT_W, x: SLOT_X0 + SLOT_STEP * i + SLOT_W / 2 });

  var pegs = [];                                      // 18 staggered rows, every 32 units, 40 apart (13 and 12 pegs alternately)
  for (j = 0; j < 18; j++) {
    var y = 70 + 32 * j, n = j % 2 ? 12 : 13, x0 = j % 2 ? 60 : 40;
    for (i = 0; i < n; i++) pegs.push({ x: x0 + 40 * i, y: y, r: PEG_R });
  }

  // ten places where a basket can stand, each in the place of one peg (row, column of the peg grid); the server draws three of them for every play. A basket is a cup 34 wide and 28 high
  var BK = { w: 17, top: -13, bottom: 13 };
  var BASKET_AT = [[3, 2], [4, 8], [6, 5], [7, 10], [9, 1], [10, 7], [12, 4], [13, 9], [15, 2], [15, 10]];
  var baskets = BASKET_AT.map(function (rc, k) {
    var idx = -1, q;
    for (q = 0; q < pegs.length; q++) { if (Math.abs(pegs[q].y - (70 + 32 * rc[0])) < 0.5 && Math.abs(pegs[q].x - ((rc[0] % 2 ? 60 : 40) + 40 * rc[1])) < 0.5) { idx = q; break; } }
    return { n: k + 1, x: pegs[idx].x, y: pegs[idx].y, peg: idx };
  });
  /** the three walls of a basket's cup (the cup stands where a peg was) */
  function basketWalls(b) {
    return [[b.x - BK.w, b.y + BK.top, b.x - BK.w, b.y + BK.bottom], [b.x - BK.w, b.y + BK.bottom, b.x + BK.w, b.y + BK.bottom], [b.x + BK.w, b.y + BK.bottom, b.x + BK.w, b.y + BK.top]];
  }

  var walls = [];                                     // line segments [x1, y1, x2, y2]
  function arc(cx, cy, r, a0, a1, n) {                // a quarter of a circle as short segments
    var prev = null, k;
    for (k = 0; k <= n; k++) {
      var a = a0 + (a1 - a0) * k / n, p = [cx + r * Math.cos(a), cy + r * Math.sin(a)];
      if (prev) walls.push([prev[0], prev[1], p[0], p[1]]);
      prev = p;
    }
  }
  walls.push([8, 766, 8, 60]);                        // left wall
  arc(54, 60, 46, Math.PI, Math.PI * 1.5, 8);         // top left corner
  walls.push([54, 14, 546, 14]);                      // the top
  arc(546, 60, 46, Math.PI * 1.5, Math.PI * 2, 8);    // top right corner
  walls.push([592, 60, 592, 766]);                    // right wall (the lane's outer side)
  walls.push([540, 70, 540, 766]);                    // the lane's divider
  walls.push([540, 766, 592, 766]);                   // the lane's floor
  for (i = 0; i < 16; i++) { walls.push([slots[i].xl, RIM_Y, slots[i].xl, SLOT_BOTTOM]); walls.push([slots[i].xr, RIM_Y, slots[i].xr, SLOT_BOTTOM]); walls.push([slots[i].xl, SLOT_BOTTOM, slots[i].xr, SLOT_BOTTOM]); }

  return { W: W, H: H, BALL_R: BALL_R, PEG_R: PEG_R, GRAVITY: GRAVITY, FPS: FPS, V_MIN: V_MIN, V_MAX: V_MAX, LANE: LANE, RIM_Y: RIM_Y, SLOT_BOTTOM: SLOT_BOTTOM, SLOT_W: SLOT_W, slots: slots, pegs: pegs, walls: walls, baskets: baskets, BK: BK, basketWalls: basketWalls, BASKET_NEAR: 26 };
});
