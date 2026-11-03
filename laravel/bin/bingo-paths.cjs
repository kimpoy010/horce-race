#!/usr/bin/env node
'use strict';
/*
 * Builds the library of ball paths for Bingo Pinball (public/js/bingo/paths-data.js).
 *
 * It fires many simulated shots at the table (bin/lib-bingo-sim.cjs, deterministic: the same options always give the same file) and keeps, for every one of the
 * 25 holes, a handful of paths for each range of plunger power. The page never simulates: when the server has decided where the balls end, the page picks a stored
 * path that ends in that hole, at about the power the player pulled. The animation can therefore never disagree with the result.
 *
 * Every path was recorded with all 25 holes open, so it never runs over another hole's mouth: it is valid whichever holes already hold a ball.
 *
 *   node bin/bingo-paths.cjs [--shots 400000] [--seed 20260101] [--out public/js/bingo/paths-data.js]
 *
 * Paths are stored at 20 frames per second in half-pixel units: the first position as two 16-bit numbers, then one signed byte per axis per frame (the change since the
 * frame before), all as base64. Playback interpolates between the frames.
 */
const fs = require('fs');
const path = require('path');
const load = require('./lib-browser-script.cjs');
const { simulate, mulberry32 } = require('./lib-bingo-sim.cjs');

const argv = process.argv.slice(2);
const opt = (name, dflt) => { const i = argv.indexOf('--' + name); return i >= 0 ? argv[i + 1] : dflt; };
const SHOTS = +opt('shots', 400000);
const SEED = +opt('seed', 20260101);
const OUT = path.resolve(opt('out', path.join(__dirname, '..', 'public', 'js', 'bingo', 'paths-data.js')));
const BUCKETS = 6;                 // ranges of plunger power
const PER_BUCKET = 6;              // paths kept per hole and range
const MAX_FRAMES = 110;            // 5.5 seconds: a play of five balls should take about 15-20 seconds
const MIN_FRAMES = 30;             // not a ball that drops straight into a hole
const MIN_PER_HOLE = BUCKETS * PER_BUCKET;      // every range of power filled

const T = load('public/js/bingo/table.js');

function main() {
  const rnd = mulberry32(SEED);
  const cand = Array.from({ length: 26 }, () => []);
  for (let i = 0; i < SHOTS; i++) {
    const power = rnd(), jitter = (rnd() - 0.5) * 16;
    const r = simulate(T, power, jitter);
    if (r.ok && r.frames.length >= MIN_FRAMES) cand[r.hole].push({ power, frames: r.frames });
  }
  const chosen = {};
  const report = [];
  for (let h = 1; h <= 25; h++) {
    const pick = [];
    const different = (a, b) => [10, 20, 30, 40, 55].some((k) => k < a.frames.length && k < b.frames.length && Math.hypot(a.frames[k][0] - b.frames[k][0], a.frames[k][1] - b.frames[k][1]) > 4);
    for (const limit of [MAX_FRAMES, 150, 220]) {                          // short paths first; longer ones only for a hole that is hard to reach
      for (let b = 0; b < BUCKETS; b++) {
        const lo = b / BUCKETS, hi = (b + 1) / BUCKETS;
        const inBucket = pick.filter((p) => p.power >= lo && p.power < hi);
        for (const c of cand[h]) {
          if (inBucket.length >= PER_BUCKET) break;
          if (c.power < lo || c.power >= hi || c.frames.length > limit || pick.includes(c)) continue;
          if (inBucket.every((p) => different(p, c))) { pick.push(c); inBucket.push(c); }
        }
      }
      if (pick.length >= MIN_PER_HOLE) break;
    }
    pick.sort((a, b) => a.power - b.power);
    chosen[h] = pick.map(encode);
    report.push({ h, found: cand[h].length, kept: pick.length, buckets: Array.from({ length: BUCKETS }, (_, b) => pick.filter((p) => p.power >= b / BUCKETS && p.power < (b + 1) / BUCKETS).length) });
  }
  const data = { v: 1, fps: T.FPS, unit: 2, shots: SHOTS, seed: SEED, holes: chosen };
  const text = '/* Bingo Pinball: library of ball paths, made by bin/bingo-paths.cjs (' + SHOTS + ' simulated shots, seed ' + SEED + '). Do not edit by hand. */\n'
    + 'window.BP_PATHS = ' + JSON.stringify(data) + ';\n';
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, text);
  const total = report.reduce((n, r) => n + r.kept, 0);
  console.log('paths kept: ' + total + ' for 25 holes (fewest ' + Math.min(...report.map((r) => r.kept)) + ', most ' + Math.max(...report.map((r) => r.kept)) + '), ' + (text.length / 1024).toFixed(0) + ' KB -> ' + OUT);
  const thin = report.filter((r) => r.kept < MIN_PER_HOLE);
  if (thin.length) console.log('WARNING holes with fewer than ' + MIN_PER_HOLE + ' paths:', JSON.stringify(thin));
  return report;
}

/** a path as bytes: the first position (2 x uint16 in half pixels), then 2 x int8 per following frame */
function encode(c) {
  const q = c.frames.map(([x, y]) => [Math.round(x * 2), Math.round(y * 2)]);
  const buf = Buffer.alloc(4 + (q.length - 1) * 2);
  buf.writeUInt16LE(q[0][0], 0); buf.writeUInt16LE(q[0][1], 2);
  let o = 4;
  for (let i = 1; i < q.length; i++) {
    const dx = q[i][0] - q[i - 1][0], dy = q[i][1] - q[i - 1][1];
    if (Math.abs(dx) > 127 || Math.abs(dy) > 127) throw new Error('a ball moved more than 63 px in one frame');
    buf.writeInt8(dx, o++); buf.writeInt8(dy, o++);
  }
  return { p: Math.round(c.power * 100), d: buf.toString('base64') };
}

if (require.main === module) main();
module.exports = { main, encode };
