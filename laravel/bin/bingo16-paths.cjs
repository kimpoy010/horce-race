#!/usr/bin/env node
'use strict';
/*
 * Builds the library of ball paths for Bingo Pinball 16 (public/js/bingo16/paths-data.js).
 *
 * It fires many simulated shots at the board (bin/lib-bingo16-sim.cjs, deterministic: the same options always give the same file) and keeps, for every outcome of a ball -
 * each of the 16 slots and OUT (the ball drains between the slots) - a handful of paths for each range of plunger power. The page never simulates: when the server has decided
 * where the balls end, the page picks a stored path that ends there, at about the power the player pulled. The animation can therefore never disagree with the result.
 *
 *   node bin/bingo16-paths.cjs [--shots 300000] [--seed 20261101] [--out public/js/bingo16/paths-data.js]
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
const SHOTS = +opt('shots', 300000);
const SEED = +opt('seed', 20261101);
const OUT = path.resolve(opt('out', path.join(__dirname, '..', 'public', 'js', 'bingo16', 'paths-data.js')));
const BUCKETS = 5;                  // ranges of plunger power
const PER_BUCKET = 6;               // paths kept per outcome and range
const MIN_FRAMES = 25;
const MIN_BOUNCES = 3;             // a ball that only drops straight down is not kept: every path hits something on the way
const MIN_PER_OUTCOME = BUCKETS * PER_BUCKET;
const CAP = 500;                    // candidates kept per outcome and power range (memory)

const T = load('public/js/bingo16/table.js');

function main() {
  const rnd = mulberry32(SEED);
  const cand = Array.from({ length: 17 }, () => []);
  const seen = Array.from({ length: 17 }, () => new Array(BUCKETS).fill(0));
  for (let i = 0; i < SHOTS; i++) {
    const power = rnd(), jitter = (rnd() - 0.5) * 30;
    const r = simulate(T, power, jitter);
    if (r.ok && r.frames.length >= MIN_FRAMES && bounces(r.frames.map(([x, y]) => [Math.round(x * 2) / 2, Math.round(y * 2) / 2])) >= MIN_BOUNCES) {
      const b = Math.min(BUCKETS - 1, Math.floor(power * BUCKETS));
      seen[r.slot][b]++;
      if (seen[r.slot][b] <= CAP) cand[r.slot].push({ power, frames: r.frames });             // the first CAP of each outcome and power range (the shots are random: no bias)
    }
  }
  const chosen = {}, report = [];
  const different = (a, b) => [20, 35, 50, 65, 80].some((k) => k < a.frames.length && k < b.frames.length && Math.hypot(a.frames[k][0] - b.frames[k][0], a.frames[k][1] - b.frames[k][1]) > 12);
  for (let s = 0; s <= 16; s++) {
    const pick = [];
    for (const limit of [90, 120, 180, 270]) {                              // short paths first (a play has 16 balls); longer ones only where an outcome is hard to reach
      for (let b = 0; b < BUCKETS; b++) {
        const lo = b / BUCKETS, hi = (b + 1) / BUCKETS;
        const inBucket = pick.filter((p) => p.power >= lo && p.power < hi);
        for (const c of cand[s]) {
          if (inBucket.length >= PER_BUCKET) break;
          if (c.power < lo || c.power >= hi || c.frames.length > limit || pick.includes(c)) continue;
          if (inBucket.every((p) => different(p, c))) { pick.push(c); inBucket.push(c); }
        }
      }
      if (pick.length >= MIN_PER_OUTCOME) break;
    }
    pick.sort((a, b) => a.power - b.power);
    chosen[s] = pick.map(encode);
    report.push({ slot: s, found: seen[s].reduce((a, b) => a + b, 0), kept: pick.length, frames: Math.round(pick.reduce((n, p) => n + p.frames.length, 0) / Math.max(1, pick.length)), buckets: Array.from({ length: BUCKETS }, (_, b) => pick.filter((p) => p.power >= b / BUCKETS && p.power < (b + 1) / BUCKETS).length) });
  }
  const data = { v: 1, fps: T.FPS, unit: 2, shots: SHOTS, seed: SEED, slots: chosen };
  const text = '/* Bingo Pinball 16: library of ball paths, made by bin/bingo16-paths.cjs (' + SHOTS + ' simulated shots, seed ' + SEED + '). Do not edit by hand. */\n'
    + 'window.B16_PATHS = ' + JSON.stringify(data) + ';\n';
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, text);
  const total = report.reduce((n, r) => n + r.kept, 0);
  console.log('paths kept: ' + total + ' for 16 slots and OUT (fewest ' + Math.min(...report.map((r) => r.kept)) + ', most ' + Math.max(...report.map((r) => r.kept)) + '), ' + (text.length / 1024).toFixed(0) + ' KB -> ' + OUT);
  report.forEach((r) => console.log('  ' + (r.slot ? 'slot ' + String(r.slot).padStart(2) : 'OUT    ') + ': ' + String(r.found).padStart(6) + ' shots, ' + String(r.kept).padStart(2) + ' kept, avg ' + (r.frames / T.FPS).toFixed(1) + ' s, per power range ' + r.buckets.join('/')));
  const thin = report.filter((r) => r.kept < MIN_PER_OUTCOME);
  if (thin.length) console.log('WARNING outcomes with fewer than ' + MIN_PER_OUTCOME + ' paths:', thin.map((r) => r.slot).join(','));
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
