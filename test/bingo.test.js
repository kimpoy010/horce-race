'use strict';
/*
 * Bingo Pinball, the browser side that does not need a browser: the library of ball paths (public/js/bingo/paths-data.js), the table it was made on and the
 * fairness check (public/js/bingo/fair.js) against the known-answer vectors of the maths package.
 */
const assert = require('assert');
const same = (a, b, msg) => assert.strictEqual(JSON.stringify(a), JSON.stringify(b), msg);        // the browser scripts run in their own VM context: compare by value
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { webcrypto } = require('crypto');

const root = path.join(__dirname, '..', 'laravel');
const load = require(path.join(root, 'bin', 'lib-browser-script.cjs'));
const T = load('public/js/bingo/table.js');
const Fair = load('public/js/bingo/fair.js', { crypto: webcrypto, TextEncoder });

function loadPaths(file) {
  const ctx = { window: {} };
  require('vm').runInNewContext(fs.readFileSync(file, 'utf8'), ctx);
  return ctx.window.BP_PATHS;
}
function decode(p) {
  const b = Buffer.from(p.d, 'base64');
  const f = [[b.readUInt16LE(0) / 2, b.readUInt16LE(2) / 2]];
  for (let o = 4; o < b.length; o += 2) f.push([f[f.length - 1][0] + b.readInt8(o) / 2, f[f.length - 1][1] + b.readInt8(o + 1) / 2]);
  return f;
}

(async () => {
  /* ---------- the library of ball paths ---------- */
  const file = path.join(root, 'public', 'js', 'bingo', 'paths-data.js');
  const lib = loadPaths(file);
  assert.strictEqual(lib.v, 1); assert.strictEqual(lib.fps, T.FPS);
  assert.ok(fs.statSync(file).size < 250 * 1024, 'the library stays small (a phone downloads it): ' + fs.statSync(file).size);
  let total = 0, longest = 0;
  for (let h = 1; h <= 25; h++) {
    const list = lib.holes[h];
    assert.ok(list && list.length >= 36, 'hole ' + h + ' has at least 36 paths, has ' + (list ? list.length : 0));
    const ranges = new Set(list.map((p) => Math.min(5, Math.floor(p.p / (100 / 6)))));
    assert.strictEqual(ranges.size, 6, 'hole ' + h + ' has paths for every range of plunger power');
    const hole = T.holes[h - 1];
    assert.strictEqual(hole.n, h);
    for (const p of list) {
      total++;
      const f = decode(p);
      longest = Math.max(longest, f.length);
      assert.ok(f.length >= 30 && f.length <= 220, 'a path has between 1.5 and 11 seconds of flight');
      assert.ok(Math.abs(f[0][0] - T.LANE.x) <= 1 && Math.abs(f[0][1] - T.LANE.startY) <= 1, 'every ball starts in the plunger lane');
      const last = f[f.length - 1];
      assert.ok(Math.hypot(last[0] - hole.x, last[1] - hole.y) <= 1, 'hole ' + h + ': the path ends in the hole (' + last + ')');
      for (let i = 1; i < f.length; i++) {
        assert.ok(f[i][0] >= 0 && f[i][0] <= T.W && f[i][1] >= 0 && f[i][1] <= T.H, 'inside the screen');
        assert.ok(Math.hypot(f[i][0] - f[i - 1][0], f[i][1] - f[i - 1][1]) < 45, 'no jumps between frames');
      }
      for (const other of T.holes) {                                      // it never runs over the mouth of another hole: it is valid whichever holes are filled
        if (other.n === h) continue;
        for (const q of f) assert.ok(Math.hypot(q[0] - other.x, q[1] - other.y) > 1.6, 'hole ' + h + ': a path runs over hole ' + other.n);
      }
    }
  }
  assert.ok(total >= 900);
  console.log('path library: ' + total + ' paths, 25 holes, longest ' + (longest / T.FPS).toFixed(1) + ' s, ' + (fs.statSync(file).size / 1024).toFixed(0) + ' KB');

  /* ---------- the generator is deterministic ---------- */
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bingo-paths-'));
  const gen = (seed, out) => execFileSync(process.execPath, [path.join(root, 'bin', 'bingo-paths.cjs'), '--shots', '4000', '--seed', String(seed), '--out', out], { stdio: 'pipe' });
  gen(7, path.join(tmp, 'a.js')); gen(7, path.join(tmp, 'b.js')); gen(8, path.join(tmp, 'c.js'));
  assert.strictEqual(fs.readFileSync(path.join(tmp, 'a.js'), 'utf8'), fs.readFileSync(path.join(tmp, 'b.js'), 'utf8'), 'the same options give the same file');
  assert.notStrictEqual(fs.readFileSync(path.join(tmp, 'a.js'), 'utf8'), fs.readFileSync(path.join(tmp, 'c.js'), 'utf8'));
  fs.rmSync(tmp, { recursive: true, force: true });

  /* ---------- the table ---------- */
  assert.strictEqual(T.holes.length, 25);
  same(T.holes.map((h) => h.n), Array.from({ length: 25 }, (_, i) => i + 1));
  for (const a of T.holes) for (const b of T.holes) if (a !== b) assert.ok(Math.hypot(a.x - b.x, a.y - b.y) > 2 * T.HOLE_R + 4, 'holes do not touch');

  /* ---------- the fairness check, against the known answers of the maths package ---------- */
  const vectors = JSON.parse(fs.readFileSync(path.join(root, 'docs', 'bingo', 'test-vectors.json'), 'utf8')).vectors;
  const PT = { 88: ['[12,1,7,4,21,22,15,3,25,9,6,2,24,16,14,13,8,11,23,17,20,19,10,5,18]', { 3: 2, 4: 3, 5: 75 }], 96: ['[4,8,21,19,20,3,18,5,15,16,24,2,14,23,17,25,6,11,12,10,9,1,22,13,7]', { 3: 2, 4: 6, 5: 150 }] };
  for (const v of vectors) {
    same(await Fair.holes(v.serverSeed, v.clientSeed, v.nonce), v.holes, 'the browser draws the same holes as the server');
    assert.strictEqual(await Fair.sha256Hex(v.serverSeed), v.commit);
    for (const ver of [88, 96]) {
      const card = JSON.parse(PT[ver][0]), e = Fair.evaluate(card, v.holes), x = v.versions[ver];
      assert.strictEqual(e.lit, x.bestLit); assert.strictEqual(e.line, x.bestLineIndex);
      assert.strictEqual((PT[ver][1][e.lit] || 0) * 1000, x.payout);
      const round = { holes: v.holes, bestLit: e.lit, payout: x.payout, stake: 1000 };
      const proof = { serverSeed: v.serverSeed, commit: v.commit, clientSeed: v.clientSeed, nonce: v.nonce, paytable: { card, pays: PT[ver][1] } };
      same(await Fair.verify(round, proof), { ok: true, problems: [] });
    }
  }
  // a wrong seed, a wrong hole and a wrong payout are all found
  const v0 = vectors[0], card = JSON.parse(PT[96][0]), e0 = Fair.evaluate(card, v0.holes);
  const base = { serverSeed: v0.serverSeed, commit: v0.commit, clientSeed: v0.clientSeed, nonce: v0.nonce, paytable: { card, pays: PT[96][1] } };
  const good = { holes: v0.holes, bestLit: e0.lit, payout: (PT[96][1][e0.lit] || 0) * 1000, stake: 1000 };
  assert.strictEqual((await Fair.verify(good, Object.assign({}, base, { commit: '0'.repeat(64) }))).ok, false);
  assert.strictEqual((await Fair.verify(Object.assign({}, good, { holes: [1, 2, 3, 4, 5] }), base)).ok, false);
  assert.strictEqual((await Fair.verify(Object.assign({}, good, { payout: good.payout + 1 }), base)).ok, false);
  assert.strictEqual((await Fair.verify(good, Object.assign({}, base, { nonce: v0.nonce + 1 }))).ok, false);
  console.log('fairness check in the browser: ' + vectors.length + ' known-answer plays agree with the server and the Python reference');
  console.log('bingo tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
