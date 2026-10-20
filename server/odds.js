'use strict';
/*
 * Fixed payout odds per winning pair (the video karera board). A bet pays stake x odds (stake included).
 *
 * To keep every pair equally fair, a pair with odds o is drawn with probability proportional to 1/o:
 * P(pair) = (1/o) / sum(1/o). Then every bet on every pair has the same RTP = 1 / sum(1/o), whichever pair the
 * player picks. For the default table that is 86.84%.
 */
const COMBOS = [];
for (let a = 1; a <= 6; a++) for (let b = a + 1; b <= 6; b++) COMBOS.push(a + '-' + b);

const DEFAULT_ODDS = {
  '1-2': 60, '1-3': 20, '1-4': 80, '1-5': 175, '1-6': 3,
  '2-3': 8, '2-4': 500, '2-5': 30, '2-6': 1000,
  '3-4': 10, '3-5': 125, '3-6': 5,
  '4-5': 100, '4-6': 4,
  '5-6': 250
};

function build(odds) {
  odds = odds || DEFAULT_ODDS;
  COMBOS.forEach((c) => { if (!(odds[c] > 1)) throw new Error('odds missing or <= 1 for pair ' + c); });
  const weights = COMBOS.map((c) => Math.round(1e9 / odds[c]));            // integer weights, sum stays below 2^32
  const total = weights.reduce((a, b) => a + b, 0);
  const prob = {}, rtpBy = {};
  COMBOS.forEach((c, i) => { prob[c] = weights[i] / total; rtpBy[c] = prob[c] * odds[c]; });
  const rtps = COMBOS.map((c) => rtpBy[c]);
  return { odds, weights, total, prob, rtpBy, rtpMin: Math.min.apply(null, rtps), rtpMax: Math.max.apply(null, rtps), rtp: 1 / COMBOS.reduce((a, c) => a + 1 / odds[c], 0) };
}

module.exports = { COMBOS, DEFAULT_ODDS, build };
