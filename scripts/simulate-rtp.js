#!/usr/bin/env node
// Long-run check of the fixed-odds game:  node scripts/simulate-rtp.js [races] [rtp percent]
// Odds are shuffled every race, draw weights follow the RTP setting (see server/odds.js buildForRtp).
// Prints the RTP a player would have had by always betting a pair that carries a given odds value.
const rng = require('../server/rng.js');
const oddsLib = require('../server/odds.js');
const races = +process.argv[2] || 1000000, rtp = (+process.argv[3] || 90) / 100;
const base = oddsLib.build(), values = rng.COMBOS.map((c) => base.odds[c]).sort((a, b) => a - b);
const t0 = oddsLib.buildForRtp(null, rtp);
const wins = {}, byOdds = {};
values.forEach((v) => { byOdds[v] = 0; });
for (let i = 0; i < races; i++) {
  const seed = rng.newSeed(), lay = rng.oddsLayout(seed, i, values), tab = oddsLib.buildForRtp(lay, rtp), d = rng.draw(seed, i, tab.weights);
  byOdds[lay[d.combo]]++;
}
console.log('races ' + races + ', RTP setting ' + (rtp * 100).toFixed(2) + '%, stake fee ' + (t0.fee * 100).toFixed(2) + '%');
console.log('best bets ' + (t0.bestRtp * 100).toFixed(2) + '%, 3 cheapest pairs ' + (t0.cheapRtp * 100).toFixed(2) + '%, even spread ' + (t0.evenSpread * 100).toFixed(2) + '%\n');
console.log('odds   win chance   wins       RTP expected   RTP simulated');
let paid = 0;
const cheapOdds = new Set(t0.cheap.map((c) => base.odds[c]));
values.forEach((v) => {
  const c = rng.COMBOS.find((x) => t0.odds[x] === v), p = t0.prob[c], sim = byOdds[v] * v / races / (1 + t0.fee);
  paid += byOdds[v] * v;
  console.log(String(v).padEnd(7) + (p * 100).toFixed(3).padStart(8) + '%   ' + String(byOdds[v]).padEnd(10) + ((t0.rtpBy[c]) * 100).toFixed(2).padStart(8) + '%' + (cheapOdds.has(v) && t0.cheapRtp < t0.bestRtp - 0.0005 ? '*' : ' ') + '      ' + (sim * 100).toFixed(1) + '%');
});
console.log('\n* the three cheapest pairs\nbetting every pair each race: ' + (paid / (races * 15 * (1 + t0.fee)) * 100).toFixed(2) + '%');
