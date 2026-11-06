/*
 * Fruit Game, the fairness check in the browser: re-draws a spin and its double-ups (and the parts of the win moved to the balance on the way) from (server seed, client seed, nonce) exactly as docs/fruit/MATH.md says and compares them with what
 * the server reported. Written from that text (like docs/fruit/verify_play.py), not from the server's code; test/fruit.test.js runs it against docs/fruit/test-vectors.json.
 * Uses only WebCrypto (HMAC-SHA-256, SHA-256): window.FruitFair / require.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FruitFair = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var SYMBOLS = ['bar', 'seven', 'star', 'watermelon', 'bell', 'lemon', 'orange', 'apple'];
  var PAYS = { bar: 30, seven: 10, star: 7, watermelon: 5, bell: 5, lemon: 4, orange: 2, apple: 2 };
  var KINDS = [['orange', 1], ['bell', 1], ['bar50', 1], ['bar3', 1], ['apple', 1], ['apple', 3], ['lemon', 1], ['watermelon', 1], ['watermelon', 3], ['free3', 1], ['apple', 1], ['orange', 3],
    ['orange', 1], ['bell', 1], ['seven', 3], ['seven', 1], ['apple', 1], ['lemon', 3], ['lemon', 1], ['star', 3], ['star', 1], ['light3', 1], ['apple', 1], ['bell', 3]];
  var WEIGHTS = [8041,3216,1914,1914,5744,5744,4020,4020,4020,1908,5744,8041,8041,3216,2010,2010,5744,4020,4020,2872,2872,1909,5744,3216];
  var W = 100000;

  function subtle() { return crypto.subtle; }
  function utf8(text) { return new TextEncoder().encode(text); }
  function hexToBytes(hex) { var out = new Uint8Array(hex.length / 2); for (var i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16); return out; }
  function toHex(buf) { var b = new Uint8Array(buf), s = ''; for (var i = 0; i < b.length; i++) s += (b[i] < 16 ? '0' : '') + b[i].toString(16); return s; }
  function sha256Hex(text) { return subtle().digest('SHA-256', utf8(text)).then(toHex); }
  function symbolOf(k) { var c = KINDS[k][0]; return c === 'bar3' || c === 'bar50' ? 'bar' : (c === 'free3' || c === 'light3' ? 'lucky' : c); }
  function cellPay(k) { var c = KINDS[k][0], m = KINDS[k][1]; return c === 'bar3' ? PAYS.bar : c === 'bar50' ? 12 : (c === 'free3' || c === 'light3') ? 0 : PAYS[c] * m; }

  /** a stream of uniform integers from the HMAC stream of a label */
  function stream(serverSeedHex, label) {
    var counter = 0, block = null, pos = 32, key = null;
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
    return subtle().importKey('raw', hexToBytes(serverSeedHex), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']).then(function (k) { key = k; return nextInt; });
  }
  function pick(r, cells) { for (var i = 0; i < cells.length; i++) { if (r < WEIGHTS[cells[i]]) return cells[i]; r -= WEIGHTS[cells[i]]; } throw new Error('weights'); }
  function all() { var a = []; for (var i = 0; i < 24; i++) a.push(i); return a; }

  /** the rounds of a spin: [[stop]], [[stop],[a],[b],[c]] (3 free spins) or [[stop],[a,b,c]] (a free spin with 3 lit cells) */
  function spin(serverSeedHex, clientSeed, nonce) {
    return stream(serverSeedHex, 'fruit-ring:' + clientSeed + ':' + nonce).then(function (nextInt) {
      return nextInt(W).then(function (r) {
        var stop = pick(r, all()), kind = KINDS[stop][0];
        if (kind !== 'free3' && kind !== 'light3') return [[stop]];
        var non = all().filter(function (i) { return symbolOf(i) !== 'lucky'; }), wn = non.reduce(function (s, i) { return s + WEIGHTS[i]; }, 0), cells = [];
        return nextInt(wn).then(function (a) { cells.push(pick(a, non)); return nextInt(wn); }).then(function (b) { cells.push(pick(b, non)); return nextInt(wn); }).then(function (c) {
          cells.push(pick(c, non));
          return kind === 'free3' ? [[stop], [cells[0]], [cells[1]], [cells[2]]] : [[stop], cells];
        });
      });
    });
  }
  /** the number 1-14 of a double-up (Small 1-7, Big 8-14) */
  function doubleNumber(serverSeedHex, clientSeed, nonce) { return stream(serverSeedHex, 'fruit-double:' + clientSeed + ':' + nonce).then(function (nextInt) { return nextInt(14); }).then(function (n) { return n + 1; }); }

  /** credits paid for one credit on each symbol */
  function payouts(rounds) {
    var out = {}; SYMBOLS.forEach(function (s) { out[s] = 0; });
    rounds.forEach(function (r) { r.forEach(function (c) { var s = symbolOf(c); if (s !== 'lucky') out[s] += cellPay(c); }); });
    return out;
  }
  function winOf(rounds, bets) { var p = payouts(rounds), t = 0; SYMBOLS.forEach(function (s) { t += (bets[s] || 0) * p[s]; }); return t; }

  /**
   * Checks one round against its proof ({serverSeed, commit, clientSeed, nonce, rounds, doubles}) and the round the server showed ({rounds, bets, credit, spinWin, doubles, payout, stake}).
   * @return {Promise<{ok:boolean, problems:string[]}>}
   */
  function verify(round, proof) {
    var problems = [];
    return sha256Hex(proof.serverSeed).then(function (commit) {
      if (commit !== proof.commit) problems.push('the server seed is not the one that was committed');
      return spin(proof.serverSeed, proof.clientSeed, proof.nonce);
    }).then(function (rounds) {
      if (JSON.stringify(rounds) !== JSON.stringify(round.rounds)) problems.push('the lit cells are not what the seeds give');
      var win = winOf(rounds, round.bets || {}) * round.credit, held = win, taken = 0, chain = Promise.resolve();
      if (win !== round.spinWin) problems.push('the win of the spin is not what the paytable gives (' + win + ')');
      (round.doubles || []).forEach(function (d, n) {
        chain = chain.then(function () { return doubleNumber(proof.serverSeed, proof.clientSeed, d.nonce); }).then(function (num) {
          var won = d.side === 'small' ? num <= 7 : num >= 8;
          if (num !== d.number) problems.push('double-up ' + (n + 1) + ': the number is not what the seeds give (' + num + ')');
          if (won !== d.won) problems.push('double-up ' + (n + 1) + ': the result is not what the number gives');
          var take = d.take || 0;                                                    // moved to the balance before this double-up: not risked
          if (take >= held) problems.push('double-up ' + (n + 1) + ': more was taken than the win');
          taken += take; held = won ? (held - take) * 2 : 0;
        });
      });
      return chain.then(function () {
        if (round.status === 'settled' && held + taken !== round.payout) problems.push('the payout is not what the double-ups leave (' + (held + taken) + ')');
        return { ok: problems.length === 0, problems: problems };
      });
    });
  }

  return { spin: spin, doubleNumber: doubleNumber, payouts: payouts, winOf: winOf, verify: verify, sha256Hex: sha256Hex, WEIGHTS: WEIGHTS, SYMBOLS: SYMBOLS };
});
