'use strict';
const assert = require('assert');
const C = require('../public/js/core.js');

// finishing order always matches the requested combination
for (let i = 0; i < 2000; i++) {
  const a = 1 + (i % 6), b = 1 + ((i + 1 + (i >> 3) % 5) % 6);
  if (a === b) continue;
  const d = new C.Director();
  d.plan[0] = C.normEntry({ a, b, exact: i % 2 === 0 });
  assert(d.startRace(0).ok);
  const o = d.current.order;
  assert.deepStrictEqual(o.slice().sort(), [1, 2, 3, 4, 5, 6]);
  assert.deepStrictEqual(o.slice(0, 2).sort(), [a, b].sort());
  if (i % 2 === 0) assert.deepStrictEqual(o.slice(0, 2), [a, b]);
  const r = C.buildRace(d.current.seed, o);
  // monotonic progress and crossing order matches finishing order
  r.list.forEach((h) => {
    let prev = 0;
    for (let t = 0; t <= 27; t += 0.05) { const p = C.progress(h, t); assert(p >= prev - 1e-9); prev = p; }
    assert(Math.abs(C.progress(h, h.time) - 1) < 1e-9);
  });
  for (let k = 1; k < r.list.length; k++) assert(r.list[k].time > r.list[k - 1].time);
  assert(r.lastTime < C.RACE_MS / 1000 - 1);
}
// public state hides the order until shortly before the gun
const d = new C.Director(); d.startRace(1000);
assert.strictEqual(d.publicState(1000).race.order, null);
assert.notStrictEqual(d.publicState(1000 + C.COUNTDOWN_MS - 1500).race.order, null);
assert(!d.startRace(2000).ok);
// auto mode chains races
d.auto = true; d.tick(1000 + C.COUNTDOWN_MS + C.RACE_MS + C.RESULTS_MS + 1);
assert.strictEqual(d.current.raceNo, 2);
console.log('core tests passed');

// winning combinations: only the 15 pairs 1-2 ... 5-6, always written low-high
{
  const allowed = new Set(['1-2','1-3','1-4','1-5','1-6','2-3','2-4','2-5','2-6','3-4','3-5','3-6','4-5','4-6','5-6']);
  for (let i = 0; i < 2000; i++) {
    const d = new C.Director(); d.startRace(0);
    assert(allowed.has(C.combination(d.current.order).join('-')));
  }
  console.log('combination tests passed');
}

// ---- gallop gait: smooth over the stride, hooves on the ground only part of the time, legs folded in the air ----
{
  const G = require('../public/js/gait.js');
  const a = G.pose(0.99999), b = G.pose(0.00001);
  ['hf', 'hn', 'ff', 'fn'].forEach((k) => a[k].forEach((v, i) => assert(Math.abs(v - b[k][i]) < 0.01, 'gait jumps at the stride wrap: ' + k)));
  let air = 0, N = 200;
  for (let i = 0; i < N; i++) {
    const p = G.pose(i / N), cycle = i / N;
    ['hf', 'hn', 'ff', 'fn'].forEach((k) => p[k].forEach((v) => assert(Number.isFinite(v))));
    const onGround = [['hf', G.LAND.hf, G.STANCE.hind], ['hn', G.LAND.hn, G.STANCE.hind], ['ff', G.LAND.ff, G.STANCE.fore], ['fn', G.LAND.fn, G.STANCE.fore]]
      .some(([k, td, len]) => ((cycle - td + 1) % 1) < len);
    if (!onGround) air++;
  }
  assert(air / N > 0.25 && air / N < 0.45, 'suspension phase should be about a third of the stride: ' + air / N);   // real gallop: all four hooves off the ground
  const folded = G.pose(G.LAND.fn + 0.4).fn;                          // a foreleg in the air has the cannon folded back under the forearm
  assert(folded[1] < -1);
  assert(G.pose(G.LAND.fn + 0.1).fn[1] > -0.3);                        // and is nearly straight while the hoof is planted
  console.log('gait tests passed');
}
