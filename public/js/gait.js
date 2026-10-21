/*
 * Horse gait: one stride of a transverse gallop as leg keyframes, shared by the side-view sprites (horses.js) and the angled 3D
 * sprites (horses3d.js). Phase 0..1 is one stride.
 *
 * A galloping horse's legs are on the ground only briefly (each hoof about a quarter of the stride) and folded up for the rest:
 *   far hind lands at 0.00, near (leading) hind 0.10, far fore 0.36, near (leading) fore 0.46, then the horse is in the air.
 * Each leg is two segments: a1 = angle of the upper part (hip to knee / hock), a2 = angle of the lower part (cannon), measured
 * from straight down, positive = forward. keyframes: [phase of the leg (0 = touchdown), a1, a2].
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.HorseGait = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var KF = {
    fore: [
      [0.00, 0.62, 0.50],     // lands reaching forward, leg almost straight
      [0.11, 0.10, 0.06],     // under the shoulder, body vaults over the planted leg
      [0.22, -0.42, -0.55],   // pushes off behind the body, heel lifts
      [0.34, -0.10, -1.55],   // leaves the ground, knee bends and the cannon folds up
      [0.46, 0.22, -1.95],    // fully folded, hoof tucked behind the forearm
      [0.60, 0.46, -1.25],    // forearm swings forward, starts to unfold
      [0.76, 0.72, 0.05],     // reaching out in the air
      [0.90, 0.80, 0.50]      // fully extended, about to land
    ],
    hind: [
      [0.00, 0.48, -0.05],    // lands under the belly
      [0.13, -0.06, -0.14],   // under the hip
      [0.26, -0.72, -0.95],   // drives off behind the body, leg extended
      [0.40, -0.62, -1.75],   // leaves the ground, hock folds
      [0.55, -0.20, -1.85],   // swings forward folded
      [0.70, 0.30, -1.30],
      [0.85, 0.52, -0.45]     // reaching under the belly again
    ]
  };
  var STANCE = { fore: 0.22, hind: 0.26 };               // share of the stride a hoof is on the ground
  var LAND = { hf: 0.00, hn: 0.10, ff: 0.36, fn: 0.46 };  // touchdown of every leg
  var R1 = 0.475;                                         // upper segment / whole leg (both sprite models are about this)

  // cyclic cubic Hermite through the keyframes (smooth, no stops at the keyframes)
  function sample(kf, p) {
    var n = kf.length;
    p -= Math.floor(p);
    var T = function (j) { return kf[((j % n) + n) % n][0] + Math.floor(j / n); };
    var Y = function (j, c) { return kf[((j % n) + n) % n][c]; };
    var i = n - 1;
    for (var k = 0; k < n - 1; k++) if (p < kf[k + 1][0]) { i = k; break; }
    var h = T(i + 1) - T(i), t = (p - T(i)) / h, t2 = t * t, t3 = t2 * t, out = [];
    for (var c = 1; c <= 2; c++) {
      var m0 = (Y(i + 1, c) - Y(i - 1, c)) / (T(i + 1) - T(i - 1)) * h, m1 = (Y(i + 2, c) - Y(i, c)) / (T(i + 2) - T(i)) * h;
      out.push((2 * t3 - 3 * t2 + 1) * Y(i, c) + (t3 - 2 * t2 + t) * m0 + (-2 * t3 + 3 * t2) * Y(i + 1, c) + (t3 - t2) * m1);
    }
    return out;
  }

  // a leg at its own phase p: [a1, a2, stretch]. While the hoof is on the ground the leg is lengthened a little so the hoof really
  // touches the ground (an angled straight leg is shorter than a vertical one).
  function leg(hind, p) {
    var kf = hind ? KF.hind : KF.fore, a = sample(kf, p), end = hind ? STANCE.hind : STANCE.fore;
    p -= Math.floor(p);
    var w = p < end ? 1 : p < end + 0.05 ? 1 - (p - end) / 0.05 : p > 0.94 ? (p - 0.94) / 0.06 : 0;      // eases in just before the hoof lands, out after push-off
    var k = 1 / (R1 * Math.cos(a[0]) + (1 - R1) * Math.cos(a[1]));
    return [a[0], a[1], 1 + Math.min(0.16, Math.max(0, k - 1)) * w];
  }

  // cycle: 0..1 position in the stride -> all four legs and the body lift in sprite units (0 = lowest)
  function pose(cycle) {
    var c = cycle - Math.floor(cycle);
    return {
      hf: leg(true, c - LAND.hf), hn: leg(true, c - LAND.hn), ff: leg(false, c - LAND.ff), fn: leg(false, c - LAND.fn),
      lift: 0.5 + 0.5 * Math.cos(2 * Math.PI * (c - 0.02))          // highest in the air as the hind legs land, lowest over the planted forelegs
    };
  }

  return { pose: pose, leg: leg, KF: KF, STANCE: STANCE, LAND: LAND };
});
