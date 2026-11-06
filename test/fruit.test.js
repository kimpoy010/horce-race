'use strict';
/* Fruit Ring, the browser side that does not need a browser: the ring (public/js/fruit/table.js) against the maths, the pictures, and the plan of the light (anim.js). */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', 'laravel');
const load = require(path.join(root, 'bin', 'lib-browser-script.cjs'));
const T = load('public/js/fruit/table.js');
const A = load('public/js/fruit/art.js');
const P = load('public/js/fruit/anim.js');

/* ---------- the ring is the ring of the maths ---------- */
const py = fs.readFileSync(path.join(root, 'docs', 'fruit', 'verify_play.py'), 'utf8');
const ringText = py.slice(py.indexOf('RING = ['), py.indexOf('assert sum(c[2] for c in RING)'));
const pyRing = [...ringText.matchAll(/\('([a-z0-9]+)',\s*(\d),\s*(\d+)\)/g)].map((m) => [m[1], +m[2]]);
assert.strictEqual(pyRing.length, 24);
assert.strictEqual(JSON.stringify(T.RING), JSON.stringify(pyRing), 'the page draws the same 24 cells, in the same order, as the maths');
assert.strictEqual(T.cells.length, 24);

/* ---------- the geometry: a closed loop of neighbours round a 7 x 7 border ---------- */
const seen = new Set();
for (const c of T.cells) {
  const key = c.col + ',' + c.row;
  assert.ok(!seen.has(key), 'no two cells on the same place');
  seen.add(key);
  assert.ok(c.col === 0 || c.col === 6 || c.row === 0 || c.row === 6, 'every cell is on the border');
  assert.ok(c.x >= 0 && c.y >= 0 && c.x + c.w <= T.SIZE && c.y + c.h <= T.SIZE, 'inside the drawing');
}
for (let k = 0; k < 24; k++) {
  const a = T.cells[k], b = T.cells[(k + 1) % 24];
  assert.strictEqual(Math.abs(a.col - b.col) + Math.abs(a.row - b.row), 1, 'cell ' + k + ' touches cell ' + ((k + 1) % 24));
}
assert.strictEqual(T.cells[0].col + ',' + T.cells[0].row, '0,0', 'cell 0 is the top left');
assert.strictEqual(T.cells[6].col + ',' + T.cells[6].row, '6,0');
assert.strictEqual(T.cells[12].col + ',' + T.cells[12].row, '6,6');
assert.strictEqual(T.cells[18].col + ',' + T.cells[18].row, '0,6');
assert.ok(T.CENTER.x > T.cells[0].x + T.CELL && T.CENTER.x + T.CENTER.w < T.cells[6].x, 'the centre is inside the ring');

/* ---------- the pictures ---------- */
for (const c of T.cells) assert.ok(A.art(c.kind, c.mult).length > 30, 'a picture for cell ' + c.index + ' (' + c.kind + ')');
for (const s of T.SYMBOLS) assert.ok(A.symbol(s).length > 30, 'a picture for the bet symbol ' + s);
assert.ok(A.art('apple', 3).includes('×3') && !A.art('apple', 1).includes('×3'), 'a x3 cell wears the badge');
for (const k of A.kinds) { const frag = A.art(k, 1); assert.strictEqual((frag.match(/</g) || []).length, (frag.match(/>/g) || []).length, 'balanced tags in ' + k); }

/* ---------- the plan of the light ---------- */
let seed = 7; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
const cases = [[[5]], [[0]], [[23]], [[9], [3], [14], [20]], [[21], [2, 8, 13]], [[9], [11], [11], [11]]];
for (const rounds of cases) for (const start of [0, 7, 23]) {
  const plan = P.plan(rounds, { random: rnd, start });
  let last = -1;
  for (const e of plan.events) { assert.ok(e.at >= last, 'events are in time order'); last = e.at; }
  const lands = plan.events.filter((e) => e.type === 'land');
  assert.strictEqual(lands.length, rounds.length, 'one landing per round');
  rounds.forEach((r, i) => assert.strictEqual(JSON.stringify(lands[i].lights), JSON.stringify(r), 'round ' + i + ' lands exactly on the cells the server chose'));
  // the last running event of each round is already on the target (the light stops there before it lands)
  rounds.forEach((r, i) => { const runs = plan.events.filter((e) => e.type === 'run' && e.round === i); assert.strictEqual(JSON.stringify(runs[runs.length - 1].lights), JSON.stringify(r)); });
  // a single light moves one cell at a time, clockwise
  const single = plan.events.filter((e) => e.type === 'run' && e.lights.length === 1);
  for (let i = 1; i < single.length; i++) if (single[i].round === single[i - 1].round) assert.strictEqual(single[i].lights[0], (single[i - 1].lights[0] + 1) % 24);
  // the light slows down: the last gap is much longer than the first
  const runs = plan.events.filter((e) => e.type === 'run' && e.round === 0);
  assert.ok(runs[runs.length - 1].at - runs[runs.length - 2].at > 4 * (runs[1].at - runs[0].at), 'it slows down before it stops');
  assert.ok(plan.duration > 1500 && plan.duration < 30000, 'a plan lasts a believable time: ' + plan.duration);
  if (rounds.length > 1) assert.ok(plan.events.some((e) => e.type === 'lucky'), 'a Lucky stop flashes');
}
const p = P.plan([[9], [3], [14], [20]], { random: rnd });
assert.strictEqual(P.at(p, -1), null);
assert.strictEqual(P.at(p, p.duration + 1000).type, 'land');
assert.strictEqual(JSON.stringify(P.at(p, p.duration + 1000).lights), '[20]');
assert.ok(P.plan([[5]], { random: rnd, speed: 2 }).duration < P.plan([[5]], { random: rnd, speed: 1 }).duration, 'a faster speed is shorter');
console.log('fruit ring: ring, pictures and light plan agree with the maths');
