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
  // World is bigger than the screen; a camera follows the pack. Horses start top-left, run right along the
  // top straight, round the curve on the right, and come back left along the bottom straight to the finish.
  var VW = 256, VH = 144;                                   // camera view (logical px)
  var WW = 810, WH = 270, CY = 135, XL = 150, XR = 650, X_MIN = 70;
  var R_IN = 30, LANE_W = 9, LANES = 6;
  var R_OUT = R_IN + LANE_W * LANES;
  var RMID = R_IN + LANE_W * LANES / 2;
  var S = XR - XL, ARC = Math.PI * RMID, TOTAL = 2 * S + ARC;

  // u = 0 is the start gate (top-left), u = 1 the finish line (bottom-left).
  function trackPos(u, lane) {
    var r = R_IN + LANE_W * (lane + 0.5), d = u * TOTAL, x, y, dir;
    if (d < S) { x = XL + d; y = CY - r; dir = 1; }
    else if (d < S + ARC) {
      var th = (d - S) / RMID;
      x = XR + r * Math.sin(th); y = CY - r * Math.cos(th); dir = th < Math.PI / 2 ? 1 : -1;
    } else { x = XR - (d - S - ARC); y = CY + r; dir = -1; }
    return { x: x, y: y, dir: dir };
  }

  /* ================= palette ================= */
  var HORSE = {
    1: { coat: '#f4f4f4', shade: '#b4b6c8', mane: '#6a6a80', line: '#34346a', silk: '#e03030', cap: '#2848d8' },
    2: { coat: '#e84ccc', shade: '#a82c98', mane: '#4a2060', line: '#4a1050', silk: '#3858e8', cap: '#ffe83a' },
    3: { coat: '#e83030', shade: '#a01818', mane: '#401010', line: '#500808', silk: '#8a8ad8', cap: '#8a8ad8' },
    4: { coat: '#2848d8', shade: '#1830a0', mane: '#0c1038', line: '#080850', silk: '#ff9a9a', cap: '#ff6aa0' },
    5: { coat: '#f0e030', shade: '#b8a410', mane: '#7a5018', line: '#584400', silk: '#b060e0', cap: '#b060e0' },
    6: { coat: '#1f8858', shade: '#14603c', mane: '#302008', line: '#083820', silk: '#f090c0', cap: '#d8d8f0' }
  };
  var SKIN = '#f0b080', DARK = '#1c1c1c';
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
  function hash(x, y) {
    var h = (Math.imul(x, 374761393) + Math.imul(y, 668265263)) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }
  function rgb(hex) { return [parseInt(hex.substr(1, 2), 16), parseInt(hex.substr(3, 2), 16), parseInt(hex.substr(5, 2), 16)]; }
  function rect(g, x, y, w, h, col) { g.fillStyle = col; g.fillRect(Math.round(x), Math.round(y), w, h); }

  function bush(g, x, y) {
    rect(g, x + 1, y + 3, 11, 5, '#1b7236'); rect(g, x + 2, y + 1, 9, 5, '#2ea44e');
    rect(g, x + 4, y, 5, 2, '#5bd26f'); rect(g, x, y + 5, 2, 3, '#2ea44e'); rect(g, x + 11, y + 5, 2, 3, '#2ea44e');
    rect(g, x + 3, y + 5, 2, 2, '#f08a24'); rect(g, x + 8, y + 3, 2, 2, '#f08a24'); rect(g, x + 6, y + 6, 2, 1, '#ffd23c');
  }
  function flowers(g, x, y) {
    rect(g, x, y + 3, 16, 5, '#2a4a9a');
    for (var i = 0; i < 16; i += 2) { rect(g, x + i, y + 2, 2, 5, i % 4 ? '#f0602a' : '#ffa23c'); }
    rect(g, x, y + 2, 16, 1, '#ffd23c');
  }

  function makeBackground() {
    var cv = document.createElement('canvas'); cv.width = WW; cv.height = WH;
    var g = cv.getContext('2d'), img = g.createImageData(WW, WH), d = img.data;
    var GRASS = rgb('#3dbb5f'), GRASS_D = rgb('#34a653'), GRASS_L = rgb('#4ccd6e');
    var DIRT = rgb('#b9925a'), DIRT_D = rgb('#a47e49'), DIRT_L = rgb('#c9a46c');
    var RAIL_A = rgb('#f4ead6'), RAIL_B = rgb('#c8bca2');
    for (var y = 0; y < WH; y++) for (var x = 0; x < WW; x++) {
      var c, h = hash(x, y);
      if (inTrack(x, y)) {
        var edge = !inTrack(x - 1, y) || !inTrack(x + 1, y) || !inTrack(x, y - 1) || !inTrack(x, y + 1);
        c = edge ? (((x >> 2) + (y >> 2)) & 1 ? RAIL_A : RAIL_B) : (h < 0.07 ? DIRT_D : h > 0.95 ? DIRT_L : DIRT);
      } else c = h < 0.08 ? GRASS_D : h > 0.97 ? GRASS_L : GRASS;
      var i = (y * WW + x) * 4; d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2]; d[i + 3] = 255;
    }
    g.putImageData(img, 0, 0);

    // hedges + flower beds on the outside rail, flower beds on the infield rail
    var n = 0, x0;
    for (x0 = X_MIN; x0 <= XR; x0 += 15, n++) {
      (n % 2 ? flowers : bush)(g, x0, CY - R_OUT - 11);
      (n % 2 ? flowers : bush)(g, x0, CY + R_OUT + 3);
    }
    for (x0 = X_MIN + 10; x0 <= XR - 20; x0 += 40) { flowers(g, x0, CY - R_IN + 2); flowers(g, x0, CY + R_IN - 10); }
    var step = 15 / (R_OUT + 8);
    for (var th = step * 0.5; th < Math.PI - step * 0.3; th += step, n++) {
      var px = XR + (R_OUT + 9) * Math.sin(th), py = CY - (R_OUT + 9) * Math.cos(th);
      (n % 2 ? flowers : bush)(g, px - 7, py - 4);
    }
    // finish line (bottom straight, left) and posts
    for (var yy = CY + R_IN + 1, k = 0; yy < CY + R_OUT - 1; yy += 3, k++) {
      rect(g, XL - 1, yy, 3, 3, k % 2 ? '#000' : '#fff'); rect(g, XL + 2, yy, 3, 3, k % 2 ? '#fff' : '#000');
    }
    rect(g, XL - 1, CY + R_IN - 5, 3, 6, '#e03030'); rect(g, XL - 1, CY + R_OUT, 3, 5, '#e03030');
    // starting gate (top straight, left)
    rect(g, XL - 24, CY - R_OUT, 4, R_OUT - R_IN, '#3c3c48');
    for (var l = 0; l <= LANES; l++) rect(g, XL - 24, CY - R_OUT + l * LANE_W - (l === LANES ? 1 : 0), 30, 1, '#555563');
    return cv;
  }

  /* ================= horse sprites: slim, long-legged racers (cached per pose) ================= */
  var SPR_W = 48, SPR_H = 42, OX = 24, OY = 36;
  var POSES = [ // [kneeX, kneeY, hoofX, hoofY] for frontNear, frontFar, backNear, backFar (facing right)
    [[10, -5, 16, -3], [8, -4, 13, -1], [-11, -5, -16, -2], [-9, -4, -14, 0]],   // fully stretched
    [[9, -4, 7, 0], [7, -4, 11, -1], [-8, -4, -6, 0], [-10, -4, -10, -1]],        // gathering
    [[6, -3, 4, 0], [8, -3, 9, 0], [-5, -3, -7, 0], [-7, -3, -4, -1]],            // legs under
    [[8, -5, 13, -2], [6, -3, 5, 0], [-9, -4, -14, -3], [-6, -3, -9, 0]],         // push off
    [[5, -3, 5, 0], [4, -3, 4, 0], [-6, -3, -6, 0], [-5, -3, -5, 0]]              // standing
  ];
  var sprites = {};

  function makeSprite(no, dir, frame) {
    var p = HORSE[no], pose = POSES[frame];
    var cv = document.createElement('canvas'); cv.width = SPR_W; cv.height = SPR_H;
    var g = cv.getContext('2d');
    var layer = document.createElement('canvas'); layer.width = SPR_W; layer.height = SPR_H;
    var lg = layer.getContext('2d');
    function R(lx, ly, w, h, col) { lg.fillStyle = col; lg.fillRect(OX + (dir > 0 ? lx : -lx - w), OY + ly, w, h); }
    function line(x0, y0, x1, y1, w, col) {
      var n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) || 1, o = (w - 1) >> 1;
      for (var i = 0; i <= n; i++) R(Math.round(x0 + (x1 - x0) * i / n) - o, Math.round(y0 + (y1 - y0) * i / n) - o, w, w, col);
    }
    // paints the current layer over the sprite with a 1px outline around it
    function commit() {
      var d = lg.getImageData(0, 0, SPR_W, SPR_H).data;
      function on(x, y) { return x >= 0 && y >= 0 && x < SPR_W && y < SPR_H && d[(y * SPR_W + x) * 4 + 3] > 0; }
      g.fillStyle = p.line;
      for (var y = 0; y < SPR_H; y++) for (var x = 0; x < SPR_W; x++) {
        if (!on(x, y) && (on(x - 1, y) || on(x + 1, y) || on(x, y - 1) || on(x, y + 1))) g.fillRect(x, y, 1, 1);
      }
      g.drawImage(layer, 0, 0); lg.clearRect(0, 0, SPR_W, SPR_H);
    }
    function leg(hx, hy, k, col) {
      line(hx, hy, k[0], k[1], 2, col);
      line(k[0], k[1], k[2], k[3] - 1, 1, col);
      R(k[2] - 1, k[3] - 1, 2, 1, DARK);
    }
    function glyph(x, y) {
      var gl = DIGITS[no];
      for (var py = 0; py < 5; py++) for (var px = 0; px < 3; px++) if (gl[py][px] === '1') R(x + (dir > 0 ? px : 2 - px), y + py, 1, 1, '#000');
    }

    // far legs + tail
    leg(4, -7, pose[1], p.shade); leg(-5, -7, pose[3], p.shade);
    line(-8, -11, -12, -10, 2, p.mane); line(-12, -10, -15, -7, 1, p.mane);
    commit();
    // slim body, long neck, small head
    R(-7, -12, 13, 1, p.coat); R(-8, -11, 16, 3, p.coat); R(-7, -8, 14, 1, p.shade);
    line(6, -10, 10, -16, 3, p.coat); line(11, -16, 15, -14, 2, p.coat);
    R(11, -18, 1, 2, p.coat); R(15, -14, 2, 2, p.shade); R(13, -16, 1, 1, DARK);
    line(5, -12, 9, -18, 1, p.mane);
    commit();
    // near legs
    leg(5, -7, pose[0], p.coat); leg(-6, -7, pose[2], p.coat);
    commit();
    // number tag
    R(-5, -15, 7, 8, '#ffc830'); glyph(-3, -14);
    commit();
    // jockey: white pants, coloured silks and helmet, leaning over the neck
    R(-3, -17, 6, 3, '#ffffff');
    R(-2, -22, 5, 5, p.silk); R(2, -23, 4, 3, p.silk);
    line(4, -20, 9, -17, 1, p.silk); R(9, -18, 1, 1, SKIN);
    R(4, -26, 4, 3, p.cap); R(6, -23, 2, 2, SKIN);
    commit();
    return cv;
  }

  function drawHorse(g, cx, cy, dir, phase, standing, no) {
    var frame = standing ? 4 : Math.floor(phase / (Math.PI * 2) * 4) & 3;
    var key = no + (dir > 0 ? 'r' : 'l') + frame;
    var spr = sprites[key] || (sprites[key] = makeSprite(no, dir, frame));
    g.drawImage(spr, cx - OX, cy - OY - (!standing && frame === 0 ? 1 : 0));
  }

  function drawDust(g, cx, cy, dir, phase) {
    for (var i = 0; i < 3; i++) {
      var ox = 18 + i * 5 + ((phase * 3 + i * 7) % 4 | 0), oy = 1 + ((phase * 2 + i * 3) % 4 | 0);
      rect(g, cx - dir * ox - 1, cy - oy, 2, 1, i % 2 ? '#d9b886' : '#c9a46c');
    }
  }

  var MS = 0.06, MW = Math.round(WW * MS), MH = Math.round(WH * MS), MX = 3, MY = VH - 10 - MH - 3;
  function drawMini(g, items, camX, camY) {
    g.fillStyle = 'rgba(8,20,40,.7)'; g.fillRect(MX - 2, MY - 2, MW + 4, MH + 4);
    for (var u = 0; u <= 1; u += 0.006) { var p = trackPos(u, LANES / 2 - 0.5); rect(g, MX + p.x * MS, MY + p.y * MS, 2, 2, '#8a7048'); }
    var f = trackPos(1, LANES / 2 - 0.5); rect(g, MX + f.x * MS - 1, MY + f.y * MS - 2, 1, 6, '#fff');
    items.forEach(function (it) { rect(g, MX + it.pos.x * MS - 1, MY + it.pos.y * MS - 1, 3, 3, HORSE[it.no].coat); });
    g.strokeStyle = '#fff'; g.lineWidth = 1; g.strokeRect(MX + camX * MS + .5, MY + camY * MS + .5, VW * MS, VH * MS);
  }

  /* ================= sound (WebAudio chiptune) ================= */
  var Sound = (function () {
    var ctx = null, on = false;
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
      toggle: function () {
        if (!ctx) { var AC = window.AudioContext || window.webkitAudioContext; if (!AC) return false; ctx = new AC(); }
        if (ctx.state === 'suspended') ctx.resume();
        on = !on; return on;
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
          emit('result', { raceNo: race.raceNo, order: race.order, combination: [race.order[0], race.order[1]] });
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
    var ty = Math.min(WH - VH, Math.max(0, tp.y - 20 * Math.cos(Math.PI * arcT) - VH / 2));
    var perf = performance.now(), dt = Math.min(0.1, (perf - (cam.t || perf)) / 1000); cam.t = perf;
    if (cam.key !== rk || cam.x == null) { cam.key = rk; cam.x = tx; cam.y = ty; }
    else { var k = 1 - Math.exp(-dt * 4); cam.x += (tx - cam.x) * k; cam.y += (ty - cam.y) * k; }
    var camX = Math.round(cam.x), camY = Math.round(cam.y);

    g.drawImage(bg, camX, camY, VW, VH, 0, 0, VW, VH);
    items.sort(function (a, b) { return a.pos.y - b.pos.y; });
    items.forEach(function (it) {
      var hx = Math.round(it.pos.x) - camX, hy = Math.round(it.pos.y) - camY + 4;
      if (hx < -40 || hx > VW + 40) return;
      var phs = it.u * TOTAL / 26 * Math.PI * 2;
      if (!it.standing) drawDust(g, hx, hy, it.pos.dir, phs);
      drawHorse(g, hx, hy, it.pos.dir, phs, it.standing, it.no);
    });
    drawMini(g, items, camX, camY);
    if (phase === 'racing' && nowMs - lastHoof > 170) { lastHoof = nowMs; Sound.hoof(); }

    // ---- HUD ----
    var raceNo = race && phase !== 'idle' ? race.raceNo : (st ? st.nextRaceNo : '--');
    setHTML(el.race, 'race', 'RACE ' + (raceNo < 10 ? '0' + raceNo : raceNo));
    var status = { connecting: 'CONNECTING...', idle: 'WAITING FOR NEXT RACE', sync: 'SYNCING...', results: 'OFFICIAL RESULT',
      countdown: 'POST TIME ' + Math.ceil(-t) + 's', racing: t < 1.5 ? "THEY'RE OFF!" : 'RACE IN PROGRESS' }[phase];
    setHTML(el.status, 'status', status);

    var hist = (st && st.history) || [];
    var lastRes = hist[hist.length - 1];
    setHTML(el.last, 'last', lastRes ? 'LAST ' + chip(lastRes.order[0]) + chip(lastRes.order[1]) : '');
    setHTML(el.hist, 'hist', hist.slice(-6).reverse().map(function (r) {
      return '<span class="item">R' + r.raceNo + ' ' + chip(r.order[0]) + chip(r.order[1]) + '</span>';
    }).join(''));
    el.conn.textContent = Sync.online ? 'LIVE' : 'OFFLINE'; el.conn.className = 'conn' + (Sync.online ? '' : ' off');

    var tote = '';
    if (phase === 'racing' && rc && t < rc.secondTime + 1.5) {
      live.sort(function (a, b) { return (b.done - a.done) || (a.done ? a.time - b.time : b.u - a.u); });
      tote = live.map(function (l, i) { return '<span class="rank">' + ORD[i] + chip(l.no) + '</span>'; }).join('');
    } else if ((phase === 'racing' || phase === 'results') && rc) {
      tote = '<span class="label">WINNING COMBINATION</span>' + chip(race.order[0], 'big') + chip(race.order[1], 'big');
    } else if (phase === 'countdown') {
      tote = '<span class="label blink">HORSES AT THE GATE</span>';
    } else if (phase === 'idle') {
      tote = '<span class="label blink">NEXT: RACE ' + (st ? st.nextRaceNo : '--') + '</span>';
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
        '<div class="combo">' + chip(race.order[0], 'big') + '<span>-</span>' + chip(race.order[1], 'big') + '</div>' +
        '<div class="grid">' + race.order.map(function (n, i) { return '<div class="cell">' + ORD[i] + chip(n) + '</div>'; }).join('') + '</div>');
    }
    requestAnimationFrame(frame);
  }

  detectMode();
  requestAnimationFrame(frame);
})();
