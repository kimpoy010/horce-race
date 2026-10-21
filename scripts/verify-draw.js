#!/usr/bin/env node
'use strict';
/*
 * Checks the provably-fair proof of a finished race:
 *   node scripts/verify-draw.js <raceNo> [baseUrl]        (default http://localhost:8080)
 * 1. sha256(seed) equals the commit that was published before betting closed
 * 2. the shuffled odds layout is what the seed gives
 * 3. the draw (winning pair and finishing order) is what the seed and the odds give
 */
const rng = require('../server/rng.js');
const odds = require('../server/odds.js');

(async () => {
  const raceNo = Number(process.argv[2]), base = (process.argv[3] || 'http://localhost:8080').replace(/\/$/, '');
  if (!Number.isInteger(raceNo)) { console.error('usage: node scripts/verify-draw.js <raceNo> [baseUrl]'); process.exit(2); }
  const res = await fetch(base + '/api/round/' + raceNo), p = await res.json();
  if (!p.ok) { console.error('no proof for race ' + raceNo + ': ' + p.error + ' (the seed is revealed after the race)'); process.exit(2); }
  const checks = [];
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  checks.push(['sha256(seed) == commit', rng.commitOf(p.seed) === p.commit]);
  const values = Object.values(p.odds).sort((a, b) => a - b);
  checks.push(['odds layout from the seed', same(rng.oddsLayout(p.seed, raceNo, values), p.odds)]);
  const d = rng.draw(p.seed, raceNo, odds.buildForRtp(p.odds, p.rtp).weights);
  checks.push(['winning pair from the seed and the odds', d.combo === p.combo]);
  const exact = same(d.order, p.order), pairOnly = same(d.order.slice(2), p.order.slice(2)) && same(d.order.slice(0, 2).sort(), p.order.slice(0, 2).slice().sort());
  checks.push(['finishing order', exact || pairOnly, exact ? '' : '(races before the "lower number first" rule picked the order of the two winners at random)']);
  let ok = true;
  console.log('race ' + raceNo + '  commit ' + p.commit + '  winning pair ' + p.combo + '  RTP ' + p.rtp);
  checks.forEach((c) => { console.log((c[1] ? 'OK    ' : 'FAIL  ') + c[0] + ' ' + (c[2] || '')); ok = ok && c[1]; });
  console.log(ok ? 'The draw is verified.' : 'The draw does NOT verify.');
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error(e.message); process.exit(2); });
