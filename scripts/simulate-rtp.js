#!/usr/bin/env node
// Long-run RTP check of the fixed-odds game:  node scripts/simulate-rtp.js [rounds] [rtp]
const rng = require('../server/rng.js');
const rounds = +process.argv[2] || 2000000, rtp = +process.argv[3] || 0.9;
const mult = Math.round(rtp * 15 * 1000);                    // 13.5x -> 13500 (thousandths)
let staked = 0, paid = 0;
const wins = {}; rng.COMBOS.forEach((c) => { wins[c] = 0; });
for (let i = 0; i < rounds; i++) {
  const pick = rng.COMBOS[Math.floor(Math.random() * 15)], stake = 1000;
  const d = rng.draw(rng.newSeed(), i);
  staked += stake; wins[d.combo]++;
  if (d.combo === pick) paid += Math.floor(stake * mult / 1000);
}
console.log('rounds ' + rounds + ', payout x' + mult / 1000 + ', theoretical RTP ' + (mult / 15000 * 100).toFixed(2) + '%, simulated RTP ' + (paid / staked * 100).toFixed(2) + '%');
console.log('wins per pair (expected ' + (rounds / 15).toFixed(0) + '):', JSON.stringify(wins));
