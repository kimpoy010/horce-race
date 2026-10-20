#!/usr/bin/env node
// Long-run check of the fixed-odds game:  node scripts/simulate-rtp.js [races]
// Prints, for every pair, the RTP a player betting only on that pair would have had.
const rng = require('../server/rng.js');
const oddsLib = require('../server/odds.js');
const races = +process.argv[2] || 2000000;
const t = oddsLib.build(), wins = {};
rng.COMBOS.forEach((c) => { wins[c] = 0; });
for (let i = 0; i < races; i++) wins[rng.draw(rng.newSeed(), i, t.weights).combo]++;
console.log('races ' + races + ', theoretical RTP of every bet ' + (t.rtp * 100).toFixed(2) + '%\n');
console.log('pair  odds   probability   wins      simulated RTP');
let paid = 0;
rng.COMBOS.forEach((c) => {
  paid += wins[c] * t.odds[c];
  console.log(c.padEnd(5) + String(t.odds[c]).padEnd(7) + (t.prob[c] * 100).toFixed(3).padStart(8) + '%   ' + String(wins[c]).padEnd(9) + ((wins[c] * t.odds[c] / races) * 100).toFixed(1) + '%');
});
console.log('\nbetting every pair equally: ' + (paid / (races * 15) * 100).toFixed(2) + '%');
