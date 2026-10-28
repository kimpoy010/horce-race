/*
 * Angled horse sprites for the curve (45 degrees, straight on, 45 degrees the other way).
 * A small solid model of the horse is turned to the wanted angle and rendered to a pixel sprite with flat
 * flat colours and black contours, to match the traced side-view sprites in horses.js.
 * Sprites are cached and can be pre-built in the background with HorseSprites.warm().
 */
(function () {
  'use strict';
  var HS = window.HorseSprites, PAL = HS.COLORS;
  var TW = 100, TH = 92, TOX = 50, TOY = 78, SCALE = 1.38, PITCH = 0.36, H = 0.3, FRAMES = 12;
  var DIGITS = {
    1: ['..#..', '.##..', '..#..', '..#..', '..#..', '..#..', '.###.'],
    2: ['.###.', '#...#', '....#', '...#.', '..#..', '.#...', '#####'],
    3: ['.###.', '#...#', '....#', '..##.', '....#', '#...#', '.###.'],
    4: ['...#.', '..##.', '.#.#.', '#..#.', '#####', '...#.', '...#.'],
    5: ['#####', '#....', '####.', '....#', '....#', '#...#', '.###.'],
    6: ['.###.', '#....', '#....', '####.', '#...#', '#...#', '.###.']
  };
  var LIGHT = (function () { var l = [-0.35, 0.8, 0.5], n = Math.sqrt(l[0] * l[0] + l[1] * l[1] + l[2] * l[2]); return [l[0] / n, l[1] / n, l[2] / n]; })();

  function hex(h) { return [parseInt(h.substr(1, 2), 16), parseInt(h.substr(3, 2), 16), parseInt(h.substr(5, 2), 16)]; }
  function mix(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; }


  /* ---------- solid model ---------- */
  function Model(no) { this.no = no; this.v = []; }
  // voxel: x y z nx ny nz colour group
  Model.prototype.ellipsoid = function (c, r, col, grp, cut) {
    for (var x = c[0] - r[0]; x <= c[0] + r[0]; x += H) for (var y = c[1] - r[1]; y <= c[1] + r[1]; y += H) for (var z = c[2] - r[2]; z <= c[2] + r[2]; z += H) {
      var dx = (x - c[0]) / r[0], dy = (y - c[1]) / r[1], dz = (z - c[2]) / r[2];
      if (dx * dx + dy * dy + dz * dz > 1) continue;
      if (cut && y < cut) continue;
      var nx = dx / r[0], ny = dy / r[1], nz = dz / r[2], l = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
      this.v.push(x, y, z, nx / l, ny / l, nz / l, col, grp);
    }
  };
  Model.prototype.capsule = function (a, b, ra, rb, col, grp) {
    var ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], len2 = ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2] || 1, R = Math.max(ra, rb);
    var x0 = Math.min(a[0], b[0]) - R, x1 = Math.max(a[0], b[0]) + R, y0 = Math.min(a[1], b[1]) - R, y1 = Math.max(a[1], b[1]) + R;
    var z0 = Math.min(a[2], b[2]) - R, z1 = Math.max(a[2], b[2]) + R;
    for (var x = x0; x <= x1; x += H) for (var y = y0; y <= y1; y += H) for (var z = z0; z <= z1; z += H) {
      var t = ((x - a[0]) * ab[0] + (y - a[1]) * ab[1] + (z - a[2]) * ab[2]) / len2; t = t < 0 ? 0 : t > 1 ? 1 : t;
      var qx = x - (a[0] + ab[0] * t), qy = y - (a[1] + ab[1] * t), qz = z - (a[2] + ab[2] * t), r = ra + (rb - ra) * t, d = Math.sqrt(qx * qx + qy * qy + qz * qz);
      if (d > r) continue;
      var l = d || 1; this.v.push(x, y, z, qx / l, qy / l, qz / l, col, grp);
    }
  };
  Model.prototype.box = function (x0, x1, y0, y1, z0, z1, colFn, grp, nrm) {
    for (var x = x0; x <= x1; x += H) for (var y = y0; y <= y1; y += H) for (var z = z0; z <= z1; z += H) {
      this.v.push(x, y, z, nrm[0], nrm[1], nrm[2], colFn(x, y), grp);
    }
  };

  // colour ids
  var C_COAT = 0, C_SOCK = 1, C_HOOF = 2, C_SILK = 3, C_CAP = 4, C_SKIN = 5, C_CLOTH = 6, C_DIGIT = 7, C_MUZZLE = 8, C_MANE = 9, C_PANTS = 10, C_BOOT = 11, C_EYE = 12;
  var C_WHITE = 13, C_STRIPE = 14, C_LENS = 15, C_REIN = 16, C_TACK = 17, C_METAL = 18, C_INNER = 19;

  // A model is tens of MB of voxels, so it is NOT kept: getTurn() builds one, draws its three angled sprites from it and drops it
  // (keeping all 72 of them used about 2.4 GB and made phones kill the page).
  function buildModel(no, step, standing) {
    var m = new Model(no);
    var gp = window.HorseGait.pose(step / FRAMES), bob = standing ? 0 : 1.1 * gp.lift;     // the gallop of the reference sheet: see gait.js
    var legs = standing ? { fn: [0, 0], ff: [-0.05, -0.05], hn: [0.05, 0.05], hf: [-0.05, -0.05] } : { fn: gp.fn, ff: gp.ff, hn: gp.hn, hf: gp.hf };
    var b = bob;
    // legs: groups 2 (+z side) and 3 (-z side): thigh/forearm, knee, cannon, sock, fetlock, hoof
    function leg(hx, hy, hz, ang, grp, thick, hind) {
      var st = ang[2] || 1, L1 = 8.6 * st, L2 = 9.6 * st, k = [hx + L1 * Math.sin(ang[0]), hy - L1 * Math.cos(ang[0]), hz], f = [k[0] + L2 * Math.sin(ang[1]), k[1] - L2 * Math.cos(ang[1]), hz];
      var mid = [k[0] + (f[0] - k[0]) * 0.34, k[1] + (f[1] - k[1]) * 0.34, hz], sk = [k[0] + (f[0] - k[0]) * 0.9, k[1] + (f[1] - k[1]) * 0.9, hz];
      var col = grp === 3 ? C_MUZZLE : C_COAT;                                                // the far legs take the accent colour, like the reference
      m.capsule([hx, hy, hz], k, thick * 0.62, 1.05, col, grp);                                  // wide thigh / forearm narrowing to the knee
      if (hind) m.ellipsoid([hx - 0.5, hy + 1.2, hz * 1.08], [2.4, 3.6, 1.8], col, grp);      // thigh muscle
      else m.ellipsoid([hx + 0.4, hy + 0.6, hz * 1.04], [2.1, 3.1, 1.7], col, grp);           // forearm muscle
      m.ellipsoid(k, [1.15, 1.15, 1.15], col, grp);                                              // knee / hock
      m.capsule(k, f, 0.8, 0.9, col, grp);                                                  // slim lower leg
      m.capsule(f, [f[0] + Math.sin(ang[1]) * 1.4, f[1] - 1.8, hz], 1.05, 1.2, C_HOOF, grp);   // dark hoof, a little wider than the leg
    }
    var hy = 18.4 + b;
    if (!standing) {                                              // planted legs are lengthened so the hoof reaches the ground
      var sinT = Math.sin(gp.pitch * 0.5);
      [['fn', 10], ['ff', 10], ['hn', -10], ['hf', -10]].forEach(function (q) { legs[q[0]] = [legs[q[0]][0], legs[q[0]][1], window.HorseGait.stretch(legs[q[0]], hy + q[1] * sinT - 0.2, 8.6, 9.6)]; });
    }
    leg(10, hy, 3.8, legs.fn, 2, 2.9, false); leg(10, hy, -3.8, legs.ff, 3, 2.9, false);
    leg(-10, hy + 0.2, 3.9, legs.hn, 2, 3.1, true); leg(-10, hy + 0.2, -3.9, legs.hf, 3, 3.1, true);

    // barrel, chest, haunches, withers
    m.ellipsoid([0, 23 + b, 0], [15, 6.8, 6.6], C_COAT, 0);
    m.ellipsoid([10, 22 + b, 0], [7.5, 7.6, 6.4], C_COAT, 0);
    m.ellipsoid([-10, 22.5 + b, 0], [7, 7.6, 6.6], C_COAT, 0);
    m.ellipsoid([6, 28.8 + b, 0], [4.2, 2.4, 3.4], C_COAT, 0);
    // neck with a mane ridge, head with cheek, muzzle, nostrils, ears, bridle
    m.capsule([12, 26 + b, 0], [20.5, 36.5 + b, 0], 4.2, 3.0, C_COAT, 0);
    m.capsule([11, 30.2 + b, 0], [19.8, 39.8 + b, 0], 1.7, 1.3, C_MANE, 0);
    m.capsule([20.5, 36.5 + b, 0], [28.5, 32.5 + b, 0], 3.0, 2.4, C_COAT, 0);
    [1, -1].forEach(function (s) { m.ellipsoid([24.2, 34.8 + b, s * 1.7], [2.2, 1.9, 1.2], C_COAT, 0); });
    m.capsule([28.5, 32.5 + b, 0], [31.4, 31.4 + b, 0], 2.3, 2.1, C_MUZZLE, 0);
    m.capsule([22.6, 38.0 + b, 0], [24.6, 37.6 + b, 0], 1.0, 1.0, C_MANE, 0);                // forelock
    [1, -1].forEach(function (s) {
      m.capsule([20, 38.2 + b, s * 1.6], [20.6, 41.6 + b, s * 1.4], 1.05, 0.7, C_COAT, 0);
      m.capsule([20.2, 38.6 + b, s * 1.55], [20.6, 41.0 + b, s * 1.4], 0.5, 0.4, C_INNER, 0);
      m.ellipsoid([25.8, 35.5 + b, s * 2.65], [1.0, 1.0, 0.7], C_EYE, 0);
      m.ellipsoid([31.6, 31.9 + b, s * 1.15], [0.7, 0.6, 0.6], C_EYE, 0);                      // nostril
    });
    m.capsule([28.4, 32.6 + b, -2.6], [28.4, 32.6 + b, 2.6], 0.55, 0.55, C_TACK, 0);            // noseband
    // tail: a fan of strands
    [[-1.4, 0], [0, 0], [1.4, 0.4]].forEach(function (t) {
      m.capsule([-15, 25 + b, t[0] * 0.5], [-21.5, 22 + b, t[0]], 1.5, 1.5, C_COAT, 0);
      m.capsule([-21.5, 22 + b, t[0]], [-25.5 - t[1], 13 + b, t[0] * 2.0], 1.5, 0.8, C_COAT, 0);
    });
    m.capsule([-23.4, 17 + b, 0], [-25.8, 12.4 + b, 0], 1.0, 0.7, C_MANE, 0);
    // saddle cloth on both flanks with the number, saddle pad edge and girth strap
    var gl = DIGITS[m.no];
    [1, -1].forEach(function (side) {
      m.box(-6, 3.2, 21.2 + b, 30.6 + b, Math.min(side * 6.5, side * 7.2), Math.max(side * 6.5, side * 7.2), function (x, y) {
        var c = Math.floor((x + 4.6) / 1.2), r = Math.floor((30.0 + b - y) / 1.2);
        if (side < 0) c = 4 - c;
        if (c >= 0 && c < 5 && r >= 0 && r < 7 && gl[r][c] === '#') return C_DIGIT;
        if (y < 22.0 + b || x < -5.3 || x > 2.5) return C_STRIPE;
        return C_CLOTH;
      }, 4, [0, 0, side]);
      m.capsule([4.6, 29 + b, side * 6.3], [4.6, 17.5 + b, side * 6.4], 0.55, 0.55, C_TACK, 0);   // girth
    });
    m.ellipsoid([-1.4, 30.4 + b, 0], [5.4, 1.4, 3.6], C_TACK, 0);                                  // saddle
    // jockey: boots with stirrups, white breeches, striped silks, sleeves, gloves, goggles, helmet, reins, whip
    [2.4, -2.4].forEach(function (z) {
      m.capsule([-2, 30.2 + b, z], [3.6, 28.4 + b, z * 1.5], 2.0, 1.8, C_PANTS, 1);
      m.capsule([3.6, 28.4 + b, z * 1.6], [2.6, 22.6 + b, z * 1.7], 1.3, 1.2, C_BOOT, 1);
      m.capsule([2.6, 22.2 + b, z * 1.75], [2.6, 20.6 + b, z * 1.75], 1.5, 1.5, C_METAL, 1);       // stirrup iron
    });
    m.capsule([-3.5, 31 + b, 0], [0.4, 33.6 + b, 0], 3.9, 3.8, C_SILK, 1);
    m.capsule([0.4, 33.6 + b, 0], [2.6, 35 + b, 0], 3.85, 3.7, C_STRIPE, 1);
    m.capsule([2.6, 35 + b, 0], [5, 37.2 + b, 0], 3.7, 3.4, C_SILK, 1);
    m.ellipsoid([5.2, 37.4 + b, 0], [2.0, 1.4, 2.2], C_STRIPE, 1);                                   // collar
    [3.8, -3.8].forEach(function (z) {
      m.capsule([5, 36.6 + b, z], [9.2, 34.2 + b, z * 0.88], 1.5, 1.4, C_SILK, 6);
      m.capsule([9.2, 34.2 + b, z * 0.88], [11.2, 32.9 + b, z * 0.8], 1.45, 1.4, C_STRIPE, 6);   // cuff
      m.ellipsoid([12.3, 32.1 + b, z * 0.8], [1.4, 1.4, 1.4], C_WHITE, 6);                       // glove
      m.capsule([12.3, 32.1 + b, z * 0.8], [27.6, 33.2 + b, z * 0.65], 0.3, 0.3, C_BOOT, 6);   // rein to the bit
    });
    m.ellipsoid([9.4, 39.2 + b, 0], [2.9, 2.9, 2.8], C_SKIN, 5);
    m.ellipsoid([11.9, 38.6 + b, 0], [1.0, 1.1, 0.9], C_SKIN, 5);                                    // nose
    m.capsule([10.6, 40.0 + b, -2.7], [10.6, 40.0 + b, 2.7], 0.75, 0.75, C_REIN, 5);                  // goggle strap
    [1.2, -1.2].forEach(function (z) { m.ellipsoid([11.0, 40.0 + b, z], [1.0, 1.0, 1.1], C_LENS, 5); });
    m.ellipsoid([8.7, 41.0 + b, 0], [3.6, 3.1, 3.6], C_CAP, 5, 40.6 + b);
    m.capsule([5.6, 41.4 + b, 0], [11.4, 43.6 + b, 0], 0.5, 0.5, C_STRIPE, 5);                        // helmet ridge
    m.capsule([11.2, 40.9 + b, 0], [14.0, 40.1 + b, 0], 1.0, 0.7, C_CAP, 5);                          // peak
    m.capsule([6.4, 40.5 + b, -3.1], [8.6, 37.7 + b, -2.4], 0.3, 0.3, C_REIN, 5);                      // chin strap
    m.v = new Float64Array(m.v);
    return m;
  }

  /* ---------- rendering ---------- */
  function render(no, step, standing, angDeg, m) {
    var P = PAL[no], v = m.v, n = v.length / 8;
    var th = standing ? 0 : window.HorseGait.pose(step / FRAMES).pitch * 0.5, ct = Math.cos(th), stp = Math.sin(th);      // body pitch around the middle of the back
    var phiA = angDeg * Math.PI / 180, ca = Math.cos(phiA), sa = Math.sin(phiA), cp = Math.cos(PITCH), sp = Math.sin(PITCH);
    var zb = new Float32Array(TW * TH).fill(-1e9), id = new Int16Array(TW * TH).fill(-1), grp = new Int8Array(TW * TH), tone = new Uint8Array(TW * TH).fill(1);
    for (var i = 0; i < n; i++) {
      var o = i * 8, x0 = v[o], y0 = v[o + 1] - 20, z = v[o + 2], x = x0 * ct - y0 * stp, y = 20 + x0 * stp + y0 * ct;
      var X = x * ca - z * sa, Z = x * sa + z * ca;
      var px = Math.round(TOX + X * SCALE), py = Math.round(TOY + (-y * cp + Z * sp) * SCALE);
      if (px < 0 || py < 0 || px >= TW || py >= TH) continue;
      var d = Z * cp + y * sp, k = py * TW + px;
      if (d <= zb[k]) continue;
      zb[k] = d; id[k] = v[o + 6]; grp[k] = v[o + 7];
      var nx0 = v[o + 3], ny = nx0 * stp + v[o + 4] * ct, nxp = nx0 * ct - v[o + 4] * stp;
      var nx = nxp * ca - v[o + 5] * sa, nz = nxp * sa + v[o + 5] * ca;
      var vy = ny * cp - nz * sp, vz = ny * sp + nz * cp; // view-space normal (y up, z towards the camera)
      var I = nx * LIGHT[0] + vy * LIGHT[1] + vz * LIGHT[2];
      tone[k] = (I < 0.05 || vy < -0.55) ? 0 : I > 0.74 ? 2 : 1;
    }
    var cols = [P.coat, P.coat, '#000000', P.silk, P.silk, P.skin, P.tag, '#000000', P.accent, P.coat, '#ffffff', '#2a1c14', '#000000',
      '#ffffff', '#ffffff', '#bfe4ff', '#3a2414', '#5a3a22', '#c8ccd8', '#e8a0a0'].map(hex);
    var shd = hex(P.coat), cv = document.createElement('canvas'); cv.width = TW; cv.height = TH;
    var g = cv.getContext('2d'), img = g.createImageData(TW, TH), d8 = img.data, x2, y2, k2;
    function put(k, c) { d8[k * 4] = c[0]; d8[k * 4 + 1] = c[1]; d8[k * 4 + 2] = c[2]; d8[k * 4 + 3] = 255; }
    for (k2 = 0; k2 < TW * TH; k2++) {
      if (id[k2] < 0) continue;
      var c = cols[id[k2]], t = tone[k2], fixed = id[k2] === C_DIGIT || id[k2] === C_EYE || id[k2] === C_LENS;
            put(k2, c);
    }
    // contours: black outside the silhouette and where one part passes in front of another; a soft darker
    // line where a limb overlaps the body (so the legs still flow out of it)
    var black = [0, 0, 0], mark = [], soft = [], NX = [-1, 1, 0, 0], NY = [0, 0, -1, 1];
    for (y2 = 0; y2 < TH; y2++) for (x2 = 0; x2 < TW; x2++) {
      k2 = y2 * TW + x2;
      for (var q = 0; q < 4; q++) {
        var qx = x2 + NX[q], qy = y2 + NY[q];
        if (qx < 0 || qy < 0 || qx >= TW || qy >= TH) continue;
        var kq = qy * TW + qx;
        if (id[k2] < 0 && id[kq] >= 0) { mark.push(k2); break; }
        if (id[k2] < 0 || id[kq] < 0 || id[kq] === C_DIGIT) continue;
        var dz = zb[kq] - zb[k2], big = (grp[kq] >= 5 || grp[k2] >= 5) ? 0.8 : 4.5;
        if (grp[kq] !== grp[k2] && dz > big) { mark.push(k2); break; }
        if (id[kq] !== id[k2] && dz > 1.6 && id[k2] !== C_DIGIT) { soft.push(k2); break; }
      }
    }
    
    mark.forEach(function (k) { put(k, black); });
    g.putImageData(img, 0, 0);
    return cv;
  }

  var cache = {};
  function buildTurns(no, step, standing) {
    var m = buildModel(no, step, standing), idx, key;
    for (idx = 1; idx <= 3; idx++) {
      key = no + ':' + idx + ':' + (standing ? 's' : step);
      if (!cache[key]) cache[key] = render(no, step, standing, idx * 45, m);
    }
  }
  // angle index: 1 = 45 deg facing right (towards the camera), 2 = straight on, 3 = 45 deg facing left
  function getTurn(no, idx, phase, standing) {
    var step = standing ? 0 : Math.floor(phase / (Math.PI * 2) * FRAMES) % FRAMES;
    if (step < 0) step += FRAMES;
    var key = no + ':' + idx + ':' + (standing ? 's' : step);
    if (!cache[key]) buildTurns(no, step, standing);
    return cache[key];
  }
  // builds every turning sprite a little at a time so the first curve does not stutter: one step per tick (the model of a pose, then each of its three
  // sprites), so no single pause is long on a phone. The model is dropped as soon as its three sprites exist.
  function warm() {
    var jobs = [], no, st, cur = null, idx = 1, m = null;
    for (st = 0; st < FRAMES; st++) for (no = 1; no <= 6; no++) jobs.push([no, st]);
    (function next() {
      if (!cur) { cur = jobs.shift(); if (!cur) return; idx = 1; m = null; }
      var key = cur[0] + ':' + idx + ':' + cur[1];
      if (!cache[key]) {
        if (!m) m = buildModel(cur[0], cur[1], false);
        else cache[key] = render(cur[0], cur[1], false, idx * 45, m), idx++;
      } else idx++;
      if (idx > 3) { cur = null; m = null; }
      setTimeout(next, 40);
    })();
  }

  HS.getTurn = getTurn; HS.warm = warm; HS.TURN = { W: TW, H: TH, OX: TOX, OY: TOY };
})();
