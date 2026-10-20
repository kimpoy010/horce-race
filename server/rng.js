'use strict';
/*
 * Race outcome draw. Every race outcome comes from a secret 256-bit server seed:
 *   - the seed is generated with crypto.randomBytes when the round opens,
 *   - its SHA-256 hash ("commit") is published before bets are taken,
 *   - the seed is revealed after the race, so anyone can re-run draw() and check the result.
 * The pair is drawn with the integer weights from server/odds.js (probability proportional to 1 / odds), with rejection
 * sampling so there is no modulo bias. Without weights all 15 pairs are equally likely.
 */
const crypto = require('crypto');

const PAIRS = [];
for (let a = 1; a <= 6; a++) for (let b = a + 1; b <= 6; b++) PAIRS.push([a, b]);
const COMBOS = PAIRS.map((p) => p[0] + '-' + p[1]);

function newSeed() { return crypto.randomBytes(32).toString('hex'); }
function commitOf(seedHex) { return crypto.createHash('sha256').update(seedHex, 'utf8').digest('hex'); }

// deterministic byte stream: HMAC-SHA256(seed, label:counter)
class Stream {
  constructor(seedHex, label) { this.key = Buffer.from(seedHex, 'hex'); this.label = label; this.ctr = 0; this.buf = Buffer.alloc(0); this.pos = 0; }
  byte() {
    if (this.pos >= this.buf.length) {
      this.buf = crypto.createHmac('sha256', this.key).update(this.label + ':' + this.ctr++).digest();
      this.pos = 0;
    }
    return this.buf[this.pos++];
  }
  uint32() { return ((this.byte() << 24) | (this.byte() << 16) | (this.byte() << 8) | this.byte()) >>> 0; }
  // uniform integer in [0, max)
  int(max) {
    const limit = 4294967296 - (4294967296 % max);
    let v;
    do { v = this.uint32(); } while (v >= limit);
    return v % max;
  }
}

// returns the full finishing order (all six horses) and the winning combination (the pair that finishes 1st + 2nd)
function pickPair(s, weights) {
  if (!weights) return PAIRS[s.int(PAIRS.length)];
  let total = 0; for (const w of weights) total += w;
  let r = s.int(total);
  for (let i = 0; i < weights.length; i++) { if (r < weights[i]) return PAIRS[i]; r -= weights[i]; }
  return PAIRS[PAIRS.length - 1];
}

function draw(seedHex, raceNo, weights) {
  const s = new Stream(seedHex, 'race:' + raceNo);
  const pair = pickPair(s, weights);
  const top = s.int(2) ? [pair[1], pair[0]] : [pair[0], pair[1]];
  const rest = [1, 2, 3, 4, 5, 6].filter((n) => n !== pair[0] && n !== pair[1]);
  for (let i = rest.length - 1; i > 0; i--) { const j = s.int(i + 1); const t = rest[i]; rest[i] = rest[j]; rest[j] = t; }
  return { combo: pair[0] + '-' + pair[1], order: top.concat(rest), animSeed: s.uint32() };
}

// The odds of each race: the same 15 odds values shuffled over the 15 pairs. Derived from the round seed with its own
// label, so it is public from the start of betting without telling anything about the draw ('race:' stream).
function oddsLayout(seedHex, raceNo, values) {
  const s = new Stream(seedHex, 'odds:' + raceNo), v = values.slice();
  for (let i = v.length - 1; i > 0; i--) { const j = s.int(i + 1); const t = v[i]; v[i] = v[j]; v[j] = t; }
  const out = {}; COMBOS.forEach((c, i) => { out[c] = v[i]; });
  return out;
}

module.exports = { PAIRS, COMBOS, newSeed, commitOf, draw, oddsLayout, Stream };
