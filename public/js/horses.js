/*
 * Detailed pixel-art horses. Each frame is drawn from curved shapes with shading, then
 * posterised (hard alpha, limited colour steps) and outlined so it reads as shaded pixel art.
 * Sprites are cached per (horse, facing, gait step).
 */
(function () {
  'use strict';

  var SW = 96, SH = 72, OX = 46, OY = 62, STEPS = 12;

  var HORSE = {
    1: { coat: '#f6f6fa', hi: '#ffffff', lo: '#8c90b8', mane: '#6b6f93', line: '#2a2c58', silk: '#e22a2a', cap: '#e22a2a', stripe: '#ffffff', sock: '#2a48d8' },
    2: { coat: '#e24ac8', hi: '#ff9af0', lo: '#7a1c78', mane: '#4a1858', line: '#3a0c40', silk: '#3a5cf0', cap: '#ffe83a', stripe: '#ffffff', sock: '#ffffff' },
    3: { coat: '#e42c2c', hi: '#ff7a6a', lo: '#7a0c14', mane: '#3a0c10', line: '#3c0608', silk: '#9a9ae8', cap: '#9a9ae8', stripe: '#ffffff', sock: '#ffffff' },
    4: { coat: '#2c4ee0', hi: '#7a9aff', lo: '#10247a', mane: '#0a1038', line: '#080a44', silk: '#ff9ab8', cap: '#ff5a98', stripe: '#ffffff', sock: '#ffe83a' },
    5: { coat: '#f2e02c', hi: '#fffa8a', lo: '#9a7c08', mane: '#7a4c14', line: '#4a3600', silk: '#b05ae8', cap: '#b05ae8', stripe: '#ffffff', sock: '#ffffff' },
    6: { coat: '#1f9a5c', hi: '#5ade98', lo: '#0a4a2a', mane: '#2c1c08', line: '#06301a', silk: '#f58ac0', cap: '#e8e8f8', stripe: '#ffffff', sock: '#ffffff' }
  };
  var SKIN = '#f2b48a', SKIN_LO = '#c07c58', BOOT = '#241810';
  var DIGITS = {
    1: ['010', '110', '010', '010', '111'], 2: ['111', '001', '111', '100', '111'],
    3: ['111', '001', '111', '001', '111'], 4: ['101', '101', '111', '001', '001'],
    5: ['111', '100', '111', '001', '111'], 6: ['111', '100', '111', '101', '111']
  };

  function rgba(hex, a) {
    return 'rgba(' + parseInt(hex.substr(1, 2), 16) + ',' + parseInt(hex.substr(3, 2), 16) + ',' + parseInt(hex.substr(5, 2), 16) + ',' + a + ')';
  }

  /* ---- gait ---- */
  // theta: 0 = leg forward at start of stance, pi = leg fully back / starts to swing through
  function legAngles(theta, hind) {
    var a1 = 0.62 * Math.cos(theta) - (hind ? 0.18 : 0), swing = Math.max(0, -Math.sin(theta));
    var flex = swing * (hind ? 1.25 : 1.35);
    return [a1, a1 - flex * (hind ? 0.9 : 1) + (hind ? 0.15 : 0.1)];
  }

  function makeSprite(no, dir, step, standing) {
    var P = HORSE[no], phi = step / STEPS * Math.PI * 2;
    var out = document.createElement('canvas'); out.width = SW; out.height = SH;
    var g = out.getContext('2d');
    var layer = document.createElement('canvas'); layer.width = SW; layer.height = SH;
    var L = layer.getContext('2d');
    var bob = standing ? 0 : -2.2 * Math.abs(Math.sin(phi * 0.5 + 0.4));
    var pitch = standing ? 0 : 0.035 * Math.sin(phi + 1);

    function begin() { L.setTransform(dir > 0 ? 1 : -1, 0, 0, 1, OX, OY); }
    function finish(merge) {
      L.setTransform(1, 0, 0, 1, 0, 0);
      var img = L.getImageData(0, 0, SW, SH), d = img.data, i, k;
      for (i = 0; i < d.length; i += 4) {
        if (d[i + 3] < 120) { d[i + 3] = 0; continue; }
        d[i + 3] = 255;
        for (k = 0; k < 3; k++) d[i + k] = Math.round(d[i + k] / 255 * 6) * 255 / 6;
      }
      L.putImageData(img, 0, 0);
      var o = g.getImageData(0, 0, SW, SH), od = o.data; // outline: 1px ring around this layer
      var lc = P.line, r = parseInt(lc.substr(1, 2), 16), gg = parseInt(lc.substr(3, 2), 16), b = parseInt(lc.substr(5, 2), 16);
      function on(x, y) { return x >= 0 && y >= 0 && x < SW && y < SH && d[(y * SW + x) * 4 + 3] > 0; }
      for (var y = 0; y < SH; y++) for (var x = 0; x < SW; x++) {
        if (!on(x, y) && (on(x - 1, y) || on(x + 1, y) || on(x, y - 1) || on(x, y + 1))) {
          var j = (y * SW + x) * 4;
          if (merge && od[j + 3] > 0) continue; // no contour line where this part overlaps an earlier one od[j] = r; od[j + 1] = gg; od[j + 2] = b; od[j + 3] = 255;
        }
      }
      g.putImageData(o, 0, 0); g.drawImage(layer, 0, 0); L.clearRect(0, 0, SW, SH);
    }

    function poly(pts) { L.beginPath(); L.moveTo(pts[0][0], pts[0][1]); for (var i = 1; i < pts.length; i++) L.lineTo(pts[i][0], pts[i][1]); L.closePath(); }
    function shaded(pathFn, base, hi, lo, y0, y1) {
      L.save(); pathFn(); L.fillStyle = base; L.fill(); L.clip();
      var gr = L.createLinearGradient(0, y0, 0, y1);
      gr.addColorStop(0, rgba(hi, 0.85)); gr.addColorStop(0.3, rgba(hi, 0)); gr.addColorStop(0.58, rgba(lo, 0)); gr.addColorStop(1, rgba(lo, 0.85));
      L.fillStyle = gr; L.fillRect(-70, y0 - 6, 140, y1 - y0 + 12);
      L.restore();
    }
    function quad(A, B, wa, wb, ang) {
      var nx = Math.cos(ang), ny = -Math.sin(ang);
      return [[A[0] + nx * wa / 2, A[1] + ny * wa / 2], [B[0] + nx * wb / 2, B[1] + ny * wb / 2], [B[0] - nx * wb / 2, B[1] - ny * wb / 2], [A[0] - nx * wa / 2, A[1] - ny * wa / 2]];
    }
    function limb(J, ang, L1, L2, w0, wk, wf, base, lo, sock) {
      var a1 = ang[0], a2 = ang[1];
      var K = [J[0] + L1 * Math.sin(a1), J[1] + L1 * Math.cos(a1)], F = [K[0] + L2 * Math.sin(a2), K[1] + L2 * Math.cos(a2)];
      shaded(function () { poly(quad(J, K, w0, wk, a1)); }, base, base, lo, Math.min(J[1], K[1]), Math.max(J[1], K[1]));
      L.fillStyle = base; L.beginPath(); L.arc(K[0], K[1], wk / 2, 0, 7); L.fill();
      shaded(function () { poly(quad(K, F, wk, wf, a2)); }, base, base, lo, Math.min(K[1], F[1]), Math.max(K[1], F[1]));
      // sock + hoof
      var S = [F[0] - (F[0] - K[0]) * 0.28, F[1] - (F[1] - K[1]) * 0.28];
      L.fillStyle = sock; poly(quad(S, F, wf + 0.8, wf + 0.8, a2)); L.fill();
      var H = [F[0] + 3 * Math.sin(a2), F[1] + 3 * Math.cos(a2)];
      L.fillStyle = BOOT; poly(quad(F, H, wf + 1.4, wf + 2.4, a2)); L.fill();
    }

    var legs = {
      fn: legAngles(phi, false), ff: legAngles(phi + 0.7, false),
      hn: legAngles(phi + Math.PI * 0.85, true), hf: legAngles(phi + Math.PI * 0.85 + 0.7, true)
    };
    if (standing) { legs = { fn: [0.04, 0], ff: [-0.05, 0], hn: [-0.1, 0.12], hf: [-0.2, 0.05] }; }
    var FJ = [13, -19 + bob], HJ = [-15, -21 + bob];

    // ---- layer 1: far legs + tail ----
    begin();
    limb(FJ, legs.ff, 10, 12, 6, 3.4, 2.8, P.lo, P.lo, P.lo);
    limb(HJ, legs.hf, 11, 12, 7, 3.6, 2.8, P.lo, P.lo, P.lo);
    var tw = standing ? 0 : Math.sin(phi * 1.0 + 0.6) * 2.5;
    L.fillStyle = P.mane;
    L.beginPath(); L.moveTo(-21, -33 + bob); L.bezierCurveTo(-30, -34 + bob, -38, -30 + bob + tw, -45, -23 + bob + tw * 1.5);
    L.bezierCurveTo(-41, -21 + bob + tw, -38, -22 + bob, -35, -20 + bob + tw); L.bezierCurveTo(-31, -25 + bob, -27, -27 + bob, -21, -27 + bob); L.closePath(); L.fill();
    finish();

    // ---- layer 2: near legs (the body is drawn over their tops so they grow out of it) ----
    begin();
    limb(FJ, legs.fn, 10, 12, 7, 3.8, 3, P.coat, P.lo, P.sock);
    limb(HJ, legs.hn, 11, 12, 8.5, 4, 3, P.coat, P.lo, P.sock);
    finish(true);

    // ---- layer 3: body, neck, head, mane ----
    begin(); L.save(); L.translate(0, bob); L.rotate(pitch);
    shaded(function () {
      L.beginPath(); L.moveTo(13, -34);
      L.bezierCurveTo(6, -36, -2, -33, -8, -34); L.bezierCurveTo(-14, -36, -21, -34, -23, -27);
      L.bezierCurveTo(-24, -21, -21, -16, -14, -15); L.bezierCurveTo(-8, -12, 0, -14, 6, -14);
      L.bezierCurveTo(13, -14, 18, -17, 19, -23); L.bezierCurveTo(20, -29, 18, -33, 13, -34); L.closePath();
    }, P.coat, P.hi, P.lo, -37, -12);
    // haunch + shoulder definition
    L.save(); L.beginPath(); L.ellipse(-14, -23, 8, 8, 0, 0, 7); L.clip(); L.fillStyle = rgba(P.lo, 0.35); L.beginPath(); L.ellipse(-9, -20, 9, 9, 0, 0, 7); L.fill(); L.restore();
    shaded(function () {
      L.beginPath(); L.moveTo(11, -33); L.bezierCurveTo(13, -39, 18, -46, 24, -50); L.lineTo(29, -45);
      L.bezierCurveTo(28, -39, 24, -31, 20, -20); L.lineTo(16, -23); L.closePath();
    }, P.coat, P.hi, P.lo, -50, -20);
    shaded(function () {
      L.beginPath(); L.moveTo(23, -50); L.bezierCurveTo(28, -51, 34, -46, 39, -40);
      L.bezierCurveTo(40, -37, 39, -35, 36, -35); L.bezierCurveTo(32, -35, 29, -38, 27, -43); L.closePath();
    }, P.coat, P.hi, P.lo, -51, -34);
    L.fillStyle = P.coat; poly([[24, -50], [25.5, -56], [28.5, -50.5]]); L.fill();
    L.fillStyle = BOOT; L.fillRect(30, -45, 2, 2); L.fillRect(38, -38, 2, 2);
    L.fillStyle = P.mane;
    L.beginPath(); L.moveTo(10, -33); L.bezierCurveTo(12, -41, 18, -48, 24, -52); L.lineTo(26, -49);
    L.bezierCurveTo(20, -45, 16, -39, 14.5, -32); L.closePath(); L.fill();
    L.fillStyle = P.sock; poly([[30.5, -42], [35.5, -39], [36, -37], [30, -40]]); L.fill(); // bridle
    L.fillStyle = BOOT; L.fillRect(33, -37, 4, 1);
    L.restore();
    finish(true);

    // ---- layer 4: saddle cloth + jockey ----
    begin(); L.save(); L.translate(0, bob); L.rotate(pitch);
    L.fillStyle = '#ffc830'; L.beginPath(); L.moveTo(-9, -35); L.lineTo(3, -35); L.lineTo(4, -23); L.lineTo(-10, -23); L.closePath(); L.fill();
    L.fillStyle = '#e8921c'; L.fillRect(-10, -25, 14, 2);
    // jockey (crouched over the withers)
    shaded(function () { poly([[-6, -36], [-1, -43], [10, -49], [14, -45], [3, -34]]); }, P.silk, P.silk, P.lo, -49, -34);
    L.fillStyle = P.stripe; poly([[0, -42], [3, -45], [5, -43], [2, -40]]); L.fill();
    L.fillStyle = '#ffffff'; poly([[-6, -36], [3, -34], [9, -30], [7, -28], [-1, -31], [-6, -33]]); L.fill();
    L.fillStyle = BOOT; poly([[6, -29], [9, -29], [9, -23], [6, -23]]); L.fill();
    L.strokeStyle = P.silk; L.lineWidth = 3; L.beginPath(); L.moveTo(9, -46); L.lineTo(18, -41); L.stroke();
    L.fillStyle = SKIN; L.fillRect(17, -42, 3, 3);
    L.fillStyle = SKIN; L.beginPath(); L.arc(14, -50, 3.6, 0, 7); L.fill();
    L.fillStyle = P.cap; L.beginPath(); L.arc(13.5, -51.5, 4.4, Math.PI, 0); L.lineTo(18.5, -51.5); L.lineTo(13, -51); L.closePath(); L.fill();
    L.fillRect(10, -52, 9, 2);
    L.fillStyle = SKIN_LO; L.fillRect(16, -49, 2, 1);
    L.strokeStyle = BOOT; L.lineWidth = 1; L.beginPath(); L.moveTo(19, -41); L.lineTo(35, -38); L.stroke();
    L.restore();
    finish();

    // number on the saddle cloth (pixel overlay, never mirrored)
    var gl = DIGITS[no], gx = -7, gy = -34 + Math.round(bob) + 1;
    g.fillStyle = '#000';
    for (var py = 0; py < 5; py++) for (var px = 0; px < 3; px++) {
      if (gl[py][px] === '1') {
        var lx = gx + (dir > 0 ? px : 2 - px) * 2, w = 2;
        g.fillRect(OX + (dir > 0 ? lx : -lx - w), OY + gy + py * 2 - 1, w, 2);
      }
    }
    return out;
  }

  var cache = {};
  function get(no, dir, phase, standing) {
    var step = standing ? 0 : Math.floor(phase / (Math.PI * 2) * STEPS) % STEPS;
    if (step < 0) step += STEPS;
    var key = no + (dir > 0 ? 'r' : 'l') + (standing ? 's' : step);
    return cache[key] || (cache[key] = makeSprite(no, dir, step, standing));
  }

  window.HorseSprites = { get: get, SW: SW, SH: SH, OX: OX, OY: OY, STEPS: STEPS, COLORS: HORSE };
})();
