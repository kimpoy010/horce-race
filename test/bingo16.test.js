'use strict';
/*
 * Bingo Pinball 16, the browser side that does not need a browser: the board (public/js/bingo16/table.js), the library of ball paths (paths-data.js) and the
 * generator that makes it (bin/bingo16-paths.cjs, deterministic).
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..', 'laravel');
const load = require(path.join(root, 'bin', 'lib-browser-script.cjs'));
const T = load('public/js/bingo16/table.js');
const { webcrypto } = require('crypto');
const Fair = load('public/js/bingo16/fair.js', { crypto: webcrypto, TextEncoder });
const same = (a, b, msg) => assert.strictEqual(JSON.stringify(a), JSON.stringify(b), msg);

function loadPaths(file) {
  const ctx = { window: {} };
  require('vm').runInNewContext(fs.readFileSync(file, 'utf8'), ctx);
  return ctx.window.B16_PATHS;
}
function decode(p) {
  const b = Buffer.from(p.d, 'base64');
  const f = [[b.readUInt16LE(0) / 2, b.readUInt16LE(2) / 2]];
  for (let o = 4; o < b.length; o += 2) f.push([f[f.length - 1][0] + b.readInt8(o) / 2, f[f.length - 1][1] + b.readInt8(o + 1) / 2]);
  return f;
}

const bouncesOf = (frames) => { let n = 0, prev = null; for (let i = 1; i < frames.length - 3; i++) { const vx = frames[i][0] - frames[i - 1][0], vy = frames[i][1] - frames[i - 1][1], sp = Math.hypot(vx, vy); if (prev && sp > 0.8 && prev.sp > 0.8 && (vx * prev.vx + vy * prev.vy) / (sp * prev.sp) < 0.86) n++; prev = { vx, vy, sp }; } return n; };

/* ---------- the board ---------- */
assert.strictEqual(T.slots.length, 16);
assert.strictEqual(T.pegs.length, 9 * 13 + 9 * 12, '18 staggered rows of 13 and 12 pegs');
T.slots.forEach((s, i) => { assert.strictEqual(s.n, i + 1); assert.strictEqual(s.xr - s.xl, 33); assert.strictEqual(s.xl, 10 + 33 * i); });
assert.ok(T.slots[15].xr < T.LANE.l, 'the slots end before the plunger lane');
assert.ok(T.slots.every((s, i) => i === 0 || s.xl === T.slots[i - 1].xr), 'the slots touch: there is no gap, so every ball ends in a slot');
assert.ok(T.pegs.every((p) => p.x > 8 && p.x < T.LANE.l && p.y > 14 && p.y < T.RIM_Y), 'every peg is inside the field');

/* ---------- the library of ball paths ---------- */
const file = path.join(root, 'public', 'js', 'bingo16', 'paths-data.js');
const lib = loadPaths(file);
assert.strictEqual(lib.v, 1); assert.strictEqual(lib.fps, T.FPS);
assert.ok(fs.statSync(file).size < 250 * 1024, 'the library stays small (a phone downloads it): ' + fs.statSync(file).size);
let total = 0, longest = 0;
for (let s = 1; s <= 16; s++) {
  const list = lib.slots[s];
  assert.ok(list && list.length >= 30, ('slot ' + s) + ' has at least 30 paths, has ' + (list ? list.length : 0));
  assert.strictEqual(new Set(list.map((p) => Math.min(4, Math.floor(p.p / 20)))).size, 5, ('slot ' + s) + ' has paths for every range of plunger power');
  for (const p of list) {
    total++;
    const f = decode(p);
    longest = Math.max(longest, f.length);
    assert.ok(f.length >= 25 && f.length <= 270, 'a path has between 0.8 and 9 seconds of flight');
    assert.ok(Math.abs(f[0][0] - T.LANE.x) <= 1 && Math.abs(f[0][1] - T.LANE.startY) <= 1, 'every ball starts in the plunger lane');
    const last = f[f.length - 1];
    const slot = T.slots[s - 1];
    assert.ok(last[0] > slot.xl && last[0] < slot.xr && last[1] > T.RIM_Y && last[1] <= T.SLOT_BOTTOM, 'slot ' + s + ': the path ends inside the slot (' + last + ')');
    for (let i = 1; i < f.length; i++) {
      assert.ok(f[i][0] >= 0 && f[i][0] <= T.W && f[i][1] >= 0 && f[i][1] <= T.H + 20, 'inside the board');
      assert.ok(Math.hypot(f[i][0] - f[i - 1][0], f[i][1] - f[i - 1][1]) < 64, 'no jumps between frames');
    }
    assert.ok(bouncesOf(f) >= 3, ('slot ' + s) + ': every path hits at least three pegs or walls on the way');
    for (const other of T.slots) {                          // a ball bound for a slot never passes down through another slot
      if (other.n === s) continue;
      assert.ok(!f.some((q) => q[1] > T.RIM_Y + 10 && q[0] > other.xl + 2 && q[0] < other.xr - 2), 'slot ' + s + ': a path falls into slot ' + other.n);
    }
  }
}
assert.strictEqual(total, 480);

/* ---------- the generator is deterministic ---------- */
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'b16paths-'));
const run = (name) => { const out = path.join(dir, name); execFileSync('node', [path.join(root, 'bin', 'bingo16-paths.cjs'), '--shots', '60000', '--seed', '7', '--out', out], { cwd: root, stdio: 'pipe' }); return fs.readFileSync(out, 'utf8'); };
assert.strictEqual(run('a.js'), run('b.js'), 'the same options give the same library');
fs.rmSync(dir, { recursive: true, force: true });

/* ---------- playback ---------- */
const lp = require('vm');
const ctx = { window: { B16_PATHS: lib }, atob: (s) => Buffer.from(s, 'base64').toString('binary') };
lp.runInNewContext(fs.readFileSync(path.join(root, 'public', 'js', 'bingo16', 'paths.js'), 'utf8'), ctx);
const P = ctx.window.Bingo16Paths;
for (const outcome of [1, 8, 16]) for (const power of [0, 0.5, 1]) {
  const pk = P.pick(outcome, power);
  assert.ok(pk && pk.frames.length > 25 && Math.abs(pk.power - power) <= 0.3, 'a path for outcome ' + outcome + ' at power ' + power);
  const end = P.at(pk.frames, P.duration(pk.frames));
  assert.ok(Math.hypot(end.x - pk.frames[pk.frames.length - 1][0], end.y - pk.frames[pk.frames.length - 1][1]) < 0.01, 'playback ends where the path ends');
  assert.ok(P.bounces(pk.frames).length >= 3, 'the ball hits pegs on the way');
}
(async () => {
  /* ---------- the fairness check in the browser agrees with the server and the Python reference ---------- */
  const vectors = JSON.parse(fs.readFileSync(path.join(root, 'docs', 'bingo16', 'test-vectors.json'), 'utf8'));
  for (const v of vectors) {
    const d = await Fair.draw(v.serverSeed, v.clientSeed, v.nonce);
    same(d.balls, v.balls, 'balls of ' + v.clientSeed); same(d.jackpotNumbers, v.jackpotNumbers, 'jackpot numbers of ' + v.clientSeed);
    const e = Fair.evaluate(d.balls, d.jackpotNumbers);
    same([e.lit, e.pattern, e.halves, e.cells.map((c) => c + 1).sort((a, b) => a - b), e.jackpotLit, e.jackpot], [v.lit, v.pattern, v.halves, v.cells, v.jackpotLit, v.jackpot], 'evaluation of ' + v.clientSeed);
    assert.strictEqual(await Fair.sha256Hex(v.serverSeed), v.commit);
    const stake = 1000, round = { balls: v.balls, jackpotNumbers: v.jackpotNumbers, pattern: v.pattern, jackpotLit: v.jackpotLit, jackpot: v.jackpot, stake, patternPay: Math.floor(v.halves * stake / 2), jackpotPaid: v.jackpot ? 5000 : 0, payout: Math.floor(v.halves * stake / 2) + (v.jackpot ? 5000 : 0) };
    const ok = await Fair.verify(round, { serverSeed: v.serverSeed, commit: v.commit, clientSeed: v.clientSeed, nonce: v.nonce });
    assert.ok(ok.ok, 'verify ' + v.clientSeed + ': ' + ok.problems.join('; '));
    const bad = await Fair.verify(Object.assign({}, round, { payout: round.payout + 1 }), { serverSeed: v.serverSeed, commit: v.commit, clientSeed: v.clientSeed, nonce: v.nonce });
    assert.ok(!bad.ok, 'a wrong payout is found');
  }
  console.log('fairness check in the browser: ' + vectors.length + ' known-answer plays agree with the server and the Python reference');
console.log('path library: ' + total + ' paths, 16 slots, longest ' + (longest / T.FPS).toFixed(1) + ' s, ' + (fs.statSync(file).size / 1024).toFixed(0) + ' KB');
  console.log('bingo16 tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
