/*
 * Pixel-art racehorses copied from the reference design: bold black outlines, flat colours, slim body,
 * long neck, socks on the legs, red-capped jockey and a numbered saddle cloth.
 * The body (head, neck, back, tail, jockey) is the traced reference; the four legs are generated so they can gallop.
 * Sprites are cached per (horse, facing, gait step).
 */
(function () {
  'use strict';

  if (window.HORSE_VARIANT == null) window.HORSE_VARIANT = 5; // 0 = old straight-leg body, 5 = slim tucked-up belly (default)

  var COLS = 89, PADX = 6, PADY = 4, SW = COLS + PADX * 2 + 2, SH = 60 + PADY * 2;
  var OX = PADX + 44, OY = PADY + 56, STEPS = 12;

  var BODY = [
    '........................................................KKKKKK...........................',
    '.......................................................KKRRRRKK..........................',
    '......................................................KKRRRRRRKK.........................',
    '......................................................KRRRRRRRRK.........................',
    '......................................................KRRRRRRRRKK........................',
    '.................................................KKKKKKRRRRRRRRRRK.......................',
    '...............................................KKKRRRRKKKKKKKKKKKK......KKK..............',
    '............................................KKKKRRRRRRRKKSKSSKSK........KWKK.............',
    '..........................................KKKRRRRRRRRRRRKKSSSSSK........KWWKK............',
    '.........................................KKRRRRRRRRRRRRRRKSSSSKK...KKKKKKWWWKKK..........',
    '........................................KKRRRRRRRRRRRRRRRKKSSKK..KKKKWWWKKWWWWKK.........',
    '.......................................KKRKRRRRRRRRKRRRRKKKKKK..KKKWWWWKKKKWWKKKK........',
    '......................................KKRRRKRRRRRRRKRRRRKK....KKKWWWWKKWWKKWKKWWKK.......',
    '......................................KRRRRRKRRRRRRKRRRRK....KKKWWWWKWWWWWKKKWWWWKK......',
    '......................................KRRRRRRKKRRKKKRRRRK...KKWWWWWKWWWWWWKKWWWWWWKK.....',
    '......................................KRRRRRRRRKKKKKRRRRKKKKKKKWWKKWWWWWWWKKWWWKKWWK.....',
    '......................................KKRRRRRRRRRKKKKRRRRRRKSSSKKWWWWWWWWWKWKWWWWWWKK....',
    '.......................................KKRRRRRRRRRRKKRRRRRRKSSSKWWWWWWWWWWKWWKWWWWWWKK...',
    '........................................KKKKRRRRRRRRKKRRRRRKKKKKWWWWWWWWWBKWWWKWWWWWKKK..',
    '...........................KKKKKKK....KKK..KKKRRRRRRRKKKKKKBBWWWKKWWWWWWWBKWWWWKWWWKBBKK.',
    '........................KKKKWWWWWKKKKKKKKKK..KKKKRRRRKKKKBBWWWWWWWKKKWWWWBKBWWWWKWKBBBBKK',
    '......................KKKWWWWWWWWWWWKYYKKKKKKKKKKRRRRKKKBWWWWWWWWWWWWKKKKKKKBBWWBKKBBBBBK',
    '.....................KKWWWWWWWWWWWWWKYYYKKKKKKKKRKKRKKKWWWWWWWWWWWWWWWWWBKKKKKKKKKKBBBKBK',
    '.................KKKKKWWWWWWWWWWWWWWKYYYYYYYKKKKRRRKKKKWWWWWWWWWWWWWWWWBKK..KKKKKBBKBBBBK',
    '.............KKKKKWWWWWWWWWWWWWWWWWWKYYYYYYYKKKKRRRKKYKWWWWWWWWWWWWWWWWKK.......KKBBKBBKK',
    '...........KKKWWWWWWWKWWWWWWWWWWWWWWKYYYKKYYYKKRRRKKKYKWWWWWWWWWWWWWWWBK.........KKBBKKK.',
    '........KKKKWWWWWWWWKWWWWWWWWWWWWWWWKYYKKKYYYKKRRRKKYYKWWWWWWWWWWWWWWWKK..........KKKKK..',
    'KKKKKKKKKWWWWWWWWKKKKWWWWWWWWWWWWWWWKYYYKKYYYKRRRKKYYYKWWWWWWWWWWWWWWBK..................',
    'KKWWWWWWWWWWWWWWKK.KWWWWWWWWWWWWWWWWKYYYKKYYYKKKKKKYYYKWWWWWWWWWWWWWWKK..................',
    '.KKWWWWWWWWWWWWKK..KWWWWWWWWWWWWWWWWKYYYKKYYYKKKKKKKYYKWWWWWWWWWWWWWBK...................',
    '..KWWWWWWWWWWWKK...KWWWWWWWWWWWWWWWWKYYKKKKYYYKKKKKKYYKWWWWWWWWWWWWWKK...................',
    '..KKWWWWWWWWWKK....KWWWWWWWWWWWWWBWWKYYYYYYYYYYKKKYYYYKWWWWWWWWWWWWBK....................',
    '...KKKWWWWWKKK.....KBWWWWWWWWWWWWBBWKKKYYYYYYYYKKKYYYYKWWWWWWWWWWWWKK....................',
    '.....KKKKKKK.......KKWWWWWWWWWWWWWBWWWWKKKKKKKKKKKKKKKKWWWWWWWWWWWWK.....................',
    '....................KBWWWWWWWWWWWWKWWWWWWWWWWWWKKKWWWWWWWWWWWWWWWWWK.....................',
    '....................KKBWWWWWWWWWWWKBWWWWWWWWWWWKKKWWWWWWWWWWWWWWWWKK.....................',
    '.....................KKBWWWWWWWWWWKBBWWWWWWWWWWKKKKWWWWWWWWWWWWBWBK......................',
    '......................KKBWWWWWWWWWKKBBBWWWWWWWWKKKKWWBWWWWWWWWWBWKK......................',
    '.......................KKKWWWWWWWKKBKKBBBWWWWWWWKKKWBWWWWWWWWWBBKKK......................'
  ];

  var HORSE = {
    1: { coat: '#ffffff', shade: '#0a3c96', muzzle: '#0a3c96', sock: '#0a3c96', silk: '#ff0000', cap: '#ff0000', cloth: '#ffe600' },
    2: { coat: '#e82ad0', shade: '#8a0c86', muzzle: '#8a0c86', sock: '#ffffff', silk: '#2058f0', cap: '#2058f0', cloth: '#ffe600' },
    3: { coat: '#ee1c1c', shade: '#8a0a0a', muzzle: '#8a0a0a', sock: '#ffffff', silk: '#9a9aff', cap: '#9a9aff', cloth: '#ffe600' },
    4: { coat: '#2850e8', shade: '#14289a', muzzle: '#14289a', sock: '#ffffff', silk: '#ff80b0', cap: '#ff80b0', cloth: '#ffe600' },
    5: { coat: '#ffe620', shade: '#b08a00', muzzle: '#b08a00', sock: '#ffffff', silk: '#a040e0', cap: '#a040e0', cloth: '#ffffff' },
    6: { coat: '#18a050', shade: '#0a5a2c', muzzle: '#0a5a2c', sock: '#ffffff', silk: '#ff90c0', cap: '#ff90c0', cloth: '#ffe600' }
  };
  var DIGITS = {
    1: ['..#..', '.##..', '..#..', '..#..', '..#..', '..#..', '.###.'],
    2: ['.###.', '#...#', '....#', '...#.', '..#..', '.#...', '#####'],
    3: ['.###.', '#...#', '....#', '..##.', '....#', '#...#', '.###.'],
    4: ['...#.', '..##.', '.#.#.', '#..#.', '#####', '...#.', '...#.'],
    5: ['#####', '#....', '####.', '....#', '....#', '#...#', '.###.'],
    6: ['.###.', '#....', '#....', '####.', '#...#', '#...#', '.###.']
  };

  // lowest kept body row for each column; everything below is replaced by the generated legs
  function cut(c) {
    var V = window.HORSE_VARIANT | 0;
    if (V === 0) {
      if (c <= 18) return 33;
      if (c <= 35) return 37;
      if (c <= 54) return 34;
      if (c <= 67) return 38;
      return 33;
    }
    // visible, tucked-up belly between the thigh and the elbow
    if (c <= 18) return 33;
    if (c <= 35) return 37;
    if (c <= 38) return 36;
    if (c <= 41) return 35;
    if (c <= 50) return 33;
    if (c <= 53) return 35;
    if (c <= 56) return 37;
    if (c <= 67) return 38;
    return 33;
  }

  function grid() { var g = []; for (var y = 0; y < SH; y++) { g.push(new Array(SW).fill(' ')); } return g; }

  // gait: theta 0 = leg forward at the start of stance, pi = fully back, then it swings through folded
  function legAngles(theta, hind) {
    var a1 = 0.62 * Math.cos(theta) - (hind ? 0.1 : 0), swing = Math.max(0, -Math.sin(theta));
    var flex = swing * (hind ? 0.95 : 1.1);
    return [a1, a1 - flex + (hind ? 0.12 : 0.05)];
  }

  function stamp(T, x, y, w, h, ch) {
    var x0 = Math.round(x - w / 2), y0 = Math.round(y - h / 2);
    for (var j = 0; j < h; j++) for (var i = 0; i < w; i++) {
      var xx = x0 + i, yy = y0 + j;
      if (yy >= 0 && yy < SH && xx >= 0 && xx < SW) T[yy][xx] = ch;
    }
  }

  // paints one leg with a black contour over whatever is already in out
  function paintLeg(out, hx, hy, ang, wTop, L1, L2) {
    var T = grid(), a1 = ang[0], a2 = ang[1], t, n;
    var K = [hx + L1 * Math.sin(a1), hy + L1 * Math.cos(a1)], F = [K[0] + L2 * Math.sin(a2), K[1] + L2 * Math.cos(a2)];
    n = Math.ceil(L1 * 2);
    for (t = 0; t <= n; t++) { var f = t / n, w = Math.round(wTop + (3 - wTop) * f); stamp(T, hx + (K[0] - hx) * f, hy + (K[1] - hy) * f, w, w, 'W'); }
    stamp(T, K[0], K[1], 4, 4, 'W');
    n = Math.ceil(L2 * 2);
    for (t = 0; t <= n; t++) {
      var g = t / n, ch = g < 0.18 ? 'W' : g < 0.78 ? 'L' : 'W', ww = g < 0.78 ? 3 : 2;
      stamp(T, K[0] + (F[0] - K[0]) * g, K[1] + (F[1] - K[1]) * g, ww, ww, ch);
    }
    stamp(T, F[0] + Math.sin(a2) * 1.5, F[1] + Math.cos(a2) * 1.5 + 1, 4, 3, 'H');
    var x, y;
    for (y = 0; y < SH; y++) for (x = 0; x < SW; x++) {
      if (T[y][x] !== ' ') continue;
      if ((x > 0 && T[y][x - 1] !== ' ') || (x < SW - 1 && T[y][x + 1] !== ' ') || (y > 0 && T[y - 1][x] !== ' ') || (y < SH - 1 && T[y + 1][x] !== ' ')) out[y][x] = 'K';
    }
    for (y = 0; y < SH; y++) for (x = 0; x < SW; x++) if (T[y][x] !== ' ') out[y][x] = T[y][x];
  }

  function makeSprite(no, dir, step, standing) {
    var P = HORSE[no], phi = step / STEPS * Math.PI * 2, out = grid(), r, c;
    var legs = {
      hf: legAngles(phi + Math.PI * 0.85 + 0.7, true), ff: legAngles(phi + 0.7, false),
      hn: legAngles(phi + Math.PI * 0.85, true), fn: legAngles(phi, false)
    };
    if ((window.HORSE_VARIANT | 0) >= 4 && !standing) {
      var cl = function (v, lo, hi) { return Math.max(lo, Math.min(hi, v)); };
      legs.hn = [cl(legs.hn[0], -0.95, 0.12), cl(legs.hn[1], -1.0, 0.2)]; legs.hf = [cl(legs.hf[0], -0.95, 0.12), cl(legs.hf[1], -1.0, 0.2)];
      legs.fn = [cl(legs.fn[0], -0.2, 0.95), cl(legs.fn[1], -0.5, 1.0)]; legs.ff = [cl(legs.ff[0], -0.2, 0.95), cl(legs.ff[1], -0.5, 1.0)];
    }
    if (standing) legs = { hf: [-0.05, -0.05], ff: [-0.08, -0.08], hn: [0.05, 0.05], fn: [0, 0] };
    var bob = standing ? 0 : -Math.round(2.6 * Math.abs(Math.sin(phi * 0.5 + 0.4)));

    // legs first (the body is painted over their tops)
    var V = window.HORSE_VARIANT | 0;
    if (V === 0) {
      paintLeg(out, PADX + 41, PADY + 33 + bob, legs.hf, 5, 10, 11);
      paintLeg(out, PADX + 53, PADY + 33 + bob, legs.ff, 5, 10, 11);
      paintLeg(out, PADX + 29, PADY + 34 + bob, legs.hn, 7, 10, 11);
      paintLeg(out, PADX + 61, PADY + 35 + bob, legs.fn, 7, 10, 11);
    } else if (V >= 4) { // legs only at the far ends of the body: the belly between them stays in view
      paintLeg(out, PADX + 31, PADY + 34 + bob, legs.hf, 5, 10, 11);
      paintLeg(out, PADX + 60, PADY + 35 + bob, legs.ff, 5, 10, 11);
      paintLeg(out, PADX + 26, PADY + 34 + bob, legs.hn, 7, 10, 11);
      paintLeg(out, PADX + 65, PADY + 35 + bob, legs.fn, 7, 10, 11);
    } else { // legs grow out of the thigh and the elbow, leaving the belly open between them
      paintLeg(out, PADX + 33, PADY + 34 + bob, legs.hf, 5, 10, 11);
      paintLeg(out, PADX + 57, PADY + 35 + bob, legs.ff, 5, 10, 11);
      paintLeg(out, PADX + 28, PADY + 34 + bob, legs.hn, 7, 10, 11);
      paintLeg(out, PADX + 62, PADY + 35 + bob, legs.fn, 7, 10, 11);
    }

    // body from the reference (shifted by the bob), recoloured
    var kept = grid();
    for (r = 0; r < BODY.length; r++) for (c = 0; c < COLS; c++) {
      var ch = BODY[r][c];
      if (ch === '.' || r > cut(c)) continue;
      if (ch === 'B') ch = (c >= 75 && r >= 17 && r <= 27) ? 'M' : 'D';
      else if (ch === 'R') ch = r <= 5 ? 'C' : 'R';
      else if (ch === 'K' && c >= 37 && c <= 44 && r >= 23 && r <= 31) ch = 'Y'; // clear the reference number
      else if (ch === 'Y' && false) ch = 'Y';
      kept[r][c] = ch;
    }
    if (V === 5) { // athletic belly: deepest at the girth behind the elbow, tucking up towards the flank
      for (c = 34; c <= 60; c++) {
        var t5 = Math.max(0, Math.min(1, (c - 36) / 18)), bot5 = Math.round(34 + 5 * t5 * t5 * (3 - 2 * t5));
        if (c > 54) bot5 = 39;
        for (r = cut(c) + 1; r <= bot5; r++) kept[r][c] = r >= bot5 ? 'D' : 'W';
      }
    }
    if (V === 4) { // clearly visible deep belly: rounded underside, shaded, outlined
      for (c = 33; c <= 60; c++) {
        var bot4 = 43 - Math.floor(((c - 46.5) * (c - 46.5)) / 8);
        for (r = cut(c) + 1; r <= bot4; r++) kept[r][c] = r >= bot4 - 2 ? 'D' : 'W';
      }
    }
    if (V === 2) { // deeper barrel: round belly under the saddle
      for (c = 34; c <= 58; c++) {
        var bot = 41 - Math.floor(((c - 46) * (c - 46)) / 11);
        for (r = cut(c) + 1; r <= bot; r++) if (r > 0 && r < BODY.length + 8) { if (!kept[r]) kept[r] = []; kept[r][c] = r >= bot - 1 ? 'D' : 'W'; }
      }
    }
    if (V === 3) { // muscle definition: thigh and shoulder contour lines
      [[24, 29], [25, 31], [26, 33], [27, 35], [28, 36], [29, 36]].forEach(function (q) { if (kept[q[1]][q[0]] === 'W') kept[q[1]][q[0]] = 'K'; });
      [[58, 30], [59, 32], [60, 34], [61, 36], [62, 37]].forEach(function (q) { if (kept[q[1]][q[0]] === 'W') kept[q[1]][q[0]] = 'K'; });
    }
    // number on the saddle cloth
    var gl = DIGITS[no];
    for (r = 23; r <= 31; r++) for (c = 37; c <= 44; c++) kept[r][c] = 'Y';
    for (r = 0; r < 7; r++) for (c = 0; c < 5; c++) if (gl[r][c] === '#') kept[24 + r][38 + c] = 'N';
    var yy, xx;
    for (r = 0; r < kept.length; r++) for (c = 0; c < COLS; c++) {
      if (kept[r][c] !== ' ' && kept[r][c] !== undefined) { yy = r + PADY + bob; xx = c + PADX; if (yy >= 0 && yy < SH) out[yy][xx] = kept[r][c]; }
    }
    // contour along the cut-away / added belly (never over a leg)
    if (V === 0) {
      for (r = 0; r < BODY.length + 1; r++) for (c = 0; c < COLS; c++) {
        if (r > cut(c) && r <= cut(c) + 1 && kept[r - 1] && kept[r - 1][c] !== ' ' && kept[r - 1][c] !== 'K' && out[r + PADY + bob][c + PADX] === ' ') out[r + PADY + bob][c + PADX] = 'K';
      }
    } else {
      var lim = SH - PADY - 2;
      function solid(rr, cc) { return rr >= 0 && rr < lim && cc >= 0 && cc < COLS && kept[rr][cc] !== ' ' && kept[rr][cc] !== 'K'; }
      for (r = 0; r < lim; r++) for (c = 0; c < COLS; c++) {
        if (kept[r][c] !== ' ') continue;
        if ((solid(r - 1, c) || solid(r + 1, c) || solid(r, c - 1) || solid(r, c + 1)) && out[r + PADY + bob] && out[r + PADY + bob][c + PADX] === ' ') out[r + PADY + bob][c + PADX] = 'K';
      }
    }

    var cols = { K: '#000000', W: P.coat, D: P.shade, M: P.muzzle, L: P.sock, H: '#10184a', C: P.cap, R: P.silk, Y: P.cloth, S: '#f8aa8c', N: '#000000' };
    var cv = document.createElement('canvas'); cv.width = SW; cv.height = SH;
    var g = cv.getContext('2d');
    for (r = 0; r < SH; r++) for (c = 0; c < SW; c++) {
      var k = out[r][c]; if (k === ' ') continue;
      if (dir < 0 && k === 'N') k = 'Y';
      g.fillStyle = cols[k] || '#ff00ff';
      var x = dir > 0 ? c : SW - 1 - c;
      g.fillRect(x, r, 1, 1);
    }
    // the number stays upright when the sprite is mirrored
    if (dir < 0) {
      g.fillStyle = '#000';
      for (r = 0; r < 7; r++) for (c = 0; c < 5; c++) if (gl[r][c] === '#') g.fillRect(SW - 1 - PADX - 42 + c, PADY + bob + 24 + r, 1, 1);
    }
    return cv;
  }

  var cache = {};
  function get(no, dir, phase, standing) {
    var step = standing ? 0 : Math.floor(phase / (Math.PI * 2) * STEPS) % STEPS;
    if (step < 0) step += STEPS;
    var key = (window.HORSE_VARIANT | 0) + '' + no + (dir > 0 ? 'r' : 'l') + (standing ? 's' : step);
    return cache[key] || (cache[key] = makeSprite(no, dir, step, standing));
  }

  window.HorseSprites = { get: get, SW: SW, SH: SH, OX: OX, OY: OY, STEPS: STEPS, COLORS: HORSE };
})();
