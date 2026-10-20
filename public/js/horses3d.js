/*
 * Angled horse sprites for the curve (45 degrees, straight on, 45 degrees the other way).
 * A small solid model of the horse is turned to the wanted angle and rendered to a pixel sprite with flat
 * colours, two-tone shading and black contours, to match the traced side-view sprites in horses.js.
 * Sprites are cached and can be pre-built in the background with HorseSprites.warm().
 */
(function () {
  'use strict';
  var HS = window.HorseSprites, PAL = HS.COLORS;
  var TW = 100, TH = 92, TOX = 50, TOY = 78, SCALE = 1.38, PITCH = 0.36, H = 0.4, FRAMES = 6;
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

  // legs as in the side view: theta 0 = leg forward at the start of stance, pi = fully back, then folded swing
  function legAngles(theta, hind) {
    var a1 = 0.62 * Math.cos(theta) - (hind ? 0.1 : 0), swing = Math.max(0, -Math.sin(theta));
    var flex = swing * (hind ? 0.95 : 1.1);
    return [a1, a1 - flex + (hind ? 0.12 : 0.05)];
  }

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

  var models = {};
  function buildModel(no, step, standing) {
    var key = no + ':' + (standing ? 's' : step), m = models[key];
    if (m) return m;
    m = new Model(no);
    var phi = step / FRAMES * Math.PI * 2, bob = standing ? 0 : 0.9 * Math.abs(Math.sin(phi * 0.5 + 0.4));
    var legs = standing ? { fn: [0, 0], ff: [-0.05, -0.05], hn: [0.05, 0.05], hf: [-0.05, -0.05] } : {
      fn: legAngles(phi, false), ff: legAngles(phi + 0.7, false), hn: legAngles(phi + Math.PI * 0.85, true), hf: legAngles(phi + Math.PI * 0.85 + 0.7, true)
    };
    // legs: groups 2 (+z side) and 3 (-z side)
    function leg(hx, hy, hz, ang, grp, thick) {
      var L1 = 8.6, L2 = 9.6, k = [hx + L1 * Math.sin(ang[0]), hy - L1 * Math.cos(ang[0]), hz], f = [k[0] + L2 * Math.sin(ang[1]), k[1] - L2 * Math.cos(ang[1]), hz];
      var mid = [k[0] + (f[0] - k[0]) * 0.34, k[1] + (f[1] - k[1]) * 0.34, hz];
      m.capsule([hx, hy, hz], k, thick, 1.9, C_COAT, grp);
      m.capsule(k, mid, 1.7, 1.6, C_COAT, grp);
      m.capsule(mid, f, 1.75, 1.7, C_SOCK, grp);
      m.capsule(f, [f[0] + Math.sin(ang[1]) * 1.3, f[1] - 1.3, hz], 1.9, 1.9, C_HOOF, grp);
    }
    var hy = 18.4;
    leg(10, hy, 3.8, legs.fn, 2, 2.9); leg(10, hy, -3.8, legs.ff, 3, 2.9);
    leg(-10, hy + 0.2, 3.9, legs.hn, 2, 3.1); leg(-10, hy + 0.2, -3.9, legs.hf, 3, 3.1);
    var b = bob;
    // body, neck, head, tail
    m.ellipsoid([0, 23 + b, 0], [15, 6.8, 6.6], C_COAT, 0);
    m.ellipsoid([10, 22 + b, 0], [7.5, 7.6, 6.4], C_COAT, 0);
    m.ellipsoid([-10, 22.5 + b, 0], [7, 7.6, 6.6], C_COAT, 0);
    m.capsule([12, 26 + b, 0], [20.5, 36.5 + b, 0], 4.2, 3.0, C_COAT, 0);
    m.capsule([11, 30 + b, 0], [19.5, 39.5 + b, 0], 1.5, 1.2, C_MANE, 0);
    m.capsule([20.5, 36.5 + b, 0], [28.5, 32.5 + b, 0], 3.0, 2.4, C_COAT, 0);
    m.capsule([28.5, 32.5 + b, 0], [31.2, 31.4 + b, 0], 2.3, 2.1, C_MUZZLE, 0);
    [1.6, -1.6].forEach(function (z) { m.capsule([20, 38.2 + b, z], [20.6, 41.4 + b, z * 0.9], 1.0, 0.7, C_COAT, 0); m.ellipsoid([25.6, 35.4 + b, z * 1.55], [0.9, 0.9, 0.7], C_EYE, 0); });
    m.capsule([-15, 25 + b, 0], [-21.5, 22 + b, 0], 1.9, 1.8, C_COAT, 0);
    m.capsule([-21.5, 22 + b, 0], [-25.5, 13.5 + b, 0], 1.8, 1.0, C_COAT, 0);
    // saddle cloth on both flanks, number on the outside
    var gl = DIGITS[m.no];
    [1, -1].forEach(function (side) {
      m.box(-6, 3.2, 21.2 + b, 30.6 + b, Math.min(side * 6.5, side * 7.2), Math.max(side * 6.5, side * 7.2), function (x, y) {
        var c = Math.floor((x + 4.6) / 1.2), r = Math.floor((30.0 + b - y) / 1.2);
        if (side < 0) c = 4 - c;
        return (c >= 0 && c < 5 && r >= 0 && r < 7 && gl[r][c] === '#') ? C_DIGIT : C_CLOTH;
      }, 4, [0, 0, side]);
    });
    // jockey, crouched over the neck
    [2.4, -2.4].forEach(function (z) {
      m.capsule([-2, 30.2 + b, z], [3.6, 28.4 + b, z * 1.5], 2.0, 1.8, C_PANTS, 1);
      m.capsule([3.6, 28.4 + b, z * 1.6], [2.6, 22.6 + b, z * 1.7], 1.3, 1.2, C_BOOT, 1);
    });
    m.capsule([-3.5, 31 + b, 0], [5, 37.2 + b, 0], 3.9, 3.4, C_SILK, 1);
    [3.8, -3.8].forEach(function (z) {
      m.capsule([5, 36.6 + b, z], [12, 32.2 + b, z * 0.8], 1.4, 1.3, C_SILK, 6);
      m.ellipsoid([12.5, 31.8 + b, z * 0.8], [1.3, 1.3, 1.3], C_SKIN, 6);
    });
    m.ellipsoid([9.4, 39.4 + b, 0], [2.9, 2.9, 2.9], C_SKIN, 5);
    m.ellipsoid([8.7, 40.8 + b, 0], [3.5, 3.0, 3.5], C_CAP, 5, 40.4 + b);
    m.capsule([11.2, 40.7 + b, 0], [13.6, 40.0 + b, 0], 0.9, 0.7, C_CAP, 5);
    models[key] = m;
    return m;
  }

  /* ---------- rendering ---------- */
  function render(no, step, standing, angDeg) {
    var P = PAL[no], m = buildModel(no, step, standing), v = m.v, n = v.length / 8;
    var phiA = angDeg * Math.PI / 180, ca = Math.cos(phiA), sa = Math.sin(phiA), cp = Math.cos(PITCH), sp = Math.sin(PITCH);
    var zb = new Float32Array(TW * TH).fill(-1e9), id = new Int16Array(TW * TH).fill(-1), grp = new Int8Array(TW * TH), shade = new Uint8Array(TW * TH);
    for (var i = 0; i < n; i++) {
      var o = i * 8, x = v[o], y = v[o + 1], z = v[o + 2];
      var X = x * ca - z * sa, Z = x * sa + z * ca;
      var px = Math.round(TOX + X * SCALE), py = Math.round(TOY + (-y * cp + Z * sp) * SCALE);
      if (px < 0 || py < 0 || px >= TW || py >= TH) continue;
      var d = Z * cp + y * sp, k = py * TW + px;
      if (d <= zb[k]) continue;
      zb[k] = d; id[k] = v[o + 6]; grp[k] = v[o + 7];
      var nx = v[o + 3] * ca - v[o + 5] * sa, nz = v[o + 3] * sa + v[o + 5] * ca, ny = v[o + 4];
      var vy = ny * cp - nz * sp, vz = ny * sp + nz * cp; // view-space normal (y up, z towards the camera)
      shade[k] = (nx * LIGHT[0] + vy * LIGHT[1] + vz * LIGHT[2]) < 0.05 ? 1 : 0;
    }
    var cols = [P.coat, P.sock, '#10184a', P.silk, P.cap, '#f8aa8c', P.cloth, '#000000', P.muzzle, P.shade, '#ffffff', '#241810', '#000000'].map(hex);
    var shd = hex(P.shade), cv = document.createElement('canvas'); cv.width = TW; cv.height = TH;
    var g = cv.getContext('2d'), img = g.createImageData(TW, TH), d8 = img.data, x2, y2, k2;
    function put(k, c) { d8[k * 4] = c[0]; d8[k * 4 + 1] = c[1]; d8[k * 4 + 2] = c[2]; d8[k * 4 + 3] = 255; }
    for (k2 = 0; k2 < TW * TH; k2++) {
      if (id[k2] < 0) continue;
      var c = cols[id[k2]];
      if (shade[k2] && id[k2] !== C_DIGIT && id[k2] !== C_EYE) c = id[k2] === C_COAT ? mix(c, shd, 0.32) : [c[0] * 0.78, c[1] * 0.78, c[2] * 0.78];
      put(k2, c);
    }
    // contours: outside the silhouette, and on the far side where one part passes in front of another
    var black = [0, 0, 0], mark = [];
    for (y2 = 0; y2 < TH; y2++) for (x2 = 0; x2 < TW; x2++) {
      k2 = y2 * TW + x2;
      var nb = [[x2 - 1, y2], [x2 + 1, y2], [x2, y2 - 1], [x2, y2 + 1]];
      for (var q = 0; q < 4; q++) {
        var qx = nb[q][0], qy = nb[q][1];
        if (qx < 0 || qy < 0 || qx >= TW || qy >= TH) continue;
        var kq = qy * TW + qx;
        if (id[k2] < 0 && id[kq] >= 0) { mark.push(k2); break; }
        if (id[k2] >= 0 && id[kq] >= 0 && grp[kq] !== grp[k2] && zb[kq] > zb[k2] + ((grp[kq] >= 5 || grp[k2] >= 5) ? 0.8 : 4.5) && id[kq] !== C_DIGIT) { mark.push(k2); break; }
      }
    }
    mark.forEach(function (k) { put(k, black); });
    g.putImageData(img, 0, 0);
    return cv;
  }

  var cache = {};
  // angle index: 1 = 45 deg facing right (towards the camera), 2 = straight on, 3 = 45 deg facing left
  function getTurn(no, idx, phase, standing) {
    var step = standing ? 0 : Math.floor(phase / (Math.PI * 2) * FRAMES) % FRAMES;
    if (step < 0) step += FRAMES;
    var key = no + ':' + idx + ':' + (standing ? 's' : step);
    return cache[key] || (cache[key] = render(no, step, standing, idx * 45));
  }
  // builds every turning sprite a little at a time so the first curve does not stutter
  function warm() {
    var jobs = [], no, idx, st;
    for (st = 0; st < FRAMES; st++) for (idx = 1; idx <= 3; idx++) for (no = 1; no <= 6; no++) jobs.push([no, idx, st]);
    (function next() {
      var j = jobs.shift(); if (!j) return;
      getTurn(j[0], j[1], j[2] / FRAMES * Math.PI * 2, false);
      setTimeout(next, 30);
    })();
  }

  HS.getTurn = getTurn; HS.warm = warm; HS.TURN = { W: TW, H: TH, OX: TOX, OY: TOY };
})();
