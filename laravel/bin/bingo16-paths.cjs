#!/usr/bin/env node
'use strict';
/*
 * Builds the library of ball paths for Bingo Pinball 16 (public/js/bingo16/paths-data.js).
 *
 * It fires many simulated shots at the board (bin/lib-bingo16-sim.cjs, deterministic: the same options always give the same file) and keeps, for every outcome of a ball -
 * each of the 16 slots and for each of the ten places of a basket - a handful of paths for each range of plunger power. The page never simulates: when the server has decided
 * where the balls end, the page picks a stored path that ends there, at about the power the player pulled. The animation can therefore never disagree with the result.
 *
 *   node bin/bingo16-paths.cjs [--shots 350000] [--basket-shots 200000] [--seed 20261101] [--out public/js/bingo16/paths-data.js]
 *
 * Paths are stored at 30 frames per second in half-unit steps: the first position as two 16-bit numbers, then one signed byte per axis per frame (the change since the
 * frame before), as base64. Playback interpolates between the frames.
 */
const fs = require('fs');
const path = require('path');
const load = require('./lib-browser-script.cjs');
const { simulate, mulberry32 } = require('./lib-bingo16-sim.cjs');

const argv = process.argv.slice(2);
const opt = (name, dflt) => { const i = argv.indexOf('--' + name); return i >= 0 ? argv[i + 1] : dflt; };
const SHOTS = +opt('shots', 350000);
const BASKET_SHOTS = +opt('basket-shots', 200000);
const SEED = +opt('seed', 20261101);
const OUT = path.resolve(opt('out', path.join(__dirname, '..', 'public', 'js', 'bingo16', 'paths-data.js')));
const BUCKETS = 5;                  // ranges of plunger power
const PER_BUCKET = 6;               // paths kept per outcome and range
const MIN_FRAMES = 25;
const MIN_BOUNCES = 3;             // a ball that only drops straight down is not kept: every path hits something on the way
const MIN_PER_OUTCOME = BUCKETS * PER_BUCKET;
const CAP = 500;                    // candidates kept per outcome and power range (memory)

const T = load('public/js/bingo16/table.js');

const different = (a, b) => [20, 35, 50, 65, 80].some((k) => k < a.frames.length && k < b.frames.length && Math.hypot(a.frames[k][0] - b.frames[k][0], a.frames[k][1] - b.frames[k][1]) > 12);

/** fires `shots` shots at the board for `target` (null = the plain board) and returns the candidates by outcome (a slot 1-16, or the target cup) */
function fire(rnd, shots, target) {
  const cand = new Map(), seen = new Map();
  for (let i = 0; i < shots; i++) {
    const power = rnd(), jitter = (rnd() - 0.5) * 30;
    const r = simulate(T, power, jitter, target);
    if (!r.ok || r.frames.length < MIN_FRAMES || (target ? r.spot !== target : r.slot < 1)) continue;
    if (bounces(r.frames.map(([x, y]) => [Math.round(x * 2) / 2, Math.round(y * 2) / 2])) < MIN_BOUNCES) continue;
    const key = target ? 'b' + target : 's' + r.slot, b = Math.min(BUCKETS - 1, Math.floor(power * BUCKETS));
    if (!cand.has(key)) { cand.set(key, []); seen.set(key, new Array(BUCKETS).fill(0)); }
    seen.get(key)[b]++;
    if (seen.get(key)[b] <= CAP) cand.get(key).push({ power, frames: r.frames });             // the first CAP of each outcome and power range (the shots are random: no bias)
  }
  return { cand, seen };
}

/** the handful of paths to keep for one outcome: different from each other, short first, every power range covered */
function choose(list) {
  const pick = [];
  for (const limit of [90, 120, 180, 270]) {                              // short paths first (a play has 16 balls); longer ones only where an outcome is hard to reach
    for (let b = 0; b < BUCKETS; b++) {
      const lo = b / BUCKETS, hi = (b + 1) / BUCKETS;
      const inBucket = pick.filter((p) => p.power >= lo && p.power < hi);
      for (const c of list) {
        if (inBucket.length >= PER_BUCKET) break;
        if (c.power < lo || c.power >= hi || c.frames.length > limit || pick.includes(c)) continue;
        if (inBucket.every((p) => different(p, c))) { pick.push(c); inBucket.push(c); }
      }
    }
    if (pick.length >= MIN_PER_OUTCOME) break;
  }
  pick.sort((a, b) => a.power - b.power);
  return pick;
}

function main() {
  const rnd = mulberry32(SEED);
  const slots = {}, baskets = {}, report = [];
  const plain = fire(rnd, SHOTS, null);
  const note = (name, key, c, seen, pick) => report.push({ name, found: seen.reduce((a, b) => a + b, 0), kept: pick.length, frames: Math.round(pick.reduce((n, p) => n + p.frames.length, 0) / Math.max(1, pick.length)), buckets: Array.from({ length: BUCKETS }, (_, b) => pick.filter((p) => p.power >= b / BUCKETS && p.power < (b + 1) / BUCKETS).length) });
  for (let s = 1; s <= 16; s++) {
    const key = 's' + s, pick = choose(plain.cand.get(key) || []);
    slots[s] = pick.map(encode);
    note('slot ' + String(s).padStart(2), key, null, plain.seen.get(key) || [0], pick);
  }
  for (let n = 1; n <= T.baskets.length; n++) {                          // the ten places of a basket: shots at the board with the cup of that place
    const f = fire(rnd, BASKET_SHOTS, n), key = 'b' + n, pick = choose(f.cand.get(key) || []);
    baskets[n] = pick.map(encode);
    note('basket ' + String(n).padStart(2), key, null, f.seen.get(key) || [0], pick);
  }
  const data = { v: 2, fps: T.FPS, unit: 2, shots: SHOTS, basketShots: BASKET_SHOTS, seed: SEED, slots, baskets };
  const text = '/* Bingo Pinball 16: library of ball paths, made by bin/bingo16-paths.cjs (' + SHOTS + ' simulated shots for the slots and ' + BASKET_SHOTS + ' for each basket place, seed ' + SEED + '). Do not edit by hand. */\n'
    + 'window.B16_PATHS = ' + JSON.stringify(data) + ';\n';
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, text);
  const total = report.reduce((n, r) => n + r.kept, 0);
  console.log('paths kept: ' + total + ' for 16 slots and 10 basket places (fewest ' + Math.min(...report.map((r) => r.kept)) + ', most ' + Math.max(...report.map((r) => r.kept)) + '), ' + (text.length / 1024).toFixed(0) + ' KB -> ' + OUT);
  report.forEach((r) => console.log('  ' + r.name + ': ' + String(r.found).padStart(6) + ' shots, ' + String(r.kept).padStart(2) + ' kept, avg ' + (r.frames / T.FPS).toFixed(1) + ' s, per power range ' + r.buckets.join('/')));
  const thin = report.filter((r) => r.kept < MIN_PER_OUTCOME);
  if (thin.length) console.log('WARNING outcomes with fewer than ' + MIN_PER_OUTCOME + ' paths:', thin.map((r) => r.name).join(','));
  return report;
}

/** how many times the ball turned sharply (it hit a peg or a wall); the same rule as Bingo16Paths.bounces in public/js/bingo16/paths.js, which the page uses for sounds */
function bounces(frames) {
  let n = 0, prev = null;
  for (let i = 1; i < frames.length - 3; i++) {
    const vx = frames[i][0] - frames[i - 1][0], vy = frames[i][1] - frames[i - 1][1], sp = Math.hypot(vx, vy);
    if (prev && sp > 0.8 && prev.sp > 0.8 && (vx * prev.vx + vy * prev.vy) / (sp * prev.sp) < 0.86) n++;
    prev = { vx, vy, sp };
  }
  return n;
}

/** a path as bytes: the first position (2 x uint16 in half units), then 2 x int8 per following frame */
function encode(c) {
  const q = c.frames.map(([x, y]) => [Math.round(x * 2), Math.round(y * 2)]);
  const buf = Buffer.alloc(4 + (q.length - 1) * 2);
  buf.writeUInt16LE(q[0][0], 0); buf.writeUInt16LE(q[0][1], 2);
  let o = 4;
  for (let i = 1; i < q.length; i++) {
    const dx = q[i][0] - q[i - 1][0], dy = q[i][1] - q[i - 1][1];
    if (Math.abs(dx) > 127 || Math.abs(dy) > 127) throw new Error('a ball moved more than 63 units in one frame');
    buf.writeInt8(dx, o++); buf.writeInt8(dy, o++);
  }
  return { p: Math.round(c.power * 100), d: buf.toString('base64') };
}

if (require.main === module) main();
module.exports = { main, encode };
