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

const MIN_RTP = 0.88, MAX_RTP = 0.99, CHEAP_PAIRS = 3;

/*
 * Draw weights for an RTP setting between 88% and 99%, with the odds themselves unchanged and no fees.
 * The 12 pairs with the higher odds all return exactly `rtp` (drawn with probability rtp / odds). The probability that
 * is left over is shared by the three cheapest pairs, which therefore return a bit less (about 85.4% at a 90% setting).
 * No bet returns more than the setting. rtpBy is the return per unit staked.
 * The setting must be at least the RTP the odds give when every pair is drawn with probability 1 / odds
 * (86.84% for the default odds), otherwise it is rejected.
 */
function buildForRtp(odds, rtp) {
  odds = odds || DEFAULT_ODDS;
  if (!(rtp >= MIN_RTP - 1e-9 && rtp <= MAX_RTP + 1e-9)) throw new Error('RTP must be between 88% and 99%');
  const S = COMBOS.reduce((a, c) => a + 1 / odds[c], 0), uniform = 1 / S;
  if (rtp < uniform - 1e-9) throw new Error('these odds cannot give an RTP below ' + (uniform * 100).toFixed(2) + '%');
  const order = COMBOS.slice().sort((a, b) => odds[a] - odds[b] || (a < b ? -1 : 1));
  const cheap = order.slice(0, CHEAP_PAIRS), isCheap = new Set(cheap), prob = {};
  const a = cheap.reduce((s2, c) => s2 + 1 / odds[c], 0), r = (1 - rtp * (S - a)) / a;       // RTP of the cheap pairs
  COMBOS.forEach((c) => { prob[c] = (isCheap.has(c) ? r : rtp) / odds[c]; });
  const weights = COMBOS.map((c) => Math.round(prob[c] * 1e9)), total = weights.reduce((x, y) => x + y, 0), rtpBy = {};
  COMBOS.forEach((c, i) => { prob[c] = weights[i] / total; rtpBy[c] = prob[c] * odds[c]; });
  const rts = COMBOS.map((c) => rtpBy[c]);
  return {
    odds, weights, total, prob, rtpBy, setting: rtp, uniform, cheap,
    cheapRtp: Math.min.apply(null, cheap.map((c) => rtpBy[c])), bestRtp: Math.max.apply(null, rts), evenSpread: rts.reduce((x, y) => x + y, 0) / rts.length
  };
}

module.exports = { COMBOS, DEFAULT_ODDS, build, buildForRtp, MIN_RTP, MAX_RTP, CHEAP_PAIRS };
