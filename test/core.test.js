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
    for (let t = 0; t <= 41; t += 0.05) { const p = C.progress(h, t); assert(p >= prev - 1e-9); prev = p; }
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
