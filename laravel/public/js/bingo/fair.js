/*
 * Bingo Pinball, the fairness check in the browser: re-draws a play from (server seed, client seed, nonce) exactly as docs/bingo/MATH.md says and compares it with
 * what the server reported. Written from that text (like docs/bingo/verify_play.py), not from the server's code; tests/ (test/bingo-fair.test.js) run it against the
 * known-answer vectors in docs/bingo/test-vectors.json. Uses only WebCrypto (HMAC-SHA-256, SHA-256): window.BingoFair / require.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BingoFair = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // the 12 lines of the card, as cell indexes: rows 0-4, columns 5-9, diagonals 10-11 (the same order as the server)
  var LINES = [
    [0, 1, 2, 3, 4], [5, 6, 7, 8, 9], [10, 11, 12, 13, 14], [15, 16, 17, 18, 19], [20, 21, 22, 23, 24],
    [0, 5, 10, 15, 20], [1, 6, 11, 16, 21], [2, 7, 12, 17, 22], [3, 8, 13, 18, 23], [4, 9, 14, 19, 24],
    [0, 6, 12, 18, 24], [4, 8, 12, 16, 20]
  ];

  function subtle() { return crypto.subtle; }
  function utf8(text) { return new TextEncoder().encode(text); }
  function hexToBytes(hex) {
    var out = new Uint8Array(hex.length / 2);
    for (var i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
    return out;
  }
  function toHex(buf) {
    var b = new Uint8Array(buf), s = '';
    for (var i = 0; i < b.length; i++) s += (b[i] < 16 ? '0' : '') + b[i].toString(16);
    return s;
  }

  /** the commit: sha256 of the server seed written as its 64 hex characters */
  function sha256Hex(text) { return subtle().digest('SHA-256', utf8(text)).then(toHex); }

  /** the five holes of a play, in the order the balls end in them */
  function holes(serverSeedHex, clientSeed, nonce) {
    var label = 'bingo-pinball:' + clientSeed + ':' + nonce, counter = 0, block = null, pos = 32, key = null;
    function nextByte() {
      if (pos < 32) return Promise.resolve(block[pos++]);
      var text = label + ':' + counter++;
      return subtle().sign('HMAC', key, utf8(text)).then(function (sig) { block = new Uint8Array(sig); pos = 0; return block[pos++]; });
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
      var a = []; for (var i = 1; i <= 25; i++) a.push(i);
      var step = Promise.resolve();
      for (var i2 = 0; i2 < 5; i2++) {
        (function (i) {
          step = step.then(function () { return nextInt(25 - i); }).then(function (r) { var j = i + r, t = a[i]; a[i] = a[j]; a[j] = t; });
        })(i2);
      }
      return step.then(function () { return a.slice(0, 5); });
    });
  }

  /** which cells light and the best line (the lowest line index when several tie) */
  function evaluate(card, fiveHoles) {
    var lit = {}, litCells = [], i;
    for (i = 0; i < fiveHoles.length; i++) { var c = card.indexOf(fiveHoles[i]); lit[c] = true; litCells.push(c); }
    litCells.sort(function (a, b) { return a - b; });
    var best = 0, line = null;
    for (i = 0; i < LINES.length; i++) {
      var n = 0; for (var k = 0; k < 5; k++) if (lit[LINES[i][k]]) n++;
      if (n > best) { best = n; line = i; }
    }
    return { lit: best, line: line, litCells: litCells, lineCells: line === null ? [] : LINES[line].filter(function (c) { return lit[c]; }) };
  }

  /**
   * Checks one play against its proof ({serverSeed, commit, clientSeed, nonce, holes, paytable:{pays, card}}) and its round ({holes, bestLit, bestLine, payout, stake}).
   * @return {Promise<{ok:boolean, problems:string[]}>}
   */
  function verify(round, proof) {
    var problems = [];
    return sha256Hex(proof.serverSeed).then(function (commit) {
      if (commit !== proof.commit) problems.push('the server seed is not the one that was committed');
      return holes(proof.serverSeed, proof.clientSeed, proof.nonce);
    }).then(function (h) {
      if (h.join(',') !== round.holes.join(',')) problems.push('the holes are not what the seeds give (' + h.join(',') + ')');
      var e = evaluate(proof.paytable.card, h), pays = proof.paytable.pays;
      if (e.lit !== round.bestLit) problems.push('the best line is not what the holes give');
      var want = (pays[e.lit] || 0) * round.stake;
      if (want !== round.payout) problems.push('the payout is not what the paytable gives (' + want + ')');
      return { ok: problems.length === 0, problems: problems };
    });
  }

  return { LINES: LINES, holes: holes, evaluate: evaluate, verify: verify, sha256Hex: sha256Hex };
});
