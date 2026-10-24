/*
 * Racehorses in the style of the client's reference picture: chunky flat colours, a white (or recoloured) coat,
 * a coloured far-side set of legs, a jockey in silks and a gold number tag.
 * The body (head, neck, back, tail, jockey, tag) is traced from the reference; the four legs are generated so they can gallop.
 * Sprites are cached per (horse, facing, gait step).
 */
(function () {
  'use strict';

  var COLS = 92, PADX = 20, PADY = 6, SW = COLS + PADX * 2 + 8, SH = 66 + PADY * 2;
  var GROUND = PADY + 60, OX = PADX + 46, OY = GROUND + 1, STEPS = HorseGait.FRAMES;

  // roles: C coat, A accent (far legs, blaze), S silks, F skin / highlight, K black, T number tag
  var BODY = [
    '............................................................................K...............',
    '.............................................................K....KKKKKK....K...............',
    '.............................................................K..............K...............',
    '.............................................................K..............K...............',
    '............................................................................................',
    '.....................................KKKKK....KKKKKKKK.....KKKKK..............KK............',
    '...................................KTSSSSS.KKSSSSSSSSS....TSSSSST.............CC............',
    '...................................TSSSSSSSTTTTSSSSSSST..TSSSSTTT.............CC............',
    '..................................KSSSSSSSSSS.KSSSSSSSSSKSSSST............CCCC...K..........',
    '..................................KSSSSSS.FSS.KSSSKSSSSSKSSKK..........KCCCCCCAAAAAK........',
    '...................................TSSSSSFFFSSTTTTTSSSSSKT.K.FFF.K......CCC...AAAAAK........',
    '...................................KTSSSSSFFSSSKK.SSSSSSK..KFFFF.KC.KCCCCCCAAAAAAAAKK.......',
    '.....................................KSSSSSS.SSKSSKSSSSTKKKKFFFK.CCCCCCCCCCAAAAAAAAAK.......',
    '......................................T.T.SSFFFST.K.T.SSSSTK..C..CCCCCCCCCCAAAA....AA.......',
    '.........................................KSSSFFS.KKKKKSSSSSKK.CCCCCCCCCCCCCAAAA.CC.AAA......',
    '...........................................KKSS.SSKSSSK.SSSSK.CCCCCCCCCCCCCC.AAAACCCAAAK....',
    '............................................K.TFFFS.....SSSSST.CCCCCCCCCCCCC.AAAA...AAAA....',
    '.CCCCCCCCCCCCCCCCCCCC........K..............K..SFFS.....SSSSSSKCCCCCCCCCCCCC.AAAAAAAAAA.....',
    '.CCCCCCCCCCCCCCCCC.K.CCCCCCCCK.TTTTTTTTTTTTTK..KSS.SFCCCCSSSSSSSTKK.CCCCCCCCCCAAAAAAAAAC....',
    '......CCCCCC........CCCCCCCCCK.TTTTT..TTTTTTK..KFFFSFCCCC..STTST....CCCCCCCCCCAAAA.....C....',
    '......................CCCCCCCK.TTTTT..TTTTTTK..KFFSSFCCCCCCS..SK..FCCCCCCCCCC...AA.CCCCCCCK.',
    '....................K.CCCCCCCK.TTTTKK.TTTTTTK..KK.SSFCCCCCCCCCSK.FF.CCCCCCCC.K...K.CCCCCCCK.',
    '.....................CCCCCCCCK.TT.TT..TTTTTTK.....C.CCCCCCCCCCC..CCCCCCCCCC.........CCCC..K.',
    '....................CCCCCCCCCK.TT..TT.TTTTTTK....CCCCCCCCCCCCCCCCCCCCCCCCC..........CCCC....',
    '...................KCCCCCCCCCK.TTTTTT.TTTT.KK....CCCCCCCCC.AAAACCCCCCCCCC.K..........KKKK...',
    '....................CCCCCCCCCK.TTTTTT.TTTTT.K....CCCCCCCCCC.C.A..CCCCCCC....................',
    '...................CCCCCCCCCCK.TTTTTT.TTTTTTK.....CCCCCCCCCCC....CCCCCCC....................',
    '...................CCCCCCCCCCK.TTTTTT.TTTTTTK.....CCCCCCCCCCCCCC.ACCCKKK....................',
    '...................CCCCCCCCCCK.TT...KK..TTTTK..K..CCCCCCCCCCCCCCCC...K......................',
    '...................CCCCCCCCCCK.TT.......TTTTKCC...CCCCCCCCCCCCCCCC..A.......................',
    '...................CCCCCCCCCCK.TTTTTTTTTTTTTKCCCCCCCCCCCCCCCCCCCCCC.K.......................',
    '...................CCCCCCCCCCKK.............KCCCCCCCCCCCCCCCCCCCCCC.........................',
    '...................CCCCCCCCCC........KKK.K...CCCCCCCCCCCCCCCCCCCCCC.........................',
    '.................K.CCCCCCCCCCCCCCCCC.KA..KCCCCCCCCCCCCCCCCCCCCCCCCCCCK......................',
    '................K.CCCCCCCCCCCCCCCCC...KK.K...CCCCCCC....CCCCCCCCCCCCCK......................',
    '.................CCCCCCCCCCCCCCCC...........K...........CCCCCCCCCCCCC.......................',
    '.............KK.CCCCCCCCCCCCCCCCC.......................CCCCCCCCCCCCCC.K....................',
    '.............KCCCCCCCCCCCCCCCCCC.........................CCCCCCCCCCCCCCCK...................',
    '..............CCCCCCCCCCCCCCCCC.........................K.CCCCCCCCCCCCCC....................',
    '..........KK.CCCCCCCCCCCCCCCCC.K.........................K.CCCCCCCCCCCCCCCC.................',
    '..........KCCCCCCCCCCCCCCCCCC.....................................CCCCCCCCC.................'
  ];

  // per-horse colours measured from the reference picture
  var HORSE = {
    1: { coat: '#ffffff', accent: '#2333ed', silk: '#dd4536', skin: '#e09472', tag: '#f0bc4c' },
    2: { coat: '#e361f2', accent: '#964422', silk: '#e09472', skin: '#e09472', tag: '#f0bc4c' },
    3: { coat: '#dd4536', accent: '#2333ed', silk: '#757ca2', skin: '#e09472', tag: '#f0bc4c' },
    4: { coat: '#2333ed', accent: '#964422', silk: '#e892ab', skin: '#e09472', tag: '#f0bc4c' },
    5: { coat: '#f5ec66', accent: '#2333ed', silk: '#85509d', skin: '#e09472', tag: '#f0bc4c' },
    6: { coat: '#44805c', accent: '#964422', silk: '#cec0f0', skin: '#e09472', tag: '#f0bc4c' }
  };
  var DIGITS = {
    1: ['..#..', '.##..', '..#..', '..#..', '..#..', '..#..', '.###.'],
    2: ['.###.', '#...#', '....#', '...#.', '..#..', '.#...', '#####'],
    3: ['.###.', '#...#', '....#', '..##.', '....#', '#...#', '.###.'],
    4: ['...#.', '..##.', '.#.#.', '#..#.', '#####', '...#.', '...#.'],
    5: ['#####', '#....', '####.', '....#', '....#', '#...#', '.###.'],
    6: ['.###.', '#....', '#....', '####.', '#...#', '#...#', '.###.']
  };
  var TAG = { x: 29, y: 17, w: 16, h: 15 };            // the gold number tag inside BODY (columns / rows)

  // lowest kept body row for each column; everything below is replaced by the generated legs
  function cut(c) {
    if (c < 22) return 30;
    if (c < 32) return 31;
    if (c < 42) return 33;
    if (c < 54) return 34;
    if (c < 67) return 35;
    return 31;
  }

  function grid() { var g = []; for (var y = 0; y < SH; y++) { g.push(new Array(SW).fill(' ')); } return g; }

  function stamp(T, x, y, w, h, ch) {
    var x0 = Math.round(x - w / 2), y0 = Math.round(y - h / 2);
    for (var j = 0; j < h; j++) for (var i = 0; i < w; i++) {
      var xx = x0 + i, yy = y0 + j;
      if (yy >= 0 && yy < SH && xx >= 0 && xx < SW) T[yy][xx] = ch;
    }
  }

  // paints one flat-coloured leg: thick upper leg, slim cannon bone, small black hoof
  function paintLeg(out, hx, hy, ang, wTop, L1, L2, ch) {
    var a1 = ang[0], a2 = ang[1], t, n;
    var k = ang[2] || 1; L1 *= k; L2 *= k;
    var K = [hx + L1 * Math.sin(a1), hy + L1 * Math.cos(a1)], F = [K[0] + L2 * Math.sin(a2), K[1] + L2 * Math.cos(a2)];
    n = Math.ceil(L1 * 2);
    for (t = 0; t <= n; t++) { var f = t / n, w = Math.round(wTop + (4 - wTop) * Math.pow(f, 0.7)); stamp(out, hx + (K[0] - hx) * f, hy + (K[1] - hy) * f, w, w, ch); }
    stamp(out, K[0], K[1], 4, 4, ch);
    n = Math.ceil(L2 * 2);
    for (t = 0; t <= n; t++) { var g = t / n, ww = g < 0.8 ? 3 : 2; stamp(out, K[0] + (F[0] - K[0]) * g, K[1] + (F[1] - K[1]) * g, ww, ww, ch); }
    stamp(out, F[0] + Math.sin(a2) * 1.5, F[1] + Math.cos(a2) * 1.5 + 1, 5, 3, 'K');     // a clear dark hoof, wider than the leg
  }

  function makeSprite(no, dir, step, standing) {
    var P = HORSE[no], out = grid(), r, c;
    var gp = window.HorseGait.pose(step / STEPS);
    var legs = { hf: gp.hf, ff: gp.ff, hn: gp.hn, fn: gp.fn };
    if (standing) legs = { hf: [-0.05, -0.05], ff: [-0.08, -0.08], hn: [0.05, 0.05], fn: [0, 0] };
    var bob = standing ? 0 : -Math.round(3.4 * gp.lift);
    var tilt = standing ? 0 : Math.tan(gp.pitch * 0.5);
    var dyAt = function (x) { return Math.round(-(x - (PADX + 46)) * tilt); };
    var HIP = { hf: [PADX + 21, 31], hn: [PADX + 15, 31], ff: [PADX + 61, 34], fn: [PADX + 56, 34] };
    ['hf', 'ff', 'hn', 'fn'].forEach(function (k) {
      if (!standing) legs[k] = [legs[k][0], legs[k][1], window.HorseGait.stretch(legs[k], GROUND - (PADY + HIP[k][1] + bob) - dyAt(HIP[k][0]), 14, 14)];
    });

    // far legs (accent) first, then the near legs in the coat colour, then the body over their tops
    paintLeg(out, HIP.hf[0], PADY + HIP.hf[1] + bob, legs.hf, 10, 14, 14, 'A');
    paintLeg(out, HIP.ff[0], PADY + HIP.ff[1] + bob, legs.ff, 8, 14, 14, 'A');
    paintLeg(out, HIP.hn[0], PADY + HIP.hn[1] + bob, legs.hn, 12, 14, 14, 'C');
    paintLeg(out, HIP.fn[0], PADY + HIP.fn[1] + bob, legs.fn, 9, 14, 14, 'C');

    var gl = DIGITS[no];
    for (r = 0; r < BODY.length; r++) for (c = 0; c < COLS; c++) {
      var ch = BODY[r][c];
      if (ch === '.' || r > cut(c) || (c < 22 && r < 26)) continue;     // the tail is redrawn below
      if (ch === 'F' && c < 50 && r < 20) ch = 'S';                      // no speckled highlights in the silks
      if (ch === 'K' && r < 6) continue;
      var yy = r + PADY + bob, xx = c + PADX;
      if (yy >= 0 && yy < SH) out[yy][xx] = ch;
    }
    // full tail (a tapering sweep) and a solid croup / thigh so the hind legs grow out of the body
    function limb(x0, y0, x1, y1, bx, by, w0, w1, ch) {
      var n = 40, i, t, u;
      for (i = 0; i <= n; i++) {
        t = i / n; u = 1 - t;
        stamp(out, PADX + u * u * x0 + 2 * u * t * bx + t * t * x1, PADY + bob + u * u * y0 + 2 * u * t * by + t * t * y1, Math.round(w0 + (w1 - w0) * t), Math.round(w0 + (w1 - w0) * t), ch);
      }
    }
    limb(23, 19, 2, 27, 11, 16, 6, 2, 'K');                                  // tail outline, then the fill
    limb(23, 19, 2, 27, 11, 16, 4, 1, 'C');
    limb(24, 22, 18, 31, 21, 27, 10, 8, 'C');
    for (c = 22; c < 70; c++) for (r = cut(c) + 1; r <= cut(c) + 3; r++) {     // deeper belly under the cut
      var by = r + PADY + bob; if (out[by][c + PADX] === ' ' || out[by][c + PADX] === 'A') out[by][c + PADX] = 'C';
    }
    // number tag: clear the reference numeral, draw a bold one (bold = each pixel doubled across, rows 2 and 5 doubled down)
    var rowMap = [0, 1, 1, 2, 3, 4, 5, 5, 6];
    for (r = TAG.y; r < TAG.y + TAG.h; r++) for (c = TAG.x; c < TAG.x + TAG.w; c++) {
      var edge = r === TAG.y || r === TAG.y + TAG.h - 1 || c === TAG.x || c === TAG.x + TAG.w - 1;
      out[r + PADY + bob][c + PADX] = edge ? 'K' : 'T';
    }
    var nx = PADX + TAG.x + 5, ny = PADY + TAG.y + 3 + bob;
    for (r = 0; r < 9; r++) for (c = 0; c < 5; c++) if (gl[rowMap[r]][c] === '#') { out[ny + r][nx + c] = 'N'; if (c < 4 && gl[rowMap[r]][c + 1] !== '#') out[ny + r][nx + c + 1] = 'N'; }

    var ol = [];                                                          // thin black outline round the whole horse
    for (r = 0; r < SH; r++) for (c = 0; c < SW; c++) if (out[r][c] === ' ' && ((r > 0 && out[r - 1][c] !== ' ') || (r < SH - 1 && out[r + 1][c] !== ' ') || (c > 0 && out[r][c - 1] !== ' ') || (c < SW - 1 && out[r][c + 1] !== ' '))) ol.push([r, c]);
    ol.forEach(function (q) { out[q[0]][q[1]] = 'K'; });
    if (tilt) {
      var sh = grid(), xs, ys;
      for (xs = 0; xs < SW; xs++) { var d = dyAt(xs); for (ys = 0; ys < SH; ys++) { var y2 = ys + d; if (y2 >= 0 && y2 < SH && out[ys][xs] !== ' ') sh[y2][xs] = out[ys][xs]; } }
      out = sh;
    }
    var cols = { K: '#000000', C: P.coat, A: P.accent, S: P.silk, F: P.skin, T: P.tag, N: '#000000' };
    var cv = document.createElement('canvas'); cv.width = SW; cv.height = SH;
    var g = cv.getContext('2d');
    for (r = 0; r < SH; r++) for (c = 0; c < SW; c++) {
      var k = out[r][c]; if (k === ' ') continue;
      if (dir < 0 && k === 'N') k = 'T';
      g.fillStyle = cols[k] || '#ff00ff';
      g.fillRect(dir > 0 ? c : SW - 1 - c, r, 1, 1);
    }
    if (dir < 0) {                                                       // the number stays upright when the sprite is mirrored
      g.fillStyle = '#000';
      for (r = 0; r < 9; r++) for (c = 0; c < 5; c++) if (gl[rowMap[r]][c] === '#') {
        g.fillRect(SW - 1 - (nx + c), ny + r, 1, 1);
        if (c < 4 && gl[rowMap[r]][c + 1] !== '#') g.fillRect(SW - 1 - (nx + c + 1), ny + r, 1, 1);
      }
    }
    return cv;
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
