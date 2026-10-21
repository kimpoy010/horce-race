'use strict';
// tamper-evident ledger, metrics, alerts, active / standby lease, graceful shutdown
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const rng = require('../server/rng.js');
const { Ledger, verifyText, verifyFile, sha } = require('../server/ledger.js');
const { Metrics, render } = require('../server/metrics.js');
const { AlertManager, rules, DEFAULTS } = require('../server/alerts.js');
const { Lease } = require('../server/lease.js');
const { Engine } = require('../server/engine.js');
const { MockWallet } = require('../server/wallet.js');

const tmp = (n) => path.join(os.tmpdir(), 'ops-' + n + '-' + process.pid);
const rm = (...f) => f.forEach((x) => { try { fs.unlinkSync(x); } catch (e) { /* none */ } });
const ALL = (stake) => rng.COMBOS.map((c) => ({ combo: c, stake }));

(async () => {
  /* ---- ledger: hash chain ---- */
  const lf = tmp('ledger') + '.jsonl'; rm(lf);
  const L = new Ledger(lf);
  for (let i = 0; i < 6; i++) L.append({ e: 'bet', i, t: 1000 + i, odds: { '1-2': 3, '3-4': 10 } });
  let text = fs.readFileSync(lf, 'utf8');
  let r = verifyText(text); assert(r.ok && r.chained === 6 && r.lines === 6); assert.strictEqual(r.head, L.head);
  assert.strictEqual(new Ledger(lf).head, L.head);                       // a restart continues the same chain
  const rows = text.split('\n').filter(Boolean);
  const broken = (arr) => verifyText(arr.join('\n') + '\n');
  assert.strictEqual(broken(rows.map((x, i) => i === 3 ? x.replace('"i":3', '"i":9') : x)).broken.line, 4);          // a changed line
  assert.strictEqual(broken(rows.filter((x, i) => i !== 2)).broken.line, 3);                                       // a removed line
  assert.strictEqual(broken([rows[0], rows[2], rows[1], ...rows.slice(3)]).broken.line, 2);                         // swapped lines
  assert.strictEqual(broken([...rows.slice(0, 3), rows[2], ...rows.slice(3)]).broken.line, 4);                      // a duplicated line
  assert.strictEqual(broken([...rows.slice(0, 5), JSON.stringify({ e: 'bet', i: 99 })]).broken.reason, 'line without a hash inside the chain');   // an unchained forged line
  assert.strictEqual(verifyText(rows.join('\n') + '\n{"e":"bet","i":').broken.reason, 'truncated last line');        // crash in the middle of a write
  assert(verifyText(rows.slice(0, 4).join('\n') + '\n').ok);                                                       // cutting the end off is only visible through the head hash...
  assert.notStrictEqual(verifyText(rows.slice(0, 4).join('\n') + '\n').head, L.head);                              // ...which the platform also holds (round.settled webhook)
  // lines from before the chain existed are accepted as a prefix
  const legacy = '{"e":"open","raceNo":1}\n{"e":"bet","raceNo":1}\n';
  fs.writeFileSync(lf, legacy);
  const L2 = new Ledger(lf); assert(L2.ok); L2.append({ e: 'bet', i: 1 }); L2.append({ e: 'bet', i: 2 });
  r = verifyFile(lf); assert(r.ok && r.legacy === 2 && r.chained === 2, JSON.stringify(r));
  fs.writeFileSync(lf, fs.readFileSync(lf, 'utf8').replace('"raceNo":1}\n{"e":"bet","raceNo":1}', '"raceNo":2}\n{"e":"bet","raceNo":1}'));
  assert.strictEqual(verifyFile(lf).broken.line, 3);                                                               // editing the legacy part breaks the first chained line
  assert.strictEqual(verifyFile(tmp('missing')).ok, true);

  /* ---- an engine writes a chained ledger, notices tampering, and in strict mode refuses to start ---- */
  rm(lf);
  let clock = 5000000000000;
  const wallet = new MockWallet({ startBalance: 1e9 });
  const mk = (extra) => new Engine({ wallet, now: () => clock, ledgerFile: lf, config: Object.assign({ betMs: 20000, maxRoundStake: 1e9 }, extra || {}) });
  const finish = async (e) => { clock += 20001; await e.tick(); clock = e.cur.startAt + e.cfg.raceMs + 1; await e.tick(); clock = e.cur.startAt + e.cfg.raceMs + e.cfg.resultsMs + 1; await e.tick(); };
  let eng = mk(); await eng.tick();
  const a = await eng.auth('demo-ann'); await eng.placeBets(a.session, ALL(1000)); await finish(eng);
  assert(verifyFile(lf).ok && verifyFile(lf).chained === eng.ledger.lines);
  assert.strictEqual(eng.health().ok, true);
  const good = fs.readFileSync(lf, 'utf8');
  fs.writeFileSync(lf, good.replace('"stake":1000', '"stake":10'));
  const bad = mk(); assert.strictEqual(bad.ledger.ok, false); assert.strictEqual(bad.health().ok, false);
  assert(bad.opsSnapshot().ledger.broken.line > 0);
  assert.throws(() => mk({ ledgerStrict: true }), /LEDGER_TAMPERED/);
  fs.writeFileSync(lf, good); eng = mk(); await eng.recover(); assert.strictEqual(eng.ledger.ok, true);

  /* ---- webhook payload carries the ledger hash (an external anchor) ---- */
  const sent = []; const hook = { wants: () => true, send: async (ev) => { sent.push(ev); } };
  const e3 = new Engine({ wallet, now: () => clock, webhook: hook, ledgerFile: tmp('l3'), config: { betMs: 20000, maxRoundStake: 1e9 } }); rm(tmp('l3'));
  await e3.tick(); const b3 = await e3.auth('demo-bob'); await e3.placeBets(b3.session, ALL(1000)); await finish(e3);
  const rs = sent.find((x) => x.type === 'round.settled'); assert(rs && /^[0-9a-f]{64}$/.test(rs.data.ledgerHash) && rs.data.ledgerLines > 0);
  rm(tmp('l3'));

  /* ---- metrics ---- */
  const M = new Metrics(() => clock);
  M.walletCall('debit', 40, true); M.walletCall('debit', 120, true); M.walletCall('debit', 9000, false); M.walletCall('credit', 30, true);
  const w = M.walletWindow(300000); assert.strictEqual(w.calls, 4); assert.strictEqual(w.failures, 1); assert.strictEqual(w.failRate, 0.25); assert.strictEqual(w.p95, 9000);
  clock += 400000; assert.strictEqual(M.walletWindow(300000).calls, 0);
  const text2 = render(eng, { role: 'active', alerts: [{ name: 'x', severity: 'warning' }] });
  ['horse_up 1', 'horse_role{role="active"} 1', 'horse_ledger_ok 1', 'horse_rounds_total', 'horse_pending_credits 0', 'horse_alert_firing{name="x",severity="warning"} 1', 'horse_rtp_zscore'].forEach((s) => assert(text2.includes(s), 'metrics missing ' + s));
  assert(!/NaN|undefined/.test(text2));

  /* ---- the engine times its wallet calls and tells a refusal from a failure ---- */
  class Flaky extends MockWallet {
    constructor() { super({ startBalance: 1e9 }); this.mode = 'ok'; }
    async debit(id, amount, txId, meta) {
      if (this.mode === 'down') { const e = new Error('HTTP_500'); e.status = 500; throw e; }
      if (this.mode === 'refuse') { const e = new Error('TX_REJECTED'); e.status = 409; e.definitive = true; throw e; }
      return super.debit(id, amount, txId, meta);
    }
    async credit(id, amount, txId, meta) { if (this.mode === 'down') { const e = new Error('HTTP_500'); e.status = 500; throw e; } return super.credit(id, amount, txId, meta); }
    async rollback(id, amount, txId, meta) { if (this.mode === 'down') { const e = new Error('HTTP_500'); e.status = 500; throw e; } return super.rollback(id, amount, txId, meta); }
  }
  const fw = new Flaky(); let c2 = 7000000000000;
  const e4 = new Engine({ wallet: fw, now: () => c2, config: { betMs: 20000, maxRoundStake: 1e9 } }); await e4.tick();
  const s4 = (await e4.auth('demo-cat')).session;
  await e4.placeBets(s4, [{ combo: '1-2', stake: 1000 }]);
  fw.mode = 'refuse'; await assert.rejects(() => e4.placeBets(s4, [{ combo: '1-3', stake: 1000 }]), /WALLET_REJECTED/);
  let win = e4.metrics.walletWindow(60000); assert.strictEqual(win.failures, 0);                    // an answer, even a refusal, is not a wallet failure
  fw.mode = 'down'; await assert.rejects(() => e4.placeBets(s4, [{ combo: '1-4', stake: 1000 }]), /WALLET_UNAVAILABLE/);
  win = e4.metrics.walletWindow(60000); assert(win.failures >= 2 && win.calls >= 4, JSON.stringify(win));

  /* ---- alerts: fire, repeat, resolve; rules ---- */
  const out = [], logs = []; let t5 = 1e12;
  const AM = new AlertManager({ now: () => t5, notify: (ev) => out.push(ev), log: (x) => logs.push(x), config: { repeatMinutes: 30 } });
  const snap = (over) => Object.assign({ rounds: 10, rtpZ: 0, ledger: { ok: true }, pending: { credits: { count: 0, oldestSeconds: 0 }, rollbacks: { count: 0, oldestSeconds: 0 }, webhooks: { count: 0, oldestSeconds: 0 } } }, over || {});
  const ctx = (over, wal, extra) => Object.assign({ snapshot: snap(over), wallet: Object.assign({ calls: 0, failRate: 0, p95: 0 }, wal), tickAge: 0.2, diskFreeMb: 5000 }, extra);
  assert.deepStrictEqual(AM.evaluate(ctx()), []);
  AM.evaluate(ctx({ pending: { credits: { count: 2, oldestSeconds: 400 }, rollbacks: { count: 0, oldestSeconds: 0 }, webhooks: { count: 0, oldestSeconds: 0 } } }));
  assert.strictEqual(out.length, 1); assert.strictEqual(out[0].status, 'firing'); assert.strictEqual(out[0].name, 'credits_stuck'); assert(/^\[CRITICAL\]/.test(out[0].text));
  t5 += 60000; AM.evaluate(ctx({ pending: { credits: { count: 2, oldestSeconds: 460 }, rollbacks: { count: 0, oldestSeconds: 0 }, webhooks: { count: 0, oldestSeconds: 0 } } }));
  assert.strictEqual(out.length, 1);                                                                          // no repeat spam inside 30 minutes
  t5 += 31 * 60000; AM.evaluate(ctx({ pending: { credits: { count: 2, oldestSeconds: 2300 }, rollbacks: { count: 0, oldestSeconds: 0 }, webhooks: { count: 0, oldestSeconds: 0 } } }));
  assert.strictEqual(out.length, 2); assert.strictEqual(out[1].reminder, true);
  AM.evaluate(ctx()); assert.strictEqual(out[2].status, 'resolved'); assert.strictEqual(AM.list().length, 0); assert(logs.some((l) => /ALERT \[RESOLVED\]/.test(l)));
  const names = (c) => rules(DEFAULTS, c).map((x) => x.name);
  assert(names(ctx({ ledger: { ok: false, broken: { line: 3, reason: 'x' } } })).includes('ledger_broken'));
  assert(names(ctx({}, {}, { tickAge: 9 })).includes('round_loop_stalled'));
  assert(names(ctx({}, { calls: 10, failRate: 0.5, p95: 100 })).includes('wallet_failing'));
  assert(!names(ctx({}, { calls: 2, failRate: 1, p95: 100 })).includes('wallet_failing'));                   // too few calls to judge
  assert(names(ctx({}, { calls: 10, failRate: 0, p95: 5000 })).includes('wallet_slow'));
  assert(names(ctx({ rounds: 500, rtpZ: 4.6 })).includes('rtp_drift') && names(ctx({ rounds: 500, rtpZ: -4.6 })).includes('rtp_drift'));
  assert(!names(ctx({ rounds: 100, rtpZ: 9 })).includes('rtp_drift'));                                       // too early
  assert(names(ctx({}, {}, { diskFreeMb: 100 })).includes('disk_low'));
  assert(names(ctx({ pending: { credits: { count: 0, oldestSeconds: 0 }, rollbacks: { count: 1, oldestSeconds: 200 }, webhooks: { count: 0, oldestSeconds: 0 } } })).includes('rollbacks_stuck'));

  // the engine's own stuck credit shows up in the snapshot and fires the alert once it is old enough
  fw.mode = 'down'; c2 += 21000; await e4.tick();                                                    // betting closes, the race runs; the win credit cannot be delivered
  c2 = e4.cur.startAt + e4.cfg.raceMs + 1; await e4.tick();
  const AM2 = new AlertManager({ now: () => c2, notify: () => {}, log: () => {} });
  const ctx2 = () => ({ snapshot: e4.opsSnapshot(), wallet: e4.metrics.walletWindow(300000), tickAge: e4.metrics.tickAge(), diskFreeMb: 5000 });
  if (e4.pending.size) {                                                                               // (only when the one bet on 1-2 happened to win)
    assert(!AM2.evaluate(ctx2()).some((x) => x.name === 'credits_stuck'));
    c2 += 6 * 60000; assert(AM2.evaluate(ctx2()).some((x) => x.name === 'credits_stuck'));
  }

  /* ---- payouts vs what the odds predict (z-score) stays sane over many races ---- */
  const w6 = new MockWallet({ startBalance: 1e13 }); let c6 = 8000000000000;
  const e6 = new Engine({ wallet: w6, now: () => c6, config: { betMs: 1000, maxRoundStake: 1e12, maxBet: 1e9, sessionTtlMs: 1e15 } }); await e6.tick();
  const s6 = (await e6.auth('demo-zed')).session;
  for (let i = 0; i < 3000; i++) {
    await e6.placeBets(s6, ALL(100)); c6 += 1001; await e6.tick(); c6 = e6.cur.startAt + e6.cfg.raceMs + 1; await e6.tick(); c6 = e6.cur.startAt + e6.cfg.raceMs + e6.cfg.resultsMs + 1; await e6.tick();
    e6.sessions.get(e6._skey(s6)).calls = [];
  }
  assert(Math.abs(e6.rtpZ()) < 4.5, 'z-score ' + e6.rtpZ());                                         // a fair game stays within a few standard deviations
  const tampered = e6.rtpTrack.paid; e6.rtpTrack.paid = tampered * 1.5; assert(e6.rtpZ() > 4, 'a payout bug (50% too much) must stand out: ' + e6.rtpZ()); e6.rtpTrack.paid = tampered;

  /* ---- lease: one active instance, standby takes over, fencing ---- */
  const lease1 = tmp('lease'); rm(lease1); let lt = 1e12; const now = () => lt;
  const A = new Lease(lease1, { ttlMs: 10000, now }), B = new Lease(lease1, { ttlMs: 10000, now });
  assert.strictEqual(await A.tryAcquire(), true); assert.strictEqual(A.valid(), true);
  assert.strictEqual(await B.tryAcquire(), false); assert.strictEqual(B.valid(), false);
  lt += 4000; assert.strictEqual(A.renew(), true); assert.strictEqual(await B.tryAcquire(), false);
  lt += 9000; assert.strictEqual(await B.tryAcquire(), false);                                         // A renewed 9 s ago: still alive
  lt += 2000; assert.strictEqual(A.valid(), false);                                                    // A has not renewed for 11 s (frozen): it must not act any more
  assert.strictEqual(await B.tryAcquire(), true);                                                      // the lease ran out: B takes over
  assert.strictEqual(A.renew(), false);                                                                // A wakes up and finds out it lost the lease
  assert.strictEqual(B.info().mine, true); assert.strictEqual(A.info().mine, false);
  B.release(); assert.strictEqual(B.info(), null); assert.strictEqual(await A.tryAcquire(), true); A.release();
  // two standbys racing for a stale lease: exactly one wins
  const C = new Lease(lease1, { ttlMs: 10000, now }), D = new Lease(lease1, { ttlMs: 10000, now });
  const raceResult = await Promise.all([C.tryAcquire(), D.tryAcquire()]); assert.strictEqual(raceResult.filter(Boolean).length, 1);
  C.release(); D.release(); rm(lease1);

  /* ---- a standby that takes over resumes in-flight races from the ledger ---- */
  rm(lf); clock = 6000000000000;
  const w7 = new MockWallet({ startBalance: 1e9 });
  const mk7 = () => new Engine({ wallet: w7, now: () => clock, ledgerFile: lf, config: { betMs: 20000, maxRoundStake: 1e9 } });
  let act = mk7(); await act.tick(); const s7 = (await act.auth('demo-dee')).session;
  const before = await w7.balance('dee'); await act.placeBets(s7, [{ combo: '2-3', stake: 1000 }]);
  clock += 20001; await act.tick();                                                                    // drawn: the race is running, then the active instance dies
  const std = mk7(); await std.recover(); await std.tick();                                            // the standby takes over
  clock = std.cur.startAt + std.cfg.raceMs + 1; await std.tick();
  const after = await w7.balance('dee'); assert.strictEqual(std.stats.rounds, 1);
  const won = std.history.get('dee')[0]; assert.strictEqual(after, before - 1000 + (won.status === 'won' ? won.payout : 0));   // settled by the new active instance, paid once
  assert(verifyFile(lf).ok);

  /* ---- graceful shutdown: no new bets, queued credits get a last chance ---- */
  const fw2 = new Flaky(); let c8 = 9000000000000;
  const e8 = new Engine({ wallet: fw2, now: () => c8, ledgerFile: tmp('l8'), config: { betMs: 20000, maxRoundStake: 1e9 } }); rm(tmp('l8')); await e8.tick();
  const s8 = (await e8.auth('demo-eli')).session; await e8.placeBets(s8, ALL(1000));
  fw2.mode = 'down'; c8 += 20001; await e8.tick(); c8 = e8.cur.startAt + e8.cfg.raceMs + 1; await e8.tick();
  assert.strictEqual(e8.pending.size, 1);                                                              // the win could not be delivered
  fw2.mode = 'ok'; const bal0 = await fw2.balance('eli');
  const down = e8.shutdown(3000);
  await assert.rejects(() => e8.placeBets(s8, [{ combo: '1-2', stake: 1000 }]), /SHUTTING_DOWN/);
  await assert.rejects(() => e8.auth('demo-eli'), /SHUTTING_DOWN/);
  await down; assert.strictEqual(e8.pending.size, 0); assert((await fw2.balance('eli')) > bal0);       // delivered during shutdown
  assert(fs.readFileSync(tmp('l8'), 'utf8').includes('"e":"shutdown"')); assert.strictEqual(e8.health().ok, false);
  rm(tmp('l8'), lf);

  console.log('ops tests passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
