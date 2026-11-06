/*
 * Bingo Pinball 16, the fairness check in the browser: re-draws a play from (server seed, client seed, nonce) exactly as docs/bingo16/MATH.md says and compares it with what the
 * server reported. Written from that text (like docs/bingo16/verify_play.py), not from the server's code; test/bingo16.test.js runs it against the known-answer vectors
 * in docs/bingo16/test-vectors.json. Uses only WebCrypto (HMAC-SHA-256, SHA-256): window.Bingo16Fair / require.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Bingo16Fair = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var LINES = [[0, 1, 2, 3], [4, 5, 6, 7], [8, 9, 10, 11], [12, 13, 14, 15], [0, 4, 8, 12], [1, 5, 9, 13], [2, 6, 10, 14], [3, 7, 11, 15], [0, 5, 10, 15], [3, 6, 9, 12]];
  var ROWS = [[0, 1, 2, 3], [4, 5, 6, 7], [8, 9, 10, 11], [12, 13, 14, 15]], COLS = [[0, 4, 8, 12], [1, 5, 9, 13], [2, 6, 10, 14], [3, 7, 11, 15]];
  /** the twelve patterns, best first: [key, name, pay in half stakes, the ways to make it] */
  var PATTERNS = [
    ['full', 'FULL CARD', 10000, [[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]]],
    ['bigbox', 'BIG BOX', 1000, [[0, 1, 2, 3, 4, 7, 8, 11, 12, 13, 14, 15]]],
    ['zshape', 'Z SHAPE', 160, [[0, 1, 2, 3, 6, 9, 12, 13, 14, 15]]],
    ['equal', 'EQUAL', 20, [[0, 1, 2, 3, 12, 13, 14, 15]]],
    ['eleven', 'NUMBER ELEVEN', 20, [[0, 4, 8, 12, 3, 7, 11, 15]]],
    ['lucky7', 'LUCKY SEVEN', 8, [[0, 1, 2, 3, 6, 9, 12]]],
    ['lshape', 'L SHAPE', 8, [[0, 4, 8, 12, 13, 14, 15]]],
    ['corners', '4 CORNERS', 4, [[0, 3, 12, 15]]],
    ['smallbox', 'SMALL BOX', 4, [[5, 6, 9, 10]]],
    ['diagonal', 'DIAGONAL', 2, [[0, 5, 10, 15], [3, 6, 9, 12]]],
    ['across', 'ACROSS', 1, ROWS],
    ['down', 'DOWN', 1, COLS]
  ];
  var NAMES = {}; PATTERNS.forEach(function (p) { NAMES[p[0]] = p[1]; });

  function subtle() { return crypto.subtle; }
  function utf8(text) { return new TextEncoder().encode(text); }
  function hexToBytes(hex) { var out = new Uint8Array(hex.length / 2); for (var i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16); return out; }
  function toHex(buf) { var b = new Uint8Array(buf), s = ''; for (var i = 0; i < b.length; i++) s += (b[i] < 16 ? '0' : '') + b[i].toString(16); return s; }
  function sha256Hex(text) { return subtle().digest('SHA-256', utf8(text)).then(toHex); }

  /** the 16 balls (slot 1-16, or 0 = missed: it fell into a basket), the five jackpot numbers and the three basket places of a play */
  function draw(serverSeedHex, clientSeed, nonce) {
    var label = 'bingo-pinball-16:' + clientSeed + ':' + nonce, counter = 0, block = null, pos = 32, key = null;
    function nextByte() {
      if (pos < 32) return Promise.resolve(block[pos++]);
      return subtle().sign('HMAC', key, utf8(label + ':' + counter++)).then(function (sig) { block = new Uint8Array(sig); pos = 0; return block[pos++]; });
    }
    function nextInt(n) {                       // uniform in [0, n): rejection sampling on 32-bit numbers
      var limit = 4294967296 - (4294967296 % n);
      return (function again() {
        return nextByte().then(function (a) { return nextByte().then(function (b) { return nextByte().then(function (c) { return nextByte().then(function (d) {
          var v = a * 16777216 + b * 65536 + c * 256 + d;
          return v < limit ? v % n : again();
        }); }); }); });
      })();
    }
    return subtle().importKey('raw', hexToBytes(serverSeedHex), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']).then(function (k) {
      key = k;
      var balls = [], step = Promise.resolve(), i;
      for (i = 0; i < 16; i++) step = step.then(function () { return nextInt(10000); }).then(function (r) { balls.push(r < 1600 ? 0 : Math.floor((r - 1600) / 525) + 1); });
      var a = []; for (i = 1; i <= 16; i++) a.push(i);
      for (i = 0; i < 5; i++) (function (n) { step = step.then(function () { return nextInt(16 - n); }).then(function (r) { var j = n + r, t = a[n]; a[n] = a[j]; a[j] = t; }); })(i);
      var bk = []; for (i = 1; i <= 10; i++) bk.push(i);
      for (i = 0; i < 3; i++) (function (n) { step = step.then(function () { return nextInt(10 - n); }).then(function (r) { var j = n + r, t = bk[n]; bk[n] = bk[j]; bk[j] = t; }); })(i);
      return step.then(function () { return { balls: balls, jackpotNumbers: a.slice(0, 5), baskets: bk.slice(0, 3) }; });
    });
  }

  /** the lit cells, the pattern (by complete lines, and the cells that make it), and how many jackpot numbers hold two balls */
  function evaluate(balls, jackpotNumbers) {
    var lit = {}, i, k;
    balls.forEach(function (b) { if (b > 0) lit[b - 1] = true; });
    var has = function (cells) { return cells.every(function (c) { return lit[c]; }); };
    var full = []; LINES.forEach(function (l, n) { if (has(l)) full.push(n); });
    var pattern = null, cells = [], halves = 0;
    PATTERNS.some(function (p) { return p[3].some(function (w) { if (has(w)) { pattern = p[0]; cells = w.slice(); halves = p[2]; return true; } return false; }); });
    var counts = {}; balls.forEach(function (b) { counts[b] = (counts[b] || 0) + 1; });
    var jp = 0; jackpotNumbers.forEach(function (n) { if ((counts[n] || 0) >= 2) jp++; });
    var litCells = []; for (k in lit) litCells.push(+k + 1); litCells.sort(function (a, b) { return a - b; });
    return { lit: litCells, pattern: pattern, name: pattern ? NAMES[pattern] : null, multiple: halves / 2, halves: halves, cells: cells, lines: full, jackpotLit: jp, jackpot: jp === 5 };
  }

  /**
   * Checks one play against its proof ({serverSeed, commit, clientSeed, nonce}) and its round ({balls, jackpotNumbers, pattern, multiple, jackpotLit, jackpot, patternPay, jackpotPaid, payout, stake}).
   * The jackpot amount itself (the pool at that moment) is the server's figure and cannot be re-derived; everything else can.
   * @return {Promise<{ok:boolean, problems:string[]}>}
   */
  function verify(round, proof) {
    var problems = [];
    return sha256Hex(proof.serverSeed).then(function (commit) {
      if (commit !== proof.commit) problems.push('the server seed is not the one that was committed');
      return draw(proof.serverSeed, proof.clientSeed, proof.nonce);
    }).then(function (d) {
      if (d.balls.join(',') !== round.balls.join(',')) problems.push('the balls are not what the seeds give');
      if (d.jackpotNumbers.join(',') !== round.jackpotNumbers.join(',')) problems.push('the jackpot numbers are not what the seeds give');
      if (round.baskets && d.baskets.join(',') !== round.baskets.join(',')) problems.push('the baskets are not where the seeds put them');
      var e = evaluate(d.balls, d.jackpotNumbers);
      if (e.pattern !== round.pattern) problems.push('the pattern is not what the balls give (' + (e.pattern || 'none') + ')');
      if (e.jackpot !== !!round.jackpot || e.jackpotLit !== round.jackpotLit) problems.push('the jackpot numbers lit are not what the balls give');
      var want = Math.floor(round.stake * e.halves / 2); if (want !== round.patternPay) problems.push('the pattern pay is not what the paytable gives (' + want + ')');
      if (round.patternPay + round.jackpotPaid !== round.payout) problems.push('the payout is not the pattern pay plus the jackpot');
      if (!round.jackpot && round.jackpotPaid !== 0) problems.push('a jackpot was paid without all five numbers lit');
      return { ok: problems.length === 0, problems: problems };
    });
  }

  return { LINES: LINES, NAMES: NAMES, draw: draw, evaluate: evaluate, verify: verify, sha256Hex: sha256Hex };
});
