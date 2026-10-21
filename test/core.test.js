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

// ---- gallop gait: the 12 key poses of the reference sheet, smooth between them, hooves down only part of the stride ----
{
  const G = require('../public/js/gait.js');
  assert.strictEqual(G.FRAMES, 12);
  const a = G.pose(0.99999), b = G.pose(0.00001);
  ['hf', 'hn', 'ff', 'fn'].forEach((k) => a[k].forEach((v, i) => assert(Math.abs(v - b[k][i]) < 0.01, 'gait jumps at the stride wrap: ' + k)));
  ['hf', 'hn', 'ff', 'fn'].forEach((k) => G.KEY[k].forEach((f, n) => {            // a sprite step is exactly a key pose
    const p = G.pose(n / 12)[k];
    assert(Math.abs(p[0] - f[0]) < 1e-9 && Math.abs(p[1] - f[1]) < 1e-9, 'key pose ' + k + n);
  }));
  let air = 0;
  for (let n = 0; n < 12; n++) if (['hf', 'hn', 'ff', 'fn'].every((k) => G.KEY[k][n][2] === 0)) air++;
  assert(air >= 3 && air <= 5, 'the gathered flight phase is about a third of the stride: ' + air);   // all four hooves off the ground
  for (let i = 0; i < 240; i++) { const p = G.pose(i / 240); ['hf', 'hn', 'ff', 'fn'].forEach((k) => p[k].forEach((v) => assert(Number.isFinite(v)))); assert(p.lift >= 0 && p.lift <= 1); }
  assert(G.pose(7 / 12).fn[1] < -0.9);                                              // frame 8: forelegs tucked, cannons folded back
  assert(G.pose(7 / 12).hn[0] > 0.3);                                               // and the hind legs swung forward under the belly
  assert(G.pose(2 / 12).hf[1] < -1.5);                                              // frame 3: hind legs folded high behind
  assert(G.pose(7 / 12).pitch > G.pose(0).pitch);                                   // the front is highest in the flight phase
  assert(G.stretch([0.5, 0.5, 1], 21, 10, 11) > 1 && G.stretch([0.5, 0.5, 0], 21, 10, 11) === 1);
  console.log('gait tests passed');
}
