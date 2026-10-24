/*
 * Horse gait: one gallop stride as 12 key poses read from an animation reference sheet (frames 1 to 12), shared by the side-view
 * sprites (horses.js) and the angled curve sprites.
 *
 * Every leg has two segments: a1 = angle of the upper part (hip to knee / hock), a2 = angle of the lower part (cannon), both
 * measured from straight down, positive = forward. Per frame: [a1, a2, plant] where plant 1 = the hoof is on the ground.
 *   hn / hf = near / far hind leg, fn / ff = near / far foreleg.
 * The reference stride: forelegs planted and hind legs pushing off (frames 12 to 2), hind legs fold high behind (3 and 4), forelegs push
 * off (5 and 6), then the gathered flight with the hind legs swung forward under the belly and the forelegs tucked (7 to 9), and the
 * forelegs reach out again (10 and 11) while the hind legs land.
 * Between the key poses the movement is a smooth cyclic spline.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.HorseGait = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var FRAMES = 12;
  var KEY = {
    //        1                    2                    3                    4                    5                    6
    hn: [[-0.12, -0.12, 1], [-0.25, -0.30, 1], [-0.60, -1.20, 0], [-0.80, -1.80, 0], [-0.35, -1.10, 0], [-0.10, -0.90, 0],
    //        7                    8                    9                    10                   11                   12
         [0.35, 0.05, 0],    [0.40, 0.40, 0],    [0.35, 0.55, 0],    [0.55, 0.45, 0],    [0.00, 0.00, 1],    [-0.05, -0.05, 1]],
    hf: [[-0.50, -1.40, 0], [-0.85, -1.50, 0], [-0.90, -1.90, 0], [-0.70, -1.80, 0], [-0.15, -0.90, 0], [0.05, -0.50, 0],
         [0.30, 0.20, 0],    [0.45, 0.55, 0],    [0.50, 0.45, 0],    [0.05, 0.00, 0],    [-0.35, -0.45, 1],  [-0.80, -1.20, 0]],
    fn: [[0.25, 0.25, 1],   [-0.05, -0.05, 1],  [0.00, 0.00, 1],    [0.00, 0.05, 1],    [-0.10, -0.10, 1],  [-0.50, -0.50, 1],
         [0.60, -1.20, 0],   [0.80, -1.00, 0],   [0.50, 0.10, 0],    [0.60, 0.30, 0],    [0.95, 0.80, 0],    [0.25, 0.25, 1]],
    ff: [[0.90, 0.90, 0],   [0.85, 0.85, 1],    [0.50, -0.90, 0],   [0.70, -1.30, 0],   [0.60, -1.57, 0],   [0.50, -1.20, 0],
         [0.90, -1.00, 0],   [0.70, -1.50, 0],   [0.30, -1.57, 0],   [0.50, -0.70, 0],   [1.00, -1.20, 0],   [1.20, 0.00, 0]]
  };
  // body: nose-up pitch in radians (the sprites use half of it) and lift above the lowest point (0 to 1), per frame
  var PITCH = [0.00, -0.03, -0.03, 0.05, 0.14, 0.20, 0.14, 0.26, 0.06, 0.00, -0.06, -0.05];
  var LIFT = [0.10, 0.10, 0.20, 0.30, 0.40, 0.50, 0.70, 1.00, 0.80, 0.40, 0.10, 0.00];

  function mod(n, m) { return ((n % m) + m) % m; }
  function cr(p0, p1, p2, p3, t) {                      // Catmull-Rom
    return 0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (-p0 + 3 * p1 - 3 * p2 + p3) * t * t * t);
  }
  function at(arr, u, c) {                               // cyclic sample of column c (or of a plain number list when c is undefined)
    var i = Math.floor(u), t = u - i, v = function (j) { var x = arr[mod(j, FRAMES)]; return c === undefined ? x : x[c]; };
    return cr(v(i - 1), v(i), v(i + 1), v(i + 2), t);
  }

  // cycle 0..1 (0 = frame 1) -> the four legs [a1, a2, plant 0..1], body pitch and lift
  function pose(cycle) {
    var u = mod(cycle, 1) * FRAMES, out = {}, i = Math.floor(u), t = u - i;
    ['hn', 'hf', 'fn', 'ff'].forEach(function (k) {
      var a = KEY[k], plant = a[mod(i, FRAMES)][2] * (1 - t) + a[mod(i + 1, FRAMES)][2] * t;
      out[k] = [at(a, u, 0), at(a, u, 1), plant];
    });
    out.pitch = at(PITCH, u); out.lift = Math.max(0, Math.min(1, at(LIFT, u)));
    return out;
  }

  // how much longer a planted leg has to be for the hoof to reach the ground (the hip is hipH above it)
  function stretch(leg, hipH, L1, L2) {
    var w = leg[2];
    if (!(w > 0)) return 1;
    var need = hipH / (L1 * Math.cos(leg[0]) + L2 * Math.cos(leg[1]));
    return 1 + (Math.max(0.9, Math.min(1.3, need)) - 1) * w;
  }

  return { pose: pose, stretch: stretch, FRAMES: FRAMES, KEY: KEY, PITCH: PITCH, LIFT: LIFT };
});
