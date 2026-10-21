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
    assert(d.order[0] < d.order[1], 'the winning pair finishes lower number first: ' + d.order);          // the order of the finish matches the combination as written
    assert.strictEqual(d.combo, d.order[0] + '-' + d.order[1]);
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
  assert.strictEqual(eng.rtp, 0.9);
  const D = oddsLib.DEFAULT_ODDS;
  assert.strictEqual(eng.payoutFor(100, '1-3', D), 2000);
  assert.strictEqual(eng.payoutFor(101, '5-6', D), 25250);
  assert.strictEqual(eng.payoutFor(100, '1-6', D), 300);
  // every race gets its own layout of the same 15 odds, verifiable from the seed
  const lay = rng.oddsLayout(seed, 1, eng.values), lay2 = rng.oddsLayout(seed, 2, eng.values);
  assert.deepStrictEqual(Object.values(lay).sort((a, b) => a - b), eng.values);
  assert.notDeepStrictEqual(lay, lay2);
  assert.deepStrictEqual(lay, rng.oddsLayout(seed, 1, eng.values));

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
  const O = eng.cur.odds;
  const aliceWin = combo === '1-2' ? 5000 * O['1-2'] : combo === '3-4' ? 5000 * O['3-4'] : 0, bobWin = combo === '5-6' ? 2 * 5000 * O['5-6'] : 0;
  assert.strictEqual(await wallet.balance('alice'), 90000 + aliceWin);
  assert.strictEqual(await wallet.balance('bob'), 90000 + bobWin);
  const rep = eng.report(); assert.strictEqual(rep.rounds, 1); assert.strictEqual(rep.staked, 10000 + 10000);
  assert.strictEqual(eng.reveals[0].commit, rng.commitOf(eng.reveals[0].seed));
  const rv = eng.reveals[0];
  assert.deepStrictEqual(rng.oddsLayout(rv.seed, rn, eng.values), rv.odds);
  assert.deepStrictEqual(rng.draw(rv.seed, rn, oddsLib.buildForRtp(rv.odds, rv.rtp).weights).order, rv.order);   // players can verify the draw

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
    e2.sessions.get(e2._skey(s2)).calls = [];
  }
  const rtp = e2.report().actualRtp;
  console.log('simulated RTP over ' + R + ' rounds betting every pair: ' + (rtp * 100).toFixed(2) + '% (theory ' + (e2.previewRtp(e2.rtp).evenSpreadRtp * 100).toFixed(2) + '%)');
  assert(Math.abs(rtp - e2.previewRtp(e2.rtp).evenSpreadRtp) < 0.07, 'RTP drifted: ' + rtp);   // standard deviation about 1.5%

  // ---- editable RTP (88-99%): odds unchanged, no fee ----
  for (const r of [0.88, 0.9, 0.95, 0.99]) {
    const tb = oddsLib.buildForRtp(null, r), cheap = new Set(tb.cheap);
    assert(Math.abs(Object.values(tb.prob).reduce((a, b2) => a + b2, 0) - 1) < 1e-9);
    assert(tb.bestRtp <= r + 1e-6, 'no bet may return more than the setting');
    assert.strictEqual(tb.cheap.length, 3);
    oddsLib.COMBOS.forEach((c) => { if (!cheap.has(c)) assert(Math.abs(tb.rtpBy[c] - r) < 1e-6); });   // 12 pairs exactly at the setting
    tb.cheap.forEach((c) => assert(tb.rtpBy[c] <= r + 1e-9 && tb.rtpBy[c] > 0.8));
  }
  assert.throws(() => oddsLib.buildForRtp(null, 0.87)); assert.throws(() => oddsLib.buildForRtp(null, 0.995));
  assert.deepStrictEqual(oddsLib.build().odds, oddsLib.buildForRtp(null, 0.9).odds);                  // the odds never change

  const w3 = new MockWallet({ startBalance: 1000000 });
  let c3 = 5000000;
  const led3 = path.join(os.tmpdir(), 'ledger3-' + process.pid + '.jsonl'); try { fs.unlinkSync(led3); } catch (e) { /* new */ }
  const set3 = path.join(os.tmpdir(), 'settings3-' + process.pid + '.json'); try { fs.unlinkSync(set3); } catch (e) { /* new */ }
  const mk3 = () => new Engine({ wallet: w3, now: () => c3, ledgerFile: led3, config: { rtp: 0.88, settingsFile: set3, betMs: 5000, maxBet: 100000, maxRoundStake: 1e9 } });
  let e3 = mk3(); await e3.tick();
  const s3 = (await e3.auth('demo-rtp')).session;
  await e3.placeBets(s3, [{ combo: '1-2', stake: 1000 }]);
  assert.strictEqual(await w3.balance('rtp'), 999000);                // exactly the stake is debited, no fee
  const r3 = e3.cur.raceNo;
  // the setting only applies to the next race and must be 88-99%
  assert.throws(() => e3.setRtp(0.85), /RTP_OUT_OF_RANGE/); assert.throws(() => e3.setRtp(1)); assert.throws(() => e3.setRtp(0.5));
  const set = e3.setRtp(0.95); assert.strictEqual(set.appliesFromRace, r3 + 1); assert.strictEqual(e3.cur.rtp, 0.88);
  // crash before the draw: the stake is refunded
  e3 = mk3(); await e3.recover(); await e3.tick();
  assert.strictEqual(await w3.balance('rtp'), 1000000);
  assert.strictEqual(e3.rtp, 0.95);                                  // the saved setting survives a restart
  assert.strictEqual(e3.cur.rtp, 0.95);
  // finish a round: payout is stake x odds
  const s4 = (await e3.auth('demo-rtp')).session;
  await e3.placeBets(s4, rng.COMBOS.map((c) => ({ combo: c, stake: 1000 })));
  c3 += 5001; await e3.tick(); c3 = e3.cur.startAt + e3.cfg.raceMs + 1; await e3.tick();
  assert.strictEqual(await w3.balance('rtp'), 1000000 - 15000 + 1000 * e3.cur.odds[e3.cur.combo]);
  try { fs.unlinkSync(led3); fs.unlinkSync(set3); } catch (e) { /* ignore */ }
  console.log('rtp setting ok');
  try { fs.unlinkSync(ledger); } catch (e) { /* ignore */ }
  console.log('live tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
