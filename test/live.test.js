'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const rng = require('../server/rng.js');
const oddsLib = require('../server/odds.js');
const { Engine } = require('../server/engine.js');
const { MockWallet } = require('../server/wallet.js');

(async () => {
  // ---- draw: deterministic, valid, uniform over the 15 pairs ----
  const seed = rng.newSeed();
  assert.strictEqual(rng.commitOf(seed).length, 64);
  assert.deepStrictEqual(rng.draw(seed, 7), rng.draw(seed, 7));
  const counts = {}; rng.COMBOS.forEach((c) => { counts[c] = 0; });
  const N = 150000;
  for (let i = 0; i < N; i++) {
    const d = rng.draw(rng.newSeed(), i);
    counts[d.combo]++;
    assert.deepStrictEqual(d.order.slice().sort(), [1, 2, 3, 4, 5, 6]);
    assert.strictEqual(rng.COMBOS.includes(d.combo), true);
    assert.deepStrictEqual([d.order[0], d.order[1]].sort(), d.combo.split('-').map(Number));
  }
  const exp = N / 15; let chi = 0; rng.COMBOS.forEach((c) => { chi += Math.pow(counts[c] - exp, 2) / exp; });
  assert(chi < 36.1, 'chi-square too large: ' + chi);            // 14 degrees of freedom, p = 0.001
  // weighted draw (probability proportional to 1/odds) and the RTP it gives
  const tab = oddsLib.build();
  assert(Math.abs(tab.rtp - 0.868397) < 1e-5 && tab.rtpMax - tab.rtpMin < 1e-6);          // the same RTP for every pair
  const wc = {}; rng.COMBOS.forEach((c) => { wc[c] = 0; });
  for (let i = 0; i < N; i++) wc[rng.draw(rng.newSeed(), i, tab.weights).combo]++;
  let chi2 = 0; rng.COMBOS.forEach((c) => { const e = N * tab.prob[c]; chi2 += Math.pow(wc[c] - e, 2) / e; });
  assert(chi2 < 36.1, 'weighted chi-square too large: ' + chi2);
  console.log('rng ok (chi-square ' + chi.toFixed(1) + ' uniform, ' + chi2.toFixed(1) + ' weighted)');

  // ---- engine with a fake clock and the mock wallet ----
  let clock = 1000000;
  const ledger = path.join(os.tmpdir(), 'ledger-' + process.pid + '.jsonl'); try { fs.unlinkSync(ledger); } catch (e) { /* new */ }
  const wallet = new MockWallet({ startBalance: 100000 });
  const mk = () => new Engine({ wallet, now: () => clock, ledgerFile: ledger, config: { betMs: 20000, minBet: 100, maxBet: 10000, maxRoundStake: 15000 } });
  let eng = mk();
  assert(Math.abs(eng.theoreticalRtp - 0.868397) < 1e-5);
  assert.strictEqual(eng.payoutFor(100, '1-3'), 2000);
  assert.strictEqual(eng.payoutFor(101, '5-6'), 25250);
  assert.strictEqual(eng.payoutFor(100, '1-6'), 300);

  await eng.tick();
  const a = await eng.auth('demo-alice'), b = await eng.auth('demo-bob');
  await assert.rejects(() => eng.auth('nope'), /INVALID_TOKEN/);
  const rn = eng.cur.raceNo;

  // validation
  await assert.rejects(() => eng.placeBets(a.session, [{ combo: '2-1', stake: 100 }]), /BAD_BET/);
  await assert.rejects(() => eng.placeBets(a.session, [{ combo: '1-2', stake: 50 }]), /BAD_BET/);
  await assert.rejects(() => eng.placeBets(a.session, [{ combo: '1-2', stake: 10001 }]), /BAD_BET/);
  await assert.rejects(() => eng.placeBets('bad', [{ combo: '1-2', stake: 100 }]), /SESSION_EXPIRED/);
  await eng.placeBets(a.session, [{ combo: '1-2', stake: 5000 }, { combo: '3-4', stake: 5000 }]);
  await assert.rejects(() => eng.placeBets(a.session, [{ combo: '5-6', stake: 6000 }]), /MAX_ROUND_STAKE/);
  await assert.rejects(() => eng.placeBets(b.session, [{ combo: '5-6', stake: 200000 }]), /BAD_BET/);
  assert.strictEqual(await wallet.balance('alice'), 90000);

  // many parallel bets cannot exceed the round limit
  const par = await Promise.allSettled(Array.from({ length: 10 }, () => eng.placeBets(b.session, [{ combo: '5-6', stake: 5000 }])));
  assert.strictEqual(par.filter((p) => p.status === 'fulfilled').length, 2);   // max 10000 on one combination
  assert.strictEqual(await wallet.balance('bob'), 90000);

  // insufficient funds
  const broke = await eng.auth('demo-broke'); wallet.accounts.set('broke', 50);
  await assert.rejects(() => eng.placeBets(broke.session, [{ combo: '1-3', stake: 100 }]), /INSUFFICIENT_FUNDS/);

  // betting closes -> draw -> race -> settlement
  clock += 20001; await eng.tick();
  assert.strictEqual(eng.cur.status, 'racing');
  await assert.rejects(() => eng.placeBets(a.session, [{ combo: '1-5', stake: 100 }]), /BETTING_CLOSED/);
  const combo = eng.cur.combo;
  let st = eng.publicState();
  assert.strictEqual(st.race.order, null);                          // order hidden until just before the gun
  clock += 4500; st = eng.publicState(); assert.notStrictEqual(st.race.order, null);
  clock = eng.cur.startAt + eng.cfg.raceMs + 1; await eng.tick();
  assert.strictEqual(eng.cur.status, 'settled');
  const aliceWin = combo === '1-2' ? 5000 * 60 : combo === '3-4' ? 5000 * 10 : 0, bobWin = combo === '5-6' ? 2 * 5000 * 250 : 0;
  assert.strictEqual(await wallet.balance('alice'), 90000 + aliceWin);
  assert.strictEqual(await wallet.balance('bob'), 90000 + bobWin);
  const rep = eng.report(); assert.strictEqual(rep.rounds, 1); assert.strictEqual(rep.staked, 10000 + 10000);
  assert.strictEqual(eng.reveals[0].commit, rng.commitOf(eng.reveals[0].seed));
  assert.deepStrictEqual(rng.draw(eng.reveals[0].seed, rn, oddsLib.build().weights).order, eng.reveals[0].order);   // players can verify the draw

  // ---- restart in the middle of a round: bets are refunded, a drawn race is settled ----
  clock = eng.cur.startAt + eng.cfg.raceMs + eng.cfg.resultsMs + 1; await eng.tick();        // next round opens
  const before = await wallet.balance('alice');
  await eng.placeBets((await eng.auth('demo-alice')).session, [{ combo: '2-3', stake: 1000 }]);
  assert.strictEqual(await wallet.balance('alice'), before - 1000);
  eng = mk(); await eng.recover(); await eng.tick();
  assert.strictEqual(await wallet.balance('alice'), before);       // refunded
  assert(eng.cur.raceNo > rn + 1);
  console.log('engine ok');

  // ---- RTP over a long run: a player who bets every pair each race ----
  clock = 0; const w2 = new MockWallet({ startBalance: 1e13 });
  const e2 = new Engine({ wallet: w2, now: () => clock, config: { betMs: 1000, minBet: 100, maxBet: 100000, maxRoundStake: 1e12, sessionTtlMs: 1e15 } });
  await e2.tick(); const s2 = (await e2.auth('demo-sim')).session;
  const R = 20000, all = rng.COMBOS.map((c) => ({ combo: c, stake: 100 }));
  for (let i = 0; i < R; i++) {
    await e2.placeBets(s2, all);
    clock += 1001; await e2.tick();
    clock = e2.cur.startAt + e2.cfg.raceMs + 1; await e2.tick();
    clock = e2.cur.startAt + e2.cfg.raceMs + e2.cfg.resultsMs + 1; await e2.tick();
    e2.sessions.get(s2).calls = [];
  }
  const rtp = e2.report().actualRtp;
  console.log('simulated RTP over ' + R + ' rounds betting every pair: ' + (rtp * 100).toFixed(2) + '% (theory ' + (e2.theoreticalRtp * 100).toFixed(2) + '%)');
  assert(Math.abs(rtp - e2.theoreticalRtp) < 0.07, 'RTP drifted: ' + rtp);   // standard deviation about 1.5%
  try { fs.unlinkSync(ledger); } catch (e) { /* ignore */ }
  console.log('live tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
