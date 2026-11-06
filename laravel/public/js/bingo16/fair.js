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
  var CORNERS = [0, 3, 12, 15];
  var SQUARES = [[0, 1, 4, 5], [1, 2, 5, 6], [2, 3, 6, 7], [4, 5, 8, 9], [5, 6, 9, 10], [6, 7, 10, 11], [8, 9, 12, 13], [9, 10, 13, 14], [10, 11, 14, 15]];
  var PAYS = { lines2: 30, corners: 15, fullline: 5, square: 2, three: 2 };
  var NAMES = { lines2: '2+ LINES', corners: '4 CORNERS', fullline: 'FULL LINE', square: '2x2 SQUARE', three: '3 ON LINE' };

  function subtle() { return crypto.subtle; }
  function utf8(text) { return new TextEncoder().encode(text); }
  function hexToBytes(hex) { var out = new Uint8Array(hex.length / 2); for (var i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16); return out; }
  function toHex(buf) { var b = new Uint8Array(buf), s = ''; for (var i = 0; i < b.length; i++) s += (b[i] < 16 ? '0' : '') + b[i].toString(16); return s; }
  function sha256Hex(text) { return subtle().digest('SHA-256', utf8(text)).then(toHex); }

  /** the 16 balls (slot 1-16, 0 = drained OUT) and the five jackpot numbers of a play */
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
      for (i = 0; i < 16; i++) step = step.then(function () { return nextInt(10000); }).then(function (r) { balls.push(r < 184 * 16 ? Math.floor(r / 184) + 1 : 0); });
      var a = []; for (i = 1; i <= 16; i++) a.push(i);
      for (i = 0; i < 5; i++) (function (n) { step = step.then(function () { return nextInt(16 - n); }).then(function (r) { var j = n + r, t = a[n]; a[n] = a[j]; a[j] = t; }); })(i);
      return step.then(function () { return { balls: balls, jackpotNumbers: a.slice(0, 5) }; });
    });
  }

  /** the lit cells, the best pattern (and the cells that make it), and how many jackpot numbers are lit */
  function evaluate(balls, jackpotNumbers) {
    var lit = {}, i, k;
    balls.forEach(function (b) { if (b > 0) lit[b - 1] = true; });
    var has = function (cells) { return cells.every(function (c) { return lit[c]; }); };
    var full = []; LINES.forEach(function (l, n) { if (has(l)) full.push(n); });
    var pattern = null, cells = [];
    if (full.length >= 2) { pattern = 'lines2'; full.forEach(function (n) { cells = cells.concat(LINES[n]); }); }
    else if (has(CORNERS)) { pattern = 'corners'; cells = CORNERS.slice(); }
    else if (full.length === 1) { pattern = 'fullline'; cells = LINES[full[0]].slice(); }
    else {
      for (i = 0; i < SQUARES.length && !pattern; i++) if (has(SQUARES[i])) { pattern = 'square'; cells = SQUARES[i].slice(); }
      for (i = 0; i < LINES.length && !pattern; i++) {
        var on = LINES[i].filter(function (c) { return lit[c]; });
        if (on.length >= 3) { pattern = 'three'; cells = on; }
      }
    }
    var jp = 0; jackpotNumbers.forEach(function (n) { if (lit[n - 1]) jp++; });
    var litCells = []; for (k in lit) litCells.push(+k + 1); litCells.sort(function (a, b) { return a - b; });
    return { lit: litCells, pattern: pattern, name: pattern ? NAMES[pattern] : null, multiple: pattern ? PAYS[pattern] : 0, cells: cells, lines: full, jackpotLit: jp, jackpot: jp === 5 };
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
      var e = evaluate(d.balls, d.jackpotNumbers);
      if (e.pattern !== round.pattern) problems.push('the pattern is not what the balls give (' + (e.pattern || 'none') + ')');
      if (e.jackpot !== !!round.jackpot || e.jackpotLit !== round.jackpotLit) problems.push('the jackpot numbers lit are not what the balls give');
      if (e.multiple * round.stake !== round.patternPay) problems.push('the pattern pay is not what the paytable gives (' + e.multiple * round.stake + ')');
      if (round.patternPay + round.jackpotPaid !== round.payout) problems.push('the payout is not the pattern pay plus the jackpot');
      if (!round.jackpot && round.jackpotPaid !== 0) problems.push('a jackpot was paid without all five numbers lit');
      return { ok: problems.length === 0, problems: problems };
    });
  }

  return { LINES: LINES, CORNERS: CORNERS, SQUARES: SQUARES, NAMES: NAMES, draw: draw, evaluate: evaluate, verify: verify, sha256Hex: sha256Hex };
});
