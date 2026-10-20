#!/usr/bin/env node
// Long-run check of the fixed-odds game:  node scripts/simulate-rtp.js [races]
// Prints, for every pair, the RTP a player betting only on that pair would have had.
const rng = require('../server/rng.js');
const oddsLib = require('../server/odds.js');
const races = +process.argv[2] || 2000000;
const t = oddsLib.build(), values = rng.COMBOS.map((c) => t.odds[c]), wins = {}, byOdds = {};
rng.COMBOS.forEach((c) => { wins[c] = 0; });
let paid = 0, paidOne = 0; const pick = '2-5';
for (let i = 0; i < races; i++) {
  const seed = rng.newSeed(), lay = rng.oddsLayout(seed, i, values), tab = oddsLib.build(lay), d = rng.draw(seed, i, tab.weights);
  wins[d.combo]++; byOdds[lay[d.combo]] = (byOdds[lay[d.combo]] || 0) + 1;
  paid += lay[d.combo];                                   // betting 1 on every pair: only the winning pair pays
  if (d.combo === pick) paidOne += lay[pick];
}
console.log('races ' + races + ', theoretical RTP of every bet ' + (t.rtp * 100).toFixed(2) + '% (odds shuffled every race)\n');
console.log('odds   probability   wins      simulated RTP when this odds value is the winner');
values.slice().sort((a, b) => a - b).forEach((v) => {
  const p = (1 / v) / values.reduce((x, o) => x + 1 / o, 0);
  console.log(String(v).padEnd(7) + (p * 100).toFixed(3).padStart(8) + '%   ' + String(byOdds[v] || 0).padEnd(9) + (((byOdds[v] || 0) * v / races) * 100).toFixed(1) + '%');
});
console.log('\nbetting every pair each race: ' + (paid / (races * 15) * 100).toFixed(2) + '%');
console.log('always betting pair ' + pick + ': ' + (paidOne / races * 100).toFixed(2) + '%   (each pair wins ' + (100 / 15).toFixed(2) + '% of races)');
