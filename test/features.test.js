'use strict';
// transaction metadata, history and draw proofs, per-player limits, blocking, reality-check data, multi-currency / brand, webhooks
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const rng = require('../server/rng.js');
const oddsLib = require('../server/odds.js');
const sign = require('../server/sign.js');
const walletLib = require('../server/wallet.js');
const { Webhook } = require('../server/webhook.js');
const { Engine } = require('../server/engine.js');

const tmp = (n) => path.join(os.tmpdir(), 'feat-' + n + '-' + process.pid);
const rm = (...f) => f.forEach((x) => { try { fs.unlinkSync(x); } catch (e) { /* none */ } });
const ALL = (stake) => rng.COMBOS.map((c) => ({ combo: c, stake }));

// mock wallet whose launch reply carries what a platform could send for the player
class PlatformWallet extends walletLib.MockWallet {
  constructor(profiles) { super({ startBalance: 1e9 }); this.profiles = profiles || {}; this.calls = []; }
  async validateToken(token) {
    const base = await super.validateToken(token), p = this.profiles[base.playerId] || {};
    return Object.assign(base, p);
  }
  async debit(id, amount, txId, meta) { this.calls.push({ type: 'debit', id, amount, txId, meta }); return super.debit(id, amount, txId, meta); }
  async credit(id, amount, txId, meta) { this.calls.push({ type: 'credit', id, amount, txId, meta }); return super.credit(id, amount, txId, meta); }
}

(async () => {
  let clock = 9000000000000;
  const led = tmp('ledger') + '.jsonl', blk = tmp('blocked') + '.json', ses = tmp('sessions') + '.json';
  rm(led, blk, ses);
  const wallet = new PlatformWallet({
    ann: { brandId: 'brandA' },
    ben: { currency: 'USD', decimals: 2, brandId: 'brandB', limits: { minBet: 50, maxBet: 1000, maxRoundStake: 3000, dailyLossLimit: 4000 }, realityCheckMinutes: 30 },
    yen: { currency: 'JPY', decimals: 0 },
    dan: { limits: { dailyLossLimit: 2000 } },
    eve: { blocked: true }
  });
  const mk = (extra) => new Engine({ wallet, now: () => clock, ledgerFile: led, config: Object.assign({ betMs: 20000, maxBet: 100000, maxRoundStake: 1e9, blockedFile: blk, sessionsFile: ses,
    currencyLimits: { JPY: { minBet: 100, maxBet: 50000, maxRoundStake: 1e6, decimals: 0 } }, bigWinMin: 1 }, extra || {}) });
  const finish = async (e) => {                        // close betting, run the race, settle, open the next round
    clock += 20001; await e.tick(); clock = e.cur.startAt + e.cfg.raceMs + 1; await e.tick();
    const r = e.cur; clock = r.startAt + e.cfg.raceMs + e.cfg.resultsMs + 1; await e.tick(); return r;
  };
  let eng = mk(); await eng.tick();

  /* ---- 6: every wallet call names game, round, bet(s), type, currency and brand ---- */
  const ann = await eng.auth('demo-ann');
  assert.strictEqual(ann.brandId, 'brandA'); assert.strictEqual(ann.currency, 'PHP');
  const raceA = eng.cur.raceNo;
  const placed = await eng.placeBets(ann.session, ALL(1000));
  assert.strictEqual(placed.bets.length, 15);
  const d = wallet.calls.find((c) => c.type === 'debit' && c.id === 'ann');
  assert.strictEqual(d.meta.kind, 'bet'); assert.strictEqual(d.meta.roundId, String(raceA)); assert.strictEqual(d.meta.currency, 'PHP'); assert.strictEqual(d.meta.brandId, 'brandA');
  assert.strictEqual(d.meta.betIds.length, 15); assert(d.meta.betIds.every((b) => b.startsWith(d.meta.betId + ':')));
  const roundA = await finish(eng);
  const win = wallet.calls.find((c) => c.type === 'credit' && c.id === 'ann' && c.meta.kind === 'win');
  assert(win && win.meta.roundId === String(raceA) && win.meta.betIds.length === 1 && win.meta.brandId === 'brandA' && win.meta.currency === 'PHP');
  assert.strictEqual(win.amount, 1000 * roundA.odds[roundA.combo]);

  // the HTTP wallet puts the same data at the top of the request body
  let seen = null;
  const srv = http.createServer((req, res) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => { seen = JSON.parse(b); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true,"balance":1}'); }); });
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  const hw = new walletLib.HttpWallet({ url: 'http://127.0.0.1:' + srv.address().port, key: 'k'.repeat(32), currency: 'PHP' });
  await hw.debit('p1', 500, 'bet:7:abc', { kind: 'bet', roundId: '7', betId: 'abc', betIds: ['abc:1-2'], currency: 'USD', brandId: 'B1', raceNo: 7 });
  assert.deepStrictEqual([seen.gameId, seen.transactionType, seen.roundId, seen.betId, seen.currency, seen.brandId], ['horse-race', 'bet', '7', 'abc', 'USD', 'B1']);
  assert.deepStrictEqual(seen.betIds, ['abc:1-2']); assert.strictEqual(seen.meta.raceNo, 7);
  await hw.rollback('p1', 500, 'bet:7:abc', { kind: 'rollback', roundId: '7', refTxId: 'bet:7:abc' });
  assert.strictEqual(seen.transactionType, 'rollback'); assert.strictEqual(seen.refTxId, 'bet:7:abc'); assert.strictEqual(seen.rollbackTxId, 'rollback:bet:7:abc');
  srv.close();

  /* ---- 7: history and draw proofs ---- */
  const h = eng.historyFor('ann');
  const hr = h.rounds.find((r) => r.raceNo === raceA);
  assert.strictEqual(hr.bets.length, 15); assert.strictEqual(hr.staked, 15000); assert.strictEqual(hr.combo, roundA.combo);
  assert.strictEqual(hr.bets.filter((b) => b.status === 'won').length, 1); assert.strictEqual(hr.paid, win.amount);
  assert.strictEqual(hr.commit, roundA.commit);
  const pf = eng.proof(raceA);                                       // anyone can recompute the draw from the revealed seed
  assert.strictEqual(crypto.createHash('sha256').update(pf.seed).digest('hex'), pf.commit);
  assert.deepStrictEqual(rng.oddsLayout(pf.seed, raceA, eng.values), pf.odds);
  assert.deepStrictEqual(rng.draw(pf.seed, raceA, oddsLib.buildForRtp(pf.odds, pf.rtp).weights).order, pf.order);
  assert.throws(() => eng.proof(eng.cur.raceNo), /NOT_FOUND/);       // the seed of the running round stays secret
  assert.strictEqual(eng.historyFor('nobody').rounds.length, 0);
  await eng.placeBets(ann.session, [{ combo: '1-2', stake: 500 }]);
  assert.strictEqual(eng.historyFor('ann').rounds[0].bets[0].status, 'open');   // the running round shows up as open
  // history survives a restart
  eng = mk(); await eng.recover(); await eng.tick();
  const h2 = eng.historyFor('ann').rounds.find((r) => r.raceNo === raceA);
  assert.strictEqual(h2.bets.length, 15); assert.strictEqual(h2.paid, win.amount);
  assert.strictEqual(eng.proof(raceA).seed, pf.seed);
  assert.strictEqual(eng.historyFor('ann').rounds.find((r) => r.bets.some((b) => b.status === 'refunded')).bets[0].stake, 500);  // the restart voided the open bet

  /* ---- 8: per-player limits, daily loss limit, blocking ---- */
  const ben = await eng.auth('demo-ben');
  assert.deepStrictEqual(ben.limits, { minBet: 50, maxBet: 1000, maxRoundStake: 3000, dailyLossLimit: 4000 });
  assert.strictEqual(ben.responsible.realityCheckMinutes, 30); assert.strictEqual(ben.currency, 'USD');
  await assert.rejects(() => eng.placeBets(ben.session, [{ combo: '1-2', stake: 40 }]), /BAD_BET/);
  await assert.rejects(() => eng.placeBets(ben.session, [{ combo: '1-2', stake: 1001 }]), /BAD_BET/);
  await eng.placeBets(ben.session, [{ combo: '1-2', stake: 1000 }, { combo: '1-3', stake: 1000 }, { combo: '1-4', stake: 1000 }]);
  await assert.rejects(() => eng.placeBets(ben.session, [{ combo: '1-5', stake: 100 }]), /MAX_ROUND_STAKE/);       // 3000 per race
  await finish(eng);
  const net1 = eng._dayNet('ben');                                   // after race 1: 3000 staked minus what it won
  assert(net1 <= 3000);
  const dan = await eng.auth('demo-dan');                            // daily loss limit 2000 (money staked minus money won today)
  await eng.placeBets(dan.session, [{ combo: '1-2', stake: 1000 }]); await eng.placeBets(dan.session, [{ combo: '1-3', stake: 1000 }]);
  await assert.rejects(() => eng.placeBets(dan.session, [{ combo: '1-4', stake: 100 }]), /DAILY_LOSS_LIMIT/);
  assert.strictEqual(eng._dayNet('dan'), 2000);
  await finish(eng);                                                 // what dan wins comes off the net loss again
  assert.strictEqual(eng._dayNet('dan') <= 2000, true);
  const yen = await eng.auth('demo-yen');                            // currency table: JPY has its own limits and no decimals
  assert.deepStrictEqual([yen.limits.minBet, yen.limits.maxBet, yen.decimals], [100, 50000, 0]);
  await assert.rejects(() => eng.auth('demo-eve'), /PLAYER_BLOCKED/);       // the platform says: self-excluded
  assert.strictEqual((await eng.me(ann.session)).playerId, 'ann');
  const bl = eng.blockPlayer('ann'); assert.strictEqual(bl.closed, 1);
  await assert.rejects(() => eng.me(ann.session), /SESSION_EXPIRED/);
  await assert.rejects(() => eng.auth('demo-ann'), /PLAYER_BLOCKED/);
  assert(fs.readFileSync(blk, 'utf8').includes('ann'));
  eng = mk(); assert(eng.blocked.has('ann'));                       // the block list survives a restart
  eng.unblockPlayer('ann'); assert.strictEqual((await eng.auth('demo-ann')).playerId, 'ann');

  /* ---- 9: reality-check data ---- */
  await eng.tick(); const ben2 = await eng.auth('demo-ben'), r0 = ben2.responsible;
  assert.strictEqual(r0.realityCheckMinutes, 30); assert.strictEqual(r0.staked, 0); assert(r0.startedAt > 0);
  const e9 = mk({ realityCheckMinutes: 15 }); await e9.tick();
  assert.strictEqual((await e9.auth('demo-ann')).responsible.realityCheckMinutes, 15);      // operator default when the platform sends none
  await e9.placeBets((await e9.auth('demo-ann')).session, [{ combo: '1-2', stake: 2000 }]);
  const mine = await e9.me((await e9.auth('demo-ann')).session);
  assert.strictEqual(mine.responsible.staked, 0);                                          // a fresh session starts at zero
  rm(ses);

  /* ---- 11: two currencies and brands side by side ---- */
  const e11 = mk(); await e11.tick();
  const a = await e11.auth('demo-ann'), y = await e11.auth('demo-yen');
  await e11.placeBets(a.session, ALL(1000)); await e11.placeBets(y.session, ALL(100));
  await finish(e11);
  const rep = e11.report();
  assert.strictEqual(rep.byCurrency.PHP.staked >= 15000, true); assert.strictEqual(rep.byCurrency.JPY.staked, 1500);
  assert(rep.byCurrency.JPY.paid > 0 && rep.byCurrency.PHP.paid > 0);
  assert.strictEqual(e11.historyFor('yen').rounds[0].bets[0].currency, 'JPY');
  assert(fs.readFileSync(led, 'utf8').split('\n').some((l) => l.includes('"currency":"JPY"') && l.includes('"e":"bet"')));
  eng = mk(); await eng.recover();                                // totals per currency are rebuilt from the ledger
  assert.strictEqual(eng.report().byCurrency.JPY.staked, 1500);

  /* ---- 10: webhooks ---- */
  const secret = 'w'.repeat(32), verifier = new sign.Verifier(secret), got = []; let failNext = 2, fails = 0;
  const hook = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => { b += c; });
    req.on('end', () => {
      const v = verifier.verify(req.headers, req.method, new URL(req.url, 'http://x').pathname, b);
      if (!v.ok) { res.writeHead(401); return res.end(); }
      if (failNext-- > 0) { fails++; res.writeHead(500); return res.end(); }           // the platform is down at first
      got.push(JSON.parse(b)); res.writeHead(200); res.end('ok');
    });
  });
  await new Promise((ok) => hook.listen(0, '127.0.0.1', ok));
  const wh = new Webhook({ url: 'http://127.0.0.1:' + hook.address().port + '/events', key: secret, keyId: 'w1' });
  rm(led); const e10 = new Engine({ wallet, now: () => clock, ledgerFile: led, webhook: wh, config: { betMs: 20000, bigWinMin: 1000, maxRoundStake: 1e9, gameId: 'horse-race' } });
  await e10.tick(); const w1 = await e10.auth('demo-ann'); await e10.placeBets(w1.session, ALL(1000));
  const r10 = await finish(e10);
  for (let i = 0; i < 6 && e10.pendingWh.size; i++) { clock += 70000; await e10.tick(); }   // retried with back-off until it works
  assert.strictEqual(e10.pendingWh.size, 0); assert.strictEqual(fails, 2);   // the first two deliveries failed and were retried until accepted
  const ev = got.find((x) => x.type === 'round.settled');
  assert(ev && ev.id === 'horse-race:round:' + r10.raceNo && ev.data.combo === r10.combo && ev.data.commit === r10.commit);
  assert.strictEqual(crypto.createHash('sha256').update(ev.data.seed).digest('hex'), ev.data.commit);
  const bw = got.find((x) => x.type === 'big.win');
  assert(bw && bw.data.playerId === 'ann' && bw.data.payout >= 1000 && bw.data.currency === 'PHP' && bw.data.betIds.length === 1);
  assert.strictEqual(new Set(got.map((x) => x.id)).size, got.length);       // each event delivered once here, ids are stable
  // an undelivered event is kept in the ledger and sent after a restart
  failNext = 1000; await e10.placeBets((await e10.auth('demo-ann')).session, ALL(1000)); await finish(e10);
  assert(e10.pendingWh.size >= 1);
  const before = got.length; failNext = 0;
  const e10b = new Engine({ wallet, now: () => clock, ledgerFile: led, webhook: wh, config: { betMs: 20000, bigWinMin: 1000, maxRoundStake: 1e9 } });
  await e10b.recover(); assert(e10b.pendingWh.size >= 1);
  clock += 70000; await e10b.tick(); assert.strictEqual(e10b.pendingWh.size, 0); assert(got.length > before);
  assert.strictEqual(wh.wants('round.settled') && wh.wants('big.win') && !wh.wants('other'), true);
  hook.close();

  [led, blk, ses].forEach((f) => rm(f));
  console.log('feature tests passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
