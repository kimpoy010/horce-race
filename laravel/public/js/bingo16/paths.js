/* Bingo Pinball 16: playback of the stored ball paths (paths-data.js, made by bin/bingo16-paths.cjs). The server decides where each of the 16 balls ends (a slot 1-16, or 0 = a missed ball that falls into one of the three baskets); this picks, for an
   outcome, a stored path that ends there at about the power the plunger was pulled, and says where the ball is at any moment. Nothing here decides a result. */
(function () {
  'use strict';
  var lib = window.B16_PATHS, decoded = {};

  function decode(entry) {
    if (entry._f) return entry._f;
    var bin = atob(entry.d), n = bin.length, b = new Uint8Array(n), i;
    for (i = 0; i < n; i++) b[i] = bin.charCodeAt(i);
    var i8 = function (v) { return v > 127 ? v - 256 : v; };
    var f = [[(b[0] | (b[1] << 8)) / lib.unit, (b[2] | (b[3] << 8)) / lib.unit]];
    for (i = 4; i < n; i += 2) f.push([f[f.length - 1][0] + i8(b[i]) / lib.unit, f[f.length - 1][1] + i8(b[i + 1]) / lib.unit]);
    entry._f = f;
    return f;
  }

  /** a stored path for the hole, at about this power (0..1); among equally good ones a random one, so repeated plays do not look the same */
  function pick(outcome, power, spot) {
    var list = outcome === 0 ? lib.baskets[spot] : lib.slots[outcome];             // a missed ball: the paths into the basket of that place (1-10)
    if (!list || !list.length) return null;
    var best = 9, i;
    for (i = 0; i < list.length; i++) best = Math.min(best, Math.abs(list[i].p / 100 - power));
    var near = list.filter(function (e) { return Math.abs(e.p / 100 - power) <= best + 0.07; });
    var e = near[Math.floor(Math.random() * near.length)];
    return { frames: decode(e), power: e.p / 100 };
  }

  /** the position after t seconds (a smooth curve through the stored frames) */
  function at(frames, t) {
    var f = t * lib.fps, i = Math.floor(f), u = f - i, n = frames.length;
    if (i >= n - 1) return { x: frames[n - 1][0], y: frames[n - 1][1] };
    if (i < 0) return { x: frames[0][0], y: frames[0][1] };
    var p0 = frames[Math.max(0, i - 1)], p1 = frames[i], p2 = frames[i + 1], p3 = frames[Math.min(n - 1, i + 2)];
    var u2 = u * u, u3 = u2 * u;
    function c(a, b, cc, d) { return 0.5 * ((2 * b) + (-a + cc) * u + (2 * a - 5 * b + 4 * cc - d) * u2 + (-a + 3 * b - 3 * cc + d) * u3); }
    return { x: c(p0[0], p1[0], p2[0], p3[0]), y: c(p0[1], p1[1], p2[1], p3[1]) };
  }

  function duration(frames) { return (frames.length - 1) / lib.fps; }

  /** the moments (seconds) at which the ball turns sharply: it hit a pin or a wall */
  function bounces(frames) {
    if (frames._b) return frames._b;
    var out = [], i, prev = null;
    for (i = 1; i < frames.length - 3; i++) {
      var vx = frames[i][0] - frames[i - 1][0], vy = frames[i][1] - frames[i - 1][1], sp = Math.hypot(vx, vy);
      if (prev && sp > 0.8 && prev.sp > 0.8) {
        var cos = (vx * prev.vx + vy * prev.vy) / (sp * prev.sp);
        if (cos < 0.86) out.push((i - 0.5) / lib.fps);
      }
      prev = { vx: vx, vy: vy, sp: sp };
    }
    frames._b = out;
    return out;
  }

  window.Bingo16Paths = { pick: pick, at: at, duration: duration, bounces: bounces, fps: lib.fps };
})();
