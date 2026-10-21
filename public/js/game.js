/*
 * Retro Horse Race - renderer, sound and state sync.
 *
 * Query parameters (for embedding):
 *   ?api=https://host   race server to use (default: same origin, else local mode)
 *   ?mode=local         force local mode (controller in another tab of the same browser)
 *   ?sound=0            hide the sound button
 *   ?hud=0              hide the HTML overlay (top / bottom bars)
 */
(function () {
  'use strict';
  var C = window.HorseCore;
  var qs = new URLSearchParams(location.search);

  /* ================= geometry: a closed "U" track lying on its side, opening to the LEFT ================= */
  // The world is bigger than the screen; a camera follows the pack. Horses start top-left, run right along the
  // top straight, round the curve on the right, and come back left along the bottom straight to the finish.
  var VW = 544, VH = 306;                                   // camera view (logical px)
  var LANES = 6, LANE_W = 24, R_IN = 238 - 3 * 24, R_OUT = R_IN + LANE_W * LANES, RMID = R_IN + LANE_W * LANES / 2;   // a wide, long curve
  var CY = R_OUT + 80, XL = 260, XR = 1700, X_MIN = 140;
  var WW = XR + R_OUT + 90, WH = CY + R_OUT + 60;
  var S = XR - XL, ARC = Math.PI * RMID, TOTAL = 2 * S + ARC;
  var SP = window.HorseSprites, PAL = SP.COLORS;

  // u = 0 is the start gate (top-left), u = 1 the finish line (bottom-left).
  function trackPos(u, lane) {
    var r = R_IN + LANE_W * (lane + 0.5), d = u * TOTAL, x, y, dir, hd = 0;
    if (d < S) { x = XL + d; y = CY - r; dir = 1; }
    else if (d < S + ARC) {
      var th = (d - S) / RMID;
      x = XR + r * Math.sin(th); y = CY - r * Math.cos(th); dir = th < Math.PI / 2 ? 1 : -1; hd = th;
    } else { x = XR - (d - S - ARC); y = CY + r; dir = -1; hd = Math.PI; }
    return { x: x, y: y, dir: dir, hd: hd };
  }

  var DIGITS = {
    1: ['010', '110', '010', '010', '111'], 2: ['111', '001', '111', '100', '111'],
    3: ['111', '001', '111', '001', '111'], 4: ['101', '101', '111', '001', '001'],
    5: ['111', '100', '111', '001', '111'], 6: ['111', '100', '111', '101', '111']
  };

  /* ================= static background ================= */
  function inTrack(x, y) {
    var dy = y - CY;
    if (x <= XR) { var a = Math.abs(dy); return x >= X_MIN && a >= R_IN && a < R_OUT; }
    var dx = x - XR, d = Math.sqrt(dx * dx + dy * dy);
    return d >= R_IN && d < R_OUT;
  }
  function radial(x, y) { var dy = y - CY; if (x <= XR) return Math.abs(dy); var dx = x - XR; return Math.sqrt(dx * dx + dy * dy); }
  function hash(x, y) {
    var h = (Math.imul(x, 374761393) + Math.imul(y, 668265263)) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }
  function vnoise(x, y, s) { // smooth value noise, cell size s
    var xi = Math.floor(x / s), yi = Math.floor(y / s), fx = x / s - xi, fy = y / s - yi;
    fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
    var a = hash(xi, yi), b = hash(xi + 1, yi), c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1);
    return (a + (b - a) * fx) * (1 - fy) + (c + (d - c) * fx) * fy;
  }
  function rgb(hex) { return [parseInt(hex.substr(1, 2), 16), parseInt(hex.substr(3, 2), 16), parseInt(hex.substr(5, 2), 16)]; }
  function mix(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; }
  function rect(g, x, y, w, h, col) { g.fillStyle = col; g.fillRect(Math.round(x), Math.round(y), w, h); }
  function px(g, x, y, col) { g.fillStyle = col; g.fillRect(x, y, 1, 1); }

  function bush(g, x, y) {
    rect(g, x + 1, y + 4, 14, 7, '#1b7236'); rect(g, x + 2, y + 1, 12, 7, '#2ea44e');
    rect(g, x + 5, y, 6, 3, '#5bd26f'); rect(g, x, y + 7, 3, 4, '#2ea44e'); rect(g, x + 14, y + 7, 3, 4, '#2ea44e');
    rect(g, x + 4, y + 6, 2, 2, '#f08a24'); rect(g, x + 10, y + 4, 2, 2, '#f08a24'); rect(g, x + 8, y + 8, 2, 1, '#ffd23c');
  }
  function flowers(g, x, y) {
    rect(g, x, y + 4, 18, 6, '#2a4a9a');
    for (var i = 0; i < 18; i += 2) rect(g, x + i, y + 2, 2, 7, i % 4 ? '#f0602a' : '#ffa23c');
    rect(g, x, y + 2, 18, 1, '#ffd23c');
  }
  function cone(g, x, y) {
    rect(g, x - 4, y, 9, 2, '#1c1c1c'); rect(g, x - 3, y - 2, 7, 2, '#f06a14'); rect(g, x - 2, y - 5, 5, 3, '#f06a14');
    rect(g, x - 2, y - 4, 5, 1, '#ffffff'); rect(g, x - 1, y - 8, 3, 3, '#f06a14'); px(g, x, y - 9, '#f06a14');
  }

  // grandstand facing the camera: roof, tiered seats full of spectators, advertising boards
  function stands(g, x0, x1, y0, y1) {
    var w = x1 - x0, h = y1 - y0, x, y, r;
    rect(g, x0, y0, w, h, '#1b2140');
    var rows = Math.floor((h - 22) / 6), crowd = ['#f2c8a0', '#e0a070', '#c07a50', '#8a5030', '#ffffff', '#e83a3a', '#3a7ae8', '#f2d83a', '#3ac86a', '#c84ae8', '#ff8a2a'];
    for (r = 0; r < rows; r++) {
      var ry = y0 + 12 + r * 6;
      rect(g, x0, ry + 4, w, 2, r % 2 ? '#3a56a0' : '#2c4486');
      for (x = x0 + 1; x < x1 - 2; x += 3) {
        var hs = hash(x * 7 + r, r * 13 + 5);
        if (hs < 0.78) {
          var c = crowd[Math.floor(hash(x, r + 99) * crowd.length)];
          rect(g, x, ry + 1, 2, 2, hs < 0.12 ? '#f2c8a0' : '#f2c8a0'); rect(g, x, ry + 3, 2, 2, c);
        }
      }
    }
    for (x = x0 + 60; x < x1 - 10; x += 150) rect(g, x, y0 + 10, 6, h - 22, 'rgba(210,215,235,.55)'); // aisles
    // roof / awning
    rect(g, x0, y0, w, 5, '#3a3a52');
    for (x = x0; x < x1; x += 10) { rect(g, x, y0 + 5, 10, 5, (x / 10) % 2 ? '#e8e8f0' : '#d83a3a'); rect(g, x, y0 + 10, 10, 2, (x / 10) % 2 ? '#b8b8c8' : '#8a1c1c'); }
    for (x = x0 + 4; x < x1; x += 120) rect(g, x, y0, 4, h, '#6a6a80');
    // advertising band
    rect(g, x0, y1 - 8, w, 8, '#10142a');
    var ads = ['#f0c820', '#e83a3a', '#38b868', '#3a7ae8', '#ffffff', '#ff8a2a'];
    for (x = x0 + 2; x < x1 - 20; x += 26) {
      var ac = ads[Math.floor(hash(x, 7) * ads.length)];
      rect(g, x, y1 - 7, 24, 6, ac);
      for (var k = 0; k < 4; k++) rect(g, x + 2 + k * 5, y1 - 5, 3 + (k % 2), 2, ac === '#ffffff' ? '#222' : '#101010');
    }
  }
  // padded barrier along the outer rail (alternating red / white blocks)
  function barrierH(g, x0, x1, y) {
    for (var x = x0; x < x1; x += 14) {
      var red = ((x - x0) / 14) % 2 === 0;
      rect(g, x, y, 14, 7, red ? '#d83030' : '#f0f0f4'); rect(g, x, y, 14, 2, red ? '#ff7a6a' : '#ffffff'); rect(g, x, y + 5, 14, 2, red ? '#8a1818' : '#b4b4c4');
    }
  }

  function makeBackground() {
    var cv = document.createElement('canvas'); cv.width = WW; cv.height = WH;
    var g = cv.getContext('2d'), img = g.createImageData(WW, WH), d = img.data;
    var GRASS_A = rgb('#40b052'), GRASS_B = rgb('#379c48'), GRASS_L = rgb('#58cc6a');
    var DIRT = rgb('#b48c58'), DIRT_D = rgb('#9c7648'), DIRT_L = rgb('#c8a26c'), LANE = rgb('#cfae7c');
    var CURB_A = rgb('#f4c81c'), CURB_B = rgb('#2a52b8'), RAIL = rgb('#f6f2e8'), RAIL_S = rgb('#7a6444');
    for (var y = 0; y < WH; y++) for (var x = 0; x < WW; x++) {
      var c, h = hash(x, y);
      if (inTrack(x, y)) {
        // distance (px) to the nearest track edge
        var rr0 = radial(x, y), e = Math.floor(Math.min(rr0 - R_IN, R_OUT - rr0, x <= XR ? x - X_MIN : 99)) + 1;
        if (e === 1 || e === 2) c = RAIL;
        else if (e <= 5) c = (((x >> 3) + (y >> 3)) & 1) ? CURB_A : CURB_B;
        else if (e <= 7) c = RAIL_S;
        else {
          var n = vnoise(x, y, 9) * 0.6 + vnoise(x, y, 3) * 0.4;
          c = mix(DIRT_D, DIRT_L, n);
          if (h < 0.05) c = DIRT_D; else if (h > 0.97) c = DIRT_L;
          var rr = (radial(x, y) - R_IN) / LANE_W, fr = rr - Math.round(rr);
          if (Math.abs(fr) < 0.045 && Math.round(rr) > 0 && Math.round(rr) < LANES && (((x + y) >> 4) & 1)) c = LANE;
        }
      } else {
        var stripe = ((Math.floor(x / 40) + Math.floor(y / 40)) & 1) ? GRASS_A : GRASS_B;
        c = h > 0.975 ? GRASS_L : h < 0.06 ? mix(stripe, [0, 40, 0], 0.25) : stripe;
      }
      var i = (y * WW + x) * 4; d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2]; d[i + 3] = 255;
    }
    g.putImageData(img, 0, 0);

    var yTopRail = CY - R_OUT, yBotRail = CY + R_OUT, x;
    // tree line above the world
    for (x = 0; x < WW; x += 14) { var th0 = 4 + hash(x, 3) * 8; rect(g, x, 0, 16, th0 + 4, hash(x, 9) < 0.5 ? '#1c6a34' : '#238040'); rect(g, x + 3, th0 + 2, 10, 3, '#175a2c'); }
    // top grandstand + barrier above the outer rail, bottom grandstand in the infield
    stands(g, X_MIN - 30, XR + 10, 14, yTopRail - 12);
    barrierH(g, X_MIN - 30, XR + 10, yTopRail - 10);
    rect(g, X_MIN - 30, yTopRail - 3, XR - X_MIN + 40, 2, '#f6f2e8');
    stands(g, X_MIN - 30, XR - 80, CY + R_IN - 70, CY + R_IN - 12);
    barrierH(g, X_MIN - 30, XR - 80, CY + R_IN - 10);
    // infield decoration under the top straight: flower beds and a pond
    var nn = 0;
    for (x = X_MIN; x < XR - 120; x += 21, nn++) (nn % 2 ? flowers : bush)(g, x, CY - R_IN + 8);
    g.fillStyle = '#2c78d8'; g.beginPath(); g.ellipse(XR - 260, CY - 10, 330, 85, 0, 0, 7); g.fill();
    g.fillStyle = '#58a8f0'; g.beginPath(); g.ellipse(XR - 290, CY - 30, 230, 40, 0, 0, 7); g.fill();
    for (var tr = 0; tr < 40; tr++) { // trees on the infield around the lake
      var tx = XR - 560 + hash(tr, 1) * 700, ty = CY - 120 + hash(tr, 2) * 240;
      if (Math.abs(tx - (XR - 260)) < 345 && Math.abs(ty - (CY - 10)) < 95) continue;
      g.fillStyle = '#175a2c'; g.fillRect(tx, ty, 18, 14); g.fillStyle = '#2c9a4a'; g.fillRect(tx + 2, ty - 8, 14, 12);
    }
    // hedges + flower beds around the curve (outer side) and below the bottom straight
    var step = 18 / (R_OUT + 12);
    for (var th = step * 0.5; th < Math.PI - step * 0.3; th += step, nn++) {
      var ax = XR + (R_OUT + 14) * Math.sin(th), ay = CY - (R_OUT + 14) * Math.cos(th);
      (nn % 2 ? flowers : bush)(g, ax - 8, ay - 5);
    }
    for (x = X_MIN; x <= XR; x += 20, nn++) (nn % 2 ? flowers : bush)(g, x, yBotRail + 8);
    for (x = X_MIN - 10; x < XR + 40; x += 36) { g.fillStyle = '#1c6a34'; g.fillRect(x, yBotRail + 28, 22, 18); g.fillStyle = '#2c9a4a'; g.fillRect(x + 3, yBotRail + 24, 16, 14); }
    // cones along the inner curbs
    for (x = XL + 80; x < XR - 20; x += 150) { cone(g, x, CY - R_IN - 3); cone(g, x + 60, CY + R_IN + 12); }
    // finish line (bottom straight) with posts
    for (var yy = CY + R_IN, k2 = 0; yy < CY + R_OUT; yy += 4, k2++) {
      rect(g, XL - 2, yy, 4, 4, k2 % 2 ? '#101010' : '#ffffff'); rect(g, XL + 2, yy, 4, 4, k2 % 2 ? '#ffffff' : '#101010');
    }
    rect(g, XL - 3, CY + R_IN - 12, 5, 14, '#d83030'); rect(g, XL - 3, CY + R_OUT - 2, 5, 14, '#d83030');
    rect(g, XL - 3, CY + R_IN - 14, 22, 4, '#ffffff'); rect(g, XL, CY + R_IN - 14, 4, 4, '#101010'); rect(g, XL + 8, CY + R_IN - 14, 4, 4, '#101010');
    // starting gate with numbered stalls (top straight)
    var gx0 = XL - 56, gx1 = XL + 14, gy0 = CY - R_OUT, gy1 = CY - R_IN;
    rect(g, gx0, gy0, 5, gy1 - gy0, '#5a4a8a'); rect(g, gx0 + 1, gy0, 2, gy1 - gy0, '#7a6aaa');
    for (var l = 0; l <= LANES; l++) {
      var ly = gy0 + l * LANE_W - (l === LANES ? 2 : 0);
      rect(g, gx0, ly, gx1 - gx0, 2, '#6a5a9a'); rect(g, gx0, ly + 2, gx1 - gx0, 1, '#2a2048');
    }
    for (var ln = 0; ln < LANES; ln++) {
      var py = gy1 - (ln + 1) * LANE_W + 2; // lane 0 is the inner (bottom) lane
      rect(g, gx0 - 12, py, 13, 12, '#ffd21c'); rect(g, gx0 - 12, py + 10, 13, 2, '#c8a010');
      var gl = DIGITS[ln + 1];
      for (var r2 = 0; r2 < 5; r2++) for (var c2 = 0; c2 < 3; c2++) if (gl[r2][c2] === '1') rect(g, gx0 - 10 + c2 * 3, py + 1 + r2 * 2, 3, 2, '#101010');
    }
    return cv;
  }

  /* ================= horses ================= */
  // On the curve the horse turns with the track: its side view narrows as it turns towards the camera
  // (heading straight down the screen) and widens again facing the other way, so there is no sudden flip.
  // Through the curve the horse uses angled sprites: side view -> 45 degrees facing right -> straight on ->
  // 45 degrees facing left -> side view facing left.
  function drawHorse(g, cx, cy, dir, phase, standing, no, hd) {
    var q = Math.PI / 8, idx = 0;
    if (!standing) idx = hd < q ? 0 : hd < 3 * q ? 1 : hd < 5 * q ? 2 : hd < 7 * q ? 3 : 0;
    var sc = idx === 2 ? 0.5 : idx ? 0.8 : 1;
    g.fillStyle = 'rgba(50,30,10,.30)'; g.fillRect(Math.round(cx - 30 * sc), cy - 1, Math.round(62 * sc), 3); g.fillRect(Math.round(cx - 22 * sc), cy + 2, Math.round(46 * sc), 1);
    if (!idx) { g.drawImage(SP.get(no, dir, phase, standing), cx - SP.OX, cy - SP.OY); return; }
    g.drawImage(SP.getTurn(no, idx, phase, false), cx - SP.TURN.OX, cy - SP.TURN.OY);
  }
  function drawDust(g, cx, cy, dir, phase) {
    for (var i = 0; i < 7; i++) {
      var ox = 34 + i * 10 + ((phase * 3 + i * 5) % 6 | 0), oy = 1 + i * 2 + ((phase * 2 + i * 3) % 4 | 0), s = 7 - (i >> 1) * 2 + 1;
      g.fillStyle = 'rgba(224,194,144,' + Math.max(0.12, 0.8 - i * 0.11) + ')';
      g.fillRect(Math.round(cx - dir * ox), Math.round(cy - oy), s, Math.max(2, s - 2));
    }
  }

  // speed lines that streak past while the camera is moving fast
  var streak = { px: 0, py: 0 };
  function frac(v) { return v - Math.floor(v); }
  function mod(a, n) { return ((a % n) + n) % n; }
  function drawStreaks(g, cam, dt) {
    var sp = Math.sqrt(cam.vx * cam.vx + cam.vy * cam.vy);
    if (sp < 30) return;
    streak.px -= cam.vx * dt * 1.7; streak.py -= cam.vy * dt * 1.7;
    var L = Math.min(54, 10 + sp * 0.22), ux = cam.vx / sp, uy = cam.vy / sp;
    g.lineWidth = 1;
    for (var i = 0; i < 26; i++) {
      var x = mod(frac(Math.sin(i * 12.9898) * 43758.5453) * (VW + 160) + streak.px, VW + 160) - 80;
      var y = mod(frac(Math.sin(i * 78.233) * 12345.678) * VH + streak.py, VH);
      g.strokeStyle = 'rgba(255,255,255,' + (0.14 + frac(i * 0.37) * 0.22).toFixed(2) + ')';
      g.beginPath(); g.moveTo(Math.round(x), Math.round(y)); g.lineTo(Math.round(x + ux * L), Math.round(y + uy * L)); g.stroke();
    }
  }

  var MS = 0.05, MW = Math.round(WW * MS), MH = Math.round(WH * MS), MX = 4, MY = VH - 14 - MH - 4;
  function drawMini(g, items, camX, camY) {
    g.fillStyle = 'rgba(8,20,40,.72)'; g.fillRect(MX - 2, MY - 2, MW + 4, MH + 4);
    for (var u = 0; u <= 1; u += 0.004) { var p = trackPos(u, LANES / 2 - 0.5); rect(g, MX + p.x * MS, MY + p.y * MS, 2, 2, '#8a7048'); }
    var f = trackPos(1, LANES / 2 - 0.5); rect(g, MX + f.x * MS - 1, MY + f.y * MS - 2, 1, 6, '#fff');
    items.forEach(function (it) { rect(g, MX + it.pos.x * MS - 1, MY + it.pos.y * MS - 1, 3, 3, PAL[it.no].coat); });
    g.strokeStyle = '#fff'; g.lineWidth = 1; g.strokeRect(MX + camX * MS + .5, MY + camY * MS + .5, VW * MS, VH * MS);
  }

  /* ================= sound (WebAudio chiptune) ================= */
  var Sound = (function () {
    var ctx = null, on = false, musicBuf = null, musicSrc = null, musicKey = null, loading = false, MUSIC_VOL = 0.38, chingBuf = null, chingLoading = false, vicBuf = null, vicLoading = false, vicSrc = null, vicKey = null, VIC_VOL = 0.5;
    function stopMusic(keepKey) {
      if (musicSrc) { try { musicSrc.stop(); } catch (e) { /* already ended */ } musicSrc = null; }
      if (!keepKey) musicKey = null;
    }
    function loadMusic() {
      if (musicBuf || loading) return; loading = true;
      fetch('audio/theme.mp3').then(function (r) { return r.arrayBuffer(); }).then(function (ab) {
        return new Promise(function (ok, bad) { ctx.decodeAudioData(ab, ok, bad); });      // callback form also works on older Safari
      }).then(function (buf) { musicBuf = buf; }).catch(function () { /* no music, the other sounds still work */ }).then(function () { loading = false; });
    }
    function loadVictory() {
      if (vicBuf || vicLoading) return; vicLoading = true;
      fetch('audio/victory.mp3').then(function (r) { return r.arrayBuffer(); }).then(function (ab) {
        return new Promise(function (ok, bad) { ctx.decodeAudioData(ab, ok, bad); });
      }).then(function (buf) { vicBuf = buf; }).catch(function () { /* no victory theme */ }).then(function () { vicLoading = false; });
    }
    function stopVictory(keepKey) {
      if (vicSrc) { try { vicSrc.stop(); } catch (e) { /* already ended */ } vicSrc = null; }
      if (!keepKey) vicKey = null;
    }
    function loadChing() {
      if (chingBuf || chingLoading) return; chingLoading = true;
      fetch('audio/chaching.mp3').then(function (r) { return r.arrayBuffer(); }).then(function (ab) {
        return new Promise(function (ok, bad) { ctx.decodeAudioData(ab, ok, bad); });
      }).then(function (buf) { chingBuf = buf; }).catch(function () { /* no cha-ching */ }).then(function () { chingLoading = false; });
    }
    function tone(f, at, dur, type, vol) {
      var o = ctx.createOscillator(), g = ctx.createGain();
      o.type = type || 'square'; o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, at); g.gain.linearRampToValueAtTime(vol || 0.08, at + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
      o.connect(g); g.connect(ctx.destination); o.start(at); o.stop(at + dur + 0.05);
    }
    function seq(notes) { var t = ctx.currentTime + 0.02; notes.forEach(function (n) { tone(n[0], t, n[1] * 0.95, 'square', 0.07); t += n[1]; }); }
    return {
      get on() { return on; },
      state: function () { return { on: on, loaded: !!musicBuf, playing: !!musicSrc, key: musicKey, ctx: ctx && ctx.state }; },
      toggle: function () {
        if (!ctx) { var AC = window.AudioContext || window.webkitAudioContext; if (!AC) return false; ctx = new AC(); }
        if (ctx.state === 'suspended') ctx.resume();
        on = !on;
        if (on) { loadMusic(); loadChing(); loadVictory(); } else { stopMusic(); stopVictory(); }
        return on;
      },
      // the theme starts 3 s before betting closes and plays on top of the other sounds; viewers who join later hear it from the right place
      music: function (key, startAtMs, nowMs) {
        if (!on || !musicBuf || key === musicKey || nowMs < startAtMs) return;
        musicKey = key;
        var off = (nowMs - startAtMs) / 1000;
        if (off > musicBuf.duration - 1) return;
        stopMusic(true);
        var src = ctx.createBufferSource(), g = ctx.createGain(), t0 = ctx.currentTime, left = musicBuf.duration - off;
        src.buffer = musicBuf; g.gain.setValueAtTime(MUSIC_VOL, t0); g.gain.setValueAtTime(MUSIC_VOL, t0 + Math.max(0, left - 2)); g.gain.linearRampToValueAtTime(0.0001, t0 + left);
        src.connect(g); g.connect(ctx.destination); src.start(t0, off);
        musicSrc = src;
      },
      // victory fanfare: starts with the winner banner, fades out and stops at stopAtMs (5 s before the next betting close)
      victory: function (key, startAtMs, stopAtMs, nowMs) {
        if (!on || !vicBuf || key === vicKey || nowMs < startAtMs || nowMs >= stopAtMs - 500) return;
        vicKey = key;
        var off = (nowMs - startAtMs) / 1000, len = Math.min(vicBuf.duration - off, (stopAtMs - nowMs) / 1000);
        if (len < 0.5) return;
        stopVictory(true);
        var src = ctx.createBufferSource(), g = ctx.createGain(), t0 = ctx.currentTime, fade = Math.min(1.5, len);
        src.buffer = vicBuf; g.gain.setValueAtTime(VIC_VOL, t0); g.gain.setValueAtTime(VIC_VOL, t0 + len - fade); g.gain.linearRampToValueAtTime(0.0001, t0 + len);
        src.connect(g); g.connect(ctx.destination); src.start(t0, off); src.stop(t0 + len + 0.05);
        vicSrc = src;
      },
      ching: function () {        // PLACE BET button
        if (!on || !chingBuf) return;
        var src = ctx.createBufferSource(), g = ctx.createGain();
        src.buffer = chingBuf; g.gain.value = 0.9; src.connect(g); g.connect(ctx.destination); src.start();
      },
      beep: function () { if (on) tone(660, ctx.currentTime, 0.12, 'square', 0.06); },
      bugle: function () { if (on) seq([[392, .14], [523, .14], [659, .14], [784, .5]]); },
      go: function () { if (on) tone(1046, ctx.currentTime, 0.45, 'square', 0.07); },
      hoof: function () { if (on) tone(70 + Math.random() * 25, ctx.currentTime, 0.07, 'triangle', 0.09); },
      fanfare: function () { if (on) seq([[523, .12], [523, .12], [523, .12], [659, .3], [587, .12], [659, .12], [784, .5]]); }
    };
  })();

  /* ================= state sync ================= */
  var Sync = { mode: null, offset: 0, state: null, online: false };
  function now() { return Date.now() + Sync.offset; }

  function startServerMode(base) {
    Sync.mode = 'server';
    (function poll() {
      var t0 = Date.now();
      fetch(base + '/api/public', { cache: 'no-store' })
        .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
        .then(function (p) {
          var t1 = Date.now(), off = p.serverNow - (t0 + t1) / 2;
          Sync.offset = Sync.state && Math.abs(off - Sync.offset) < 400 ? Sync.offset * 0.8 + off * 0.2 : off;
          Sync.state = p; Sync.online = true;
        })
        .catch(function () { Sync.online = false; })
        .then(function () { setTimeout(poll, 700); });
    })();
  }

  function startLocalMode() {
    Sync.mode = 'local'; Sync.offset = 0;
    function read() {
      try {
        var raw = localStorage.getItem('horserace.public');
        if (raw) { Sync.state = JSON.parse(raw); Sync.online = true; }
      } catch (e) { Sync.online = false; }
    }
    read();
    window.addEventListener('storage', read);
    setInterval(read, 400);
  }

  function detectMode() {
    var base = (qs.get('api') || '').replace(/\/$/, '');
    if (qs.get('mode') === 'local') return startLocalMode();
    if (base) return startServerMode(base);
    fetch('api/public', { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error(); return r.json(); })
      .then(function () { startServerMode('.'); })
      .catch(startLocalMode);
  }

  /* ================= DOM / HUD ================= */
  var $ = function (id) { return document.getElementById(id); };
  var el = { stage: $('stage'), race: $('hRace'), status: $('hStatus'), last: $('hLast'), tote: $('tote'),
    cd: $('countdown'), res: $('results'), hist: $('hHistory'), snd: $('snd'), conn: $('conn') };
  var cache = {};
  function setHTML(node, key, html) { if (cache[key] !== html) { cache[key] = html; node.innerHTML = html; } }
  function chip(n, cls) { return '<span class="chip ' + (cls || '') + ' h' + n + '">' + n + '</span>'; }
  function comboHTML(order, cls) { var c = C.combination(order); return chip(c[0], cls) + '<span class="dash">-</span>' + chip(c[1], cls); }
  var ORD = ['1ST', '2ND', '3RD', '4TH', '5TH', '6TH'];

  function resize() { el.stage.style.setProperty('--u', (el.stage.clientWidth / 100) + 'px'); }
  window.addEventListener('resize', resize); resize();
  if (window.ResizeObserver) new ResizeObserver(resize).observe(el.stage);

  if (qs.get('sound') === '0') el.snd.style.display = 'none';
  if (qs.get('hud') === '0') document.querySelectorAll('.bar').forEach(function (b) { b.style.display = 'none'; });
  el.snd.addEventListener('click', function () {
    var on = Sound.toggle();
    el.snd.textContent = on ? 'SOUND ON' : 'SOUND OFF'; el.snd.className = on ? 'on' : '';
  });

  // sound starts by itself on the first tap / click / key press anywhere (browsers only allow audio after a gesture);
  // a player who turns it off afterwards keeps it off
  if (qs.get('sound') !== '0') {
    var autoEvents = ['pointerup', 'touchend', 'click', 'keydown'];
    var autoSound = function (ev) {
      autoEvents.forEach(function (n) { document.removeEventListener(n, autoSound, true); });
      if (ev.target && ev.target.closest && ev.target.closest('#snd')) return;          // the button does its own toggle
      if (!Sound.on) el.snd.click();
    };
    autoEvents.forEach(function (n) { document.addEventListener(n, autoSound, true); });
  }

  // host platform integration
  function emit(type, data) {
    if (window.parent === window) return;
    var msg = { source: 'horse-race', type: type };
    for (var k in data) msg[k] = data[k];
    try { window.parent.postMessage(msg, '*'); } catch (e) { /* ignore */ }
  }
  window.addEventListener('message', function (ev) {
    var m = ev.data;
    if (m && m.target === 'horse-race' && m.type === 'setSound' && !!m.on !== Sound.on) el.snd.click();
  });

  /* ================= main loop ================= */
  var bg = makeBackground();
  var g = document.getElementById('screen').getContext('2d');
  var fired = {}, firedRace = null, lastHoof = 0, cam = {};

  function once(key, cond, fn, lateness) {
    if (fired[key] || !cond) return;
    fired[key] = true;
    if (lateness < 1.5) fn();
  }

  function frame() {
    var nowMs = now(), st = Sync.state, race = st && st.race, T = (st && st.timings) || { race: C.RACE_MS, results: C.RESULTS_MS };
    var phase = 'idle', t = -999, rc = null;
    if (race) {
      t = (nowMs - race.startAt) / 1000;
      phase = t < 0 ? 'countdown' : t * 1000 < T.race ? 'racing' : t * 1000 < T.race + T.results ? 'results' : 'idle';
      if (race.order && phase !== 'idle') rc = C.buildRace(race.seed, race.order);
      if (!rc && (phase === 'racing' || phase === 'results')) phase = 'sync';
    }
    if (!st) phase = 'connecting';

    var rk = race ? race.seed + ':' + race.startAt : null;
    if (rk !== firedRace) { firedRace = rk; fired = {}; }
    if (race && (phase !== 'idle')) {
      once('cd', phase === 'countdown', function () { emit('countdown', { raceNo: race.raceNo }); Sound.bugle(); }, 0);
      [3, 2, 1].forEach(function (n) { once('b' + n, t >= -n && t < 0, Sound.beep, t + n); });
      once('go', t >= 0 && rc, function () { Sound.go(); emit('start', { raceNo: race.raceNo }); }, t);
      if (rc) {
        once('fin', t >= rc.firstTime, Sound.fanfare, t - rc.firstTime);
        once('res', t * 1000 >= T.race, function () {
          emit('result', { raceNo: race.raceNo, order: race.order, combination: C.combination(race.order) });
        }, t - T.race / 1000);
      }
    }

    // ---- scene ----
    var tt = phase === 'racing' || phase === 'results' ? t : 0, items = [], live = [];
    for (var no = 1; no <= C.HORSES; no++) {
      var u = 0, standing = true, h = rc && rc.horses[no];
      if (h) {
        u = C.progress(h, tt);
        standing = tt <= 0 || u - C.progress(h, tt - 0.1) < 0.0004;
        live.push({ no: no, u: u, done: tt >= h.time, time: h.time });
      }
      items.push({ no: no, pos: trackPos(u, no - 1), u: u, standing: standing });
    }

    // camera: follows the pack (leader-weighted) round the track and stops at the finish line
    var uc = 0;
    if (live.length) {
      var lead = 0, sum = 0;
      live.forEach(function (l) { lead = Math.max(lead, l.u); sum += l.u; });
      uc = Math.min(1, (lead + sum / live.length) / 2);
    }
    var tp = trackPos(uc, LANES / 2 - 0.5), arcT = Math.min(1, Math.max(0, (uc * TOTAL - S) / ARC));
    var tx = Math.min(WW - VW, Math.max(0, tp.x + tp.dir * VW * 0.08 - VW / 2));
    var ty = Math.min(WH - VH, Math.max(0, tp.y - 34 * Math.cos(Math.PI * arcT) - VH / 2));
    var perf = performance.now(), dt = Math.min(0.1, (perf - (cam.t || perf)) / 1000); cam.t = perf;
    if (cam.key !== rk || cam.x == null) { cam.key = rk; cam.x = tx; cam.y = ty; }
    else { var k = 1 - Math.exp(-dt * 5); cam.x += (tx - cam.x) * k; cam.y += (ty - cam.y) * k; }
    if (dt > 0) { var ivx = (cam.x - (cam.px == null ? cam.x : cam.px)) / dt, ivy = (cam.y - (cam.py == null ? cam.y : cam.py)) / dt; cam.vx = (cam.vx || 0) * 0.8 + ivx * 0.2; cam.vy = (cam.vy || 0) * 0.8 + ivy * 0.2; }
    cam.px = cam.x; cam.py = cam.y;
    var racing = phase === 'racing';
    var camX = Math.round(cam.x), camY = Math.round(cam.y);

    g.drawImage(bg, camX, camY, VW, VH, 0, 0, VW, VH);
    if (racing) drawStreaks(g, cam, dt);
    items.sort(function (a, b) { return a.pos.y - b.pos.y; });
    items.forEach(function (it) {
      var hx = Math.round(it.pos.x) - camX, hy = Math.round(it.pos.y) - camY + 6;
      if (hx < -70 || hx > VW + 70) return;
      var phs = it.u * TOTAL / 36 * Math.PI * 2;          // about 3.6 strides a second
      if (!it.standing && !(it.pos.hd > 0.2 && it.pos.hd < 2.9)) drawDust(g, hx, hy, it.pos.dir, phs);
      drawHorse(g, hx, hy, it.pos.dir, phs, it.standing, it.no, it.pos.hd);
    });
    drawMini(g, items, camX, camY);
    if (phase === 'racing' && nowMs - lastHoof > 170) { lastHoof = nowMs; Sound.hoof(); }
    // background theme: MUSIC_LEAD_MS before betting closes (live), or before the countdown starts (demo, no betting)
    var MUSIC_LEAD_MS = 3000;
    var mAt = st && st.round && st.round.betCloseAt ? st.round.betCloseAt - MUSIC_LEAD_MS : race && st && st.timings ? race.startAt - (st.timings.countdown || 6000) - MUSIC_LEAD_MS : null;
    if (mAt !== null) Sound.music(st && st.round ? st.round.raceNo : race.raceNo, mAt, nowMs);

    // victory fanfare: from the winner banner until 5 s before the next betting close (live); until the results end (demo)
    if (race && race.order) {
      var resAt = race.startAt + T.race, resEnd = resAt + T.results, rnd0 = st.round;
      Sound.victory(race.raceNo, resAt, rnd0 && rnd0.betCloseAt ? resEnd + (rnd0.betCloseAt - rnd0.openAt) - 5000 : resEnd, nowMs);
    }

    // ---- HUD ----
    var betting = !!(st && st.round && st.round.phase === 'betting' && phase === 'idle'), betSecs = betting ? Math.max(0, Math.ceil((st.round.betCloseAt - nowMs) / 1000)) : 0;
    var raceNo = betting ? st.round.raceNo : race && phase !== 'idle' ? race.raceNo : (st ? st.nextRaceNo : '--');
    setHTML(el.race, 'race', 'RACE ' + (raceNo < 10 ? '0' + raceNo : raceNo));
    var status = { connecting: 'CONNECTING...', idle: 'WAITING FOR NEXT RACE', sync: 'SYNCING...', results: 'OFFICIAL RESULT',
      countdown: 'POST TIME ' + Math.ceil(-t) + 's', racing: t < 1.5 ? "THEY'RE OFF!" : 'RACE IN PROGRESS' }[phase];
    if (betting) status = 'PLACE YOUR BETS - ' + betSecs + 'S';
    setHTML(el.status, 'status', status);

    var hist = (st && st.history) || [];
    var lastRes = hist[hist.length - 1];
    setHTML(el.last, 'last', lastRes ? 'LAST ' + comboHTML(lastRes.order) : '');
    setHTML(el.hist, 'hist', hist.slice(-6).reverse().map(function (r) {
      return '<span class="item">R' + r.raceNo + ' ' + comboHTML(r.order) + '</span>';
    }).join(''));
    el.conn.textContent = Sync.online ? 'LIVE' : 'OFFLINE'; el.conn.className = 'conn' + (Sync.online ? '' : ' off');

    var tote = '';
    if (phase === 'racing' && rc && t < rc.secondTime + 1.5) {
      live.sort(function (a, b) { return (b.done - a.done) || (a.done ? a.time - b.time : b.u - a.u); });
      tote = live.map(function (l, i) { return '<span class="rank">' + ORD[i] + chip(l.no) + '</span>'; }).join('');
    } else if ((phase === 'racing' || phase === 'results') && rc) {
      tote = '<span class="label">WINNING COMBINATION</span>' + comboHTML(race.order);
    } else if (phase === 'countdown') {
      tote = '<span class="label blink">HORSES AT THE GATE</span>';
    } else if (phase === 'idle') {
      tote = betting ? '<span class="label blink">BETS OPEN - ' + betSecs + 'S</span>' : '<span class="label blink">NEXT: RACE ' + (st ? st.nextRaceNo : '--') + '</span>';
    } else tote = '<span class="label">' + status + '</span>';
    setHTML(el.tote, 'tote', tote);

    var showCd = phase === 'countdown' && t > -6 && t < 0 || (phase === 'racing' && t < 1.2);
    el.cd.hidden = !showCd;
    if (showCd) {
      var txt = t < 0 ? String(Math.ceil(-t)) : 'GO!';
      setHTML(el.cd, 'cd', txt); el.cd.className = 'countdown' + (t < 0 ? '' : ' go');
    }

    el.res.hidden = phase !== 'results';
    if (phase === 'results' && race.order) {
      setHTML(el.res, 'res', '<div class="title">RACE ' + race.raceNo + ' RESULT</div>' +
        '<div class="combo">' + comboHTML(race.order, 'big') + '</div>' +
        '<div class="grid">' + race.order.map(function (n, i) { return '<div class="cell">' + ORD[i] + chip(n) + '</div>'; }).join('') + '</div>');
    }
    requestAnimationFrame(frame);
  }

  window.HorseGame = { state: function () { return Sync.state; }, now: now, sound: Sound };
  detectMode();
  if (SP.warm) setTimeout(SP.warm, 800);
  requestAnimationFrame(frame);
})();
