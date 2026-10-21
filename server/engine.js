'use strict';
/*
 * Live game engine: continuous rounds, bets, draw, settlement and the audit ledger.
 *
 *   BETTING (BET_MS) -> draw at bet close -> COUNTDOWN -> RACE -> RESULTS (settlement at the end of the race)
 *
 * Fixed odds per pair (server/odds.js): a winning bet pays stake x odds (stake included). The 15 odds values are
 * shuffled over the pairs every race (from the round seed); each pair is drawn with probability proportional to
 * 1/odds of this race (see odds.buildForRtp for the editable RTP setting, 88-99%). Money is integer minor units; payouts round down.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const rng = require('./rng');
const Core = require('../public/js/core.js');
const oddsLib = require('./odds.js');

function httpError(status, code) { const e = new Error(code); e.status = status; e.code = code; return e; }

class Engine {
  constructor(opts) {
    this.wallet = opts.wallet;
    this.now = opts.now || Date.now;
    this.cfg = Object.assign({
      rtp: 0.9, settingsFile: null, betMs: 25000, countdownMs: Core.COUNTDOWN_MS, raceMs: Core.RACE_MS, resultsMs: Core.RESULTS_MS,
      minBet: 100, maxBet: 100000, maxRoundStake: 500000, sessionTtlMs: 12 * 3600 * 1000, sessionsFile: null, odds: null, currency: 'PHP'
    }, opts.config || {});
    this.table = oddsLib.build(this.cfg.odds);                          // base table: the odds values
    this.values = rng.COMBOS.map((c) => this.table.odds[c]).sort((a, b) => a - b);
    this.rtp = this.cfg.rtp;                                            // applies to rounds opened from now on
    try { if (this.cfg.settingsFile) { const st = JSON.parse(fs.readFileSync(this.cfg.settingsFile, 'utf8')); if (st.rtp >= oddsLib.MIN_RTP && st.rtp <= oddsLib.MAX_RTP) this.rtp = st.rtp; } } catch (e) { /* no saved setting */ }
    oddsLib.buildForRtp(this.table.odds, this.rtp);                     // throws if the configured RTP is out of range
    this.shuffle = this.cfg.shuffleOdds !== false;                      // new random layout every race
    this.ledgerFile = opts.ledgerFile || null;
    this.sessions = new Map(); this.sessionsDirty = false; this._loadSessions(); this.cur = null; this.done = []; this.counter = 0;
    this.pending = new Map();                                          // credits that still have to reach the wallet
    this.pendingRb = new Map();                                        // debits of unknown outcome that must be rolled back
    this.stats = { rounds: 0, bets: 0, staked: 0, paid: 0, wins: {}, winsByOdds: {} };
    rng.COMBOS.forEach((c) => { this.stats.wins[c] = 0; });
    this.recent = []; this.reveals = []; this.busy = false;
    this.log = [];
  }

  get theoreticalRtp() { return this.rtp; }
  setRtp(v, who) {
    v = Number(v); if (v > 1) v = v / 100;
    if (!(v >= oddsLib.MIN_RTP - 1e-9 && v <= oddsLib.MAX_RTP + 1e-9)) throw httpError(400, 'RTP_OUT_OF_RANGE');
    v = Math.round(v * 10000) / 10000;
    const was = this.rtp; this.rtp = v;
    this._log({ e: 'rtp_set', from: was, to: v, who: who || 'controller', appliesFromRace: this.cur ? this.cur.raceNo + 1 : 1 });
    try { if (this.cfg.settingsFile) fs.writeFileSync(this.cfg.settingsFile, JSON.stringify({ rtp: v })); } catch (e) { console.error('could not save the RTP setting:', e.message); }
    return { ok: true, rtp: v, appliesFromRace: this.cur ? this.cur.raceNo + 1 : 1, currentRaceRtp: this.cur ? this.cur.rtp : null };
  }
  // what a setting would give (per odds value), without changing anything
  previewRtp(v) {
    v = Number(v); if (v > 1) v = v / 100;
    if (!(v >= oddsLib.MIN_RTP - 1e-9 && v <= oddsLib.MAX_RTP + 1e-9)) throw httpError(400, 'RTP_OUT_OF_RANGE');
    const t = oddsLib.buildForRtp(this.table.odds, v), cheap = new Set(t.cheap.map((c) => t.odds[c]));
    return {
      ok: true, rtp: v, uniformRtp: t.uniform, bestRtp: t.bestRtp, cheapRtp: t.cheapRtp, evenSpreadRtp: t.evenSpread,
      rows: this.values.map((o) => { const c = rng.COMBOS.find((x) => t.odds[x] === o); return { odds: o, probability: t.prob[c], rtp: t.rtpBy[c], cheap: cheap.has(o) }; })
    };
  }
  payoutFor(stake, combo, odds) { return Math.floor(stake * Math.round(odds[combo] * 1000) / 1000); }

  /* ---------- ledger ---------- */
  _log(ev) {
    ev.t = this.now();
    if (this.ledgerFile) fs.appendFileSync(this.ledgerFile, JSON.stringify(ev) + '\n');
    this.log.push(ev); if (this.log.length > 2000) this.log.shift();
  }

  // rebuild state from the ledger after a restart, then settle / refund whatever was in flight
  async recover() {
    if (!this.ledgerFile || !fs.existsSync(this.ledgerFile)) return;
    const rounds = new Map(), due = new Map(), ok = new Set(), rbDue = new Map(), rbDone = new Set();
    fs.readFileSync(this.ledgerFile, 'utf8').split('\n').filter(Boolean).forEach((line) => {
      let ev; try { ev = JSON.parse(line); } catch (e) { return; }
      if (ev.e === 'open') rounds.set(ev.raceNo, { raceNo: ev.raceNo, seed: ev.seed, commit: ev.commit, odds: ev.odds, rtp: ev.rtp, openAt: ev.openAt, betCloseAt: ev.betCloseAt, status: 'betting', bets: [], betsByPlayer: new Map() });
      const r = rounds.get(ev.raceNo);
      if (ev.e === 'bet' && r) { r.bets.push({ id: ev.id, raceNo: ev.raceNo, playerId: ev.playerId, combo: ev.combo, stake: ev.stake, status: 'open', payout: 0 }); }
      if (ev.e === 'draw' && r) Object.assign(r, { status: 'racing', combo: ev.combo, order: ev.order, animSeed: ev.animSeed, startAt: ev.startAt });
      if (ev.e === 'settled' && r) { r.status = 'settled'; r.payouts = ev.payouts; r.staked = ev.staked; r.paid = ev.paid; }
      if (ev.e === 'void' && r) r.status = 'void';
      if (ev.e === 'credit_due') due.set(ev.txId, ev);
      if (ev.e === 'credit_ok') ok.add(ev.txId);
      if (ev.e === 'rollback_due') rbDue.set(ev.txId, ev);
      if (ev.e === 'rollback_ok' || ev.e === 'rollback_unsupported') rbDone.add(ev.txId);
      if (ev.raceNo > this.counter) this.counter = ev.raceNo;
    });
    for (const [txId, ev] of due) if (!ok.has(txId)) this.pending.set(txId, { txId, playerId: ev.playerId, amount: ev.amount, raceNo: ev.raceNo, kind: ev.kind, tries: 0, nextAt: 0 });
    for (const [txId, ev] of rbDue) if (!rbDone.has(txId)) this.pendingRb.set(txId, { txId, playerId: ev.playerId, amount: ev.amount, raceNo: ev.raceNo, tries: 0, nextAt: 0 });
    for (const r of rounds.values()) {
      r.odds = r.odds || this.table.odds;
      const staked = r.bets.reduce((a, b) => a + b.stake, 0);
      if (r.status === 'settled') {
        this.stats.rounds++; this.stats.bets += r.bets.length; this.stats.staked += r.staked; this.stats.paid += r.paid; if (r.combo) this.stats.wins[r.combo]++;
        this.recent.push({ raceNo: r.raceNo, combo: r.combo, order: r.order, staked: r.staked, paid: r.paid, bets: r.bets.length, odds: r.odds ? r.odds[r.combo] : null });
        if (r.odds) this.stats.winsByOdds[r.odds[r.combo]] = (this.stats.winsByOdds[r.odds[r.combo]] || 0) + 1;
      } else if (r.status === 'racing') {            // drawn but never settled: settle now with the stored result
        r.bets.forEach((b) => { b.status = 'open'; });
        await this._settle(r);
      } else if (r.status === 'betting' && r.bets.length) { // bets taken but never drawn: void the round and refund
        this._log({ e: 'void', raceNo: r.raceNo, reason: 'restart' });
        const per = new Map(); r.bets.forEach((b) => per.set(b.playerId, (per.get(b.playerId) || 0) + b.stake));
        for (const [playerId, amount] of per) this._queueCredit('refund:' + r.raceNo + ':' + playerId, playerId, amount, r.raceNo, 'refund');
      }
    }
    this.recent = this.recent.slice(-100);
  }

  /* ---------- sessions ---------- */
  // sessions are kept in a file (hashed ids, owner-only permissions) so a restart does not log the players out
  _skey(id) { return crypto.createHash('sha256').update(String(id)).digest('hex'); }
  _loadSessions() {
    if (!this.cfg.sessionsFile) return;
    let list = []; try { list = JSON.parse(fs.readFileSync(this.cfg.sessionsFile, 'utf8')); } catch (e) { return; }
    const t = this.now();
    for (const x of list) if (x && x.key && x.expires > t) this.sessions.set(x.key, Object.assign({}, x, { refreshed: 0, calls: [] }));
  }
  _saveSessions() {
    if (!this.cfg.sessionsFile || !this.sessionsDirty) return;
    this.sessionsDirty = false;
    const list = [...this.sessions.values()].map((x) => ({ key: x.key, playerId: x.playerId, currency: x.currency, balance: x.balance, returnUrl: x.returnUrl, created: x.created, expires: x.expires }));
    try {
      const tmp = this.cfg.sessionsFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(list), { mode: 0o600 }); fs.renameSync(tmp, this.cfg.sessionsFile);
    } catch (e) { this.sessionsDirty = true; console.error('could not save sessions:', e.message); }
  }
  async auth(token) {
    let info;
    try { info = await this.wallet.validateToken(token); } catch (e) { throw httpError(401, 'INVALID_TOKEN'); }
    const id = crypto.randomBytes(24).toString('hex'), key = this._skey(id);
    this.sessions.set(key, { key, playerId: info.playerId, currency: info.currency || this.cfg.currency, balance: info.balance, returnUrl: info.returnUrl || null,
      created: this.now(), expires: this.now() + this.cfg.sessionTtlMs, refreshed: this.now(), calls: [] });
    this.sessionsDirty = true; this._saveSessions();
    return { session: id, playerId: info.playerId, currency: info.currency, balance: info.balance, returnUrl: info.returnUrl || null };
  }
  session(id) {
    const key = this._skey(id), s = this.sessions.get(key);
    if (!s || s.expires < this.now()) { if (s) { this.sessions.delete(key); this.sessionsDirty = true; } return null; }
    return s;
  }
  // operator / platform: end a player's sessions (all of them) at once
  closeSessions(playerId) {
    let n = 0; for (const [k, s] of this.sessions) if (s.playerId === playerId) { this.sessions.delete(k); n++; }
    if (n) { this.sessionsDirty = true; this._saveSessions(); this._log({ e: 'sessions_closed', playerId, count: n }); }
    return n;
  }
  _rate(s) { // at most 12 bet requests per 5 s per session
    const t = this.now(); s.calls = s.calls.filter((x) => t - x < 5000);
    if (s.calls.length >= 12) throw httpError(429, 'TOO_MANY_REQUESTS');
    s.calls.push(t);
  }

  /* ---------- betting ---------- */
  _inflightTotal(round, playerId) { return (round.betsByPlayer.get(playerId) || { total: 0 }).total; }

  async placeBets(sessionId, list) {
    const s = this.session(sessionId); if (!s) throw httpError(401, 'SESSION_EXPIRED');
    this._rate(s);
    const r = this.cur, cfg = this.cfg;
    if (!r || r.status !== 'betting' || this.now() >= r.betCloseAt) throw httpError(409, 'BETTING_CLOSED');
    if (!Array.isArray(list) || !list.length || list.length > rng.COMBOS.length) throw httpError(400, 'BAD_REQUEST');
    const merged = new Map();
    for (const b of list) {
      const stake = b && b.stake;
      if (!b || !rng.COMBOS.includes(b.combo) || !Number.isInteger(stake) || stake < cfg.minBet || stake > cfg.maxBet) throw httpError(400, 'BAD_BET');
      merged.set(b.combo, (merged.get(b.combo) || 0) + stake);
    }
    const mine = r.betsByPlayer.get(s.playerId) || { total: 0, per: {} };
    let total = 0;
    for (const [combo, stake] of merged) {
      if ((mine.per[combo] || 0) + stake > cfg.maxBet) throw httpError(400, 'MAX_BET_EXCEEDED');
      total += stake;
    }
    if (mine.total + total > cfg.maxRoundStake) throw httpError(400, 'MAX_ROUND_STAKE_EXCEEDED');

    // reserve the limit before waiting for the wallet so parallel requests cannot exceed it
    mine.total += total; merged.forEach((st, c) => { mine.per[c] = (mine.per[c] || 0) + st; }); r.betsByPlayer.set(s.playerId, mine);
    const rollback = () => { mine.total -= total; merged.forEach((st, c) => { mine.per[c] -= st; }); };
    const batch = crypto.randomBytes(8).toString('hex'), txId = 'bet:' + r.raceNo + ':' + batch;
    let res;
    try { res = await this._debit(s.playerId, total, txId, { raceNo: r.raceNo, kind: 'bet' }); }
    catch (e) { rollback(); throw e; }
    if (this.cur !== r || r.status !== 'betting' || this.now() >= r.betCloseAt) { // betting closed while the wallet was busy
      rollback(); this._queueCredit('refund:' + txId, s.playerId, total, r.raceNo, 'refund');
      throw httpError(409, 'BETTING_CLOSED');
    }
    s.balance = res.balance;
    const placed = [];
    merged.forEach((stake, combo) => {
      const bet = { id: batch + ':' + combo, raceNo: r.raceNo, playerId: s.playerId, combo, stake, status: 'open', payout: 0 };
      r.bets.push(bet); placed.push(bet);
      this._log({ e: 'bet', raceNo: r.raceNo, id: bet.id, playerId: s.playerId, combo, stake, txId });
    });
    return { bets: placed, balance: s.balance };
  }

  async _debit(playerId, amount, txId, meta) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try { return await this.wallet.debit(playerId, amount, txId, meta); }
      catch (e) {
        if (e.message === 'INSUFFICIENT_FUNDS') throw httpError(402, 'INSUFFICIENT_FUNDS');
        if (e.definitive) throw httpError(502, 'WALLET_REJECTED');
        if (attempt === 1) { this._log({ e: 'debit_unknown', playerId, amount, txId }); this._queueRollback(txId, playerId, amount, meta && meta.raceNo); throw httpError(502, 'WALLET_UNAVAILABLE'); }
        await new Promise((ok) => setTimeout(ok, 250));    // same txId again: the wallet is idempotent
      }
    }
  }

  _queueCredit(txId, playerId, amount, raceNo, kind) {
    if (!(amount > 0) || this.pending.has(txId)) return;
    this._log({ e: 'credit_due', txId, playerId, amount, raceNo, kind });
    this.pending.set(txId, { txId, playerId, amount, raceNo, kind, tries: 0, nextAt: 0 });
  }
  // a debit that timed out twice may or may not have been applied: ask the wallet to cancel it (and to refuse it if it arrives late)
  _queueRollback(txId, playerId, amount, raceNo) {
    if (this.pendingRb.has(txId)) return;
    this._log({ e: 'rollback_due', txId, playerId, amount, raceNo });
    this.pendingRb.set(txId, { txId, playerId, amount, raceNo, tries: 0, nextAt: 0 });
  }
  async _flushRollbacks() {
    const t = this.now();
    for (const p of [...this.pendingRb.values()]) {
      if (p.nextAt > t) continue;
      if (typeof this.wallet.rollback !== 'function') { this.pendingRb.delete(p.txId); this._log({ e: 'rollback_unsupported', txId: p.txId }); continue; }
      try {
        const res = await this.wallet.rollback(p.playerId, p.amount, p.txId, { raceNo: p.raceNo, kind: 'rollback' });
        this.pendingRb.delete(p.txId); this._log({ e: 'rollback_ok', txId: p.txId, status: res && res.status });
        for (const s of this.sessions.values()) if (s.playerId === p.playerId && res && res.balance != null) s.balance = res.balance;
      } catch (e) {
        if (e.unsupported) { this.pendingRb.delete(p.txId); this._log({ e: 'rollback_unsupported', txId: p.txId }); continue; }   // the platform has no rollback: reconcile by hand
        p.tries++; p.nextAt = t + Math.min(60000, 1000 * Math.pow(2, Math.min(p.tries, 6)));
      }
    }
  }
  async _flushCredits() {
    const t = this.now();
    for (const p of [...this.pending.values()]) {
      if (p.nextAt > t) continue;
      try {
        const res = await this.wallet.credit(p.playerId, p.amount, p.txId, { raceNo: p.raceNo, kind: p.kind });
        this.pending.delete(p.txId); this._log({ e: 'credit_ok', txId: p.txId, raceNo: p.raceNo });
        for (const s of this.sessions.values()) if (s.playerId === p.playerId && res && res.balance != null) s.balance = res.balance;
      } catch (e) { p.tries++; p.nextAt = t + Math.min(60000, 1000 * Math.pow(2, Math.min(p.tries, 6))); }
    }
  }

  /* ---------- round life cycle ---------- */
  _open() {
    const seed = rng.newSeed(), t = this.now();
    this.counter++;
    const odds = this.shuffle ? rng.oddsLayout(seed, this.counter, this.values) : this.table.odds, table = oddsLib.buildForRtp(odds, this.rtp);
    this.cur = { raceNo: this.counter, seed, commit: rng.commitOf(seed), odds, table, rtp: this.rtp, openAt: t, betCloseAt: t + this.cfg.betMs, status: 'betting', bets: [], betsByPlayer: new Map() };
    this._log({ e: 'open', raceNo: this.cur.raceNo, seed, commit: this.cur.commit, odds, rtp: this.rtp, openAt: t, betCloseAt: this.cur.betCloseAt });
  }
  _drawNow(r) {
    const o = rng.draw(r.seed, r.raceNo, r.table.weights);
    Object.assign(r, { status: 'racing', combo: o.combo, order: o.order, animSeed: o.animSeed, startAt: this.now() + this.cfg.countdownMs });
    this._log({ e: 'draw', raceNo: r.raceNo, combo: r.combo, order: r.order, animSeed: r.animSeed, startAt: r.startAt });
  }
  async _settle(r) {
    const payouts = new Map(); let staked = 0, paid = 0;
    r.bets.forEach((b) => {
      staked += b.stake;
      if (b.combo === r.combo) { b.status = 'won'; b.payout = this.payoutFor(b.stake, b.combo, r.odds); paid += b.payout; payouts.set(b.playerId, (payouts.get(b.playerId) || 0) + b.payout); }
      else { b.status = 'lost'; b.payout = 0; }
    });
    r.status = 'settled'; r.staked = staked; r.paid = paid;
    this._log({ e: 'settled', raceNo: r.raceNo, combo: r.combo, staked, paid, payouts: [...payouts].map(([playerId, amount]) => ({ playerId, amount })) });
    for (const [playerId, amount] of payouts) this._queueCredit('win:' + r.raceNo + ':' + playerId, playerId, amount, r.raceNo, 'win');
    this.stats.rounds++; this.stats.bets += r.bets.length; this.stats.staked += staked; this.stats.paid += paid; this.stats.wins[r.combo]++;
    const wo = r.odds[r.combo]; this.stats.winsByOdds[wo] = (this.stats.winsByOdds[wo] || 0) + 1;
    this.recent.push({ raceNo: r.raceNo, combo: r.combo, order: r.order, staked, paid, bets: r.bets.length, odds: wo });
    if (this.recent.length > 100) this.recent.shift();
    this.reveals.push({ raceNo: r.raceNo, seed: r.seed, commit: r.commit, combo: r.combo, order: r.order, odds: r.odds, rtp: r.rtp });
    if (this.reveals.length > 20) this.reveals.shift();
    await this._flushCredits();
  }

  async tick() {
    if (this.busy) return; this.busy = true;
    try {
      const t = this.now(), c = this.cfg;
      if (!this.cur) this._open();
      let r = this.cur;
      if (r.status === 'betting' && t >= r.betCloseAt) this._drawNow(r);
      if (r.status === 'racing' && t >= r.startAt + c.raceMs) await this._settle(r);
      if (r.status === 'settled' && t >= r.startAt + c.raceMs + c.resultsMs) { this.done.push(r); if (this.done.length > 30) this.done.shift(); this._open(); }
      await this._flushCredits(); await this._flushRollbacks();
      for (const [k, s] of this.sessions) if (s.expires < t) { this.sessions.delete(k); this.sessionsDirty = true; }
      this._saveSessions();
    } finally { this.busy = false; }
  }

  /* ---------- views ---------- */
  _phase(r, t) {
    if (r.status === 'betting') return 'betting';
    if (t < r.startAt) return 'closed';
    if (t < r.startAt + this.cfg.raceMs) return 'racing';
    return 'results';
  }
  rules() {
    return { combos: rng.COMBOS, oddsValues: this.values, shuffleOdds: this.shuffle, minBet: this.cfg.minBet, maxBet: this.cfg.maxBet, maxRoundStake: this.cfg.maxRoundStake, currency: this.cfg.currency };
  }
  publicState() {
    const t = this.now(), r = this.cur, drawn = r && r.order ? r : this.done[this.done.length - 1];
    const st = {
      mode: 'live', serverNow: t, nextRaceNo: r ? r.raceNo + (r.status === 'betting' ? 0 : 1) : 1,
      timings: { countdown: this.cfg.countdownMs, race: this.cfg.raceMs, results: this.cfg.resultsMs, bet: this.cfg.betMs },
      rules: this.rules(),
      round: r ? { raceNo: r.raceNo, phase: this._phase(r, t), openAt: r.openAt, betCloseAt: r.betCloseAt, startAt: r.startAt || null, commit: r.commit, odds: r.odds, rtp: r.rtp, cheapRtp: r.table.cheapRtp, cheapPairs: r.table.cheap } : null,
      race: null,
      history: this.recent.slice(-8).map((x) => ({ raceNo: x.raceNo, order: x.order })),
      reveals: this.reveals.slice(-5)
    };
    if (drawn) st.race = { raceNo: drawn.raceNo, startAt: drawn.startAt, seed: drawn.animSeed, order: t >= drawn.startAt - 2000 ? drawn.order.slice() : null };
    return st;
  }
  async me(sessionId) {
    const s = this.session(sessionId); if (!s) throw httpError(401, 'SESSION_EXPIRED');
    if (this.now() - s.refreshed > 15000) {
      s.refreshed = this.now();
      try { s.balance = await this.wallet.balance(s.playerId); } catch (e) { /* keep the cached balance */ }
    }
    const mine = (r) => r.bets.filter((b) => b.playerId === s.playerId).map((b) => ({ combo: b.combo, stake: b.stake, odds: r.odds[b.combo], status: b.status, payout: b.payout }));
    const out = { playerId: s.playerId, currency: s.currency, balance: s.balance, returnUrl: s.returnUrl, raceNo: null, bets: [], last: null };
    if (this.cur) { out.raceNo = this.cur.raceNo; out.bets = mine(this.cur); }
    const prev = this.cur && this.cur.status === 'settled' ? this.cur : this.done[this.done.length - 1];
    if (prev && prev !== this.cur) { const b = mine(prev); if (b.length) out.last = { raceNo: prev.raceNo, combo: prev.combo, bets: b }; }
    if (this.cur && this.cur.status === 'settled') { const b = mine(this.cur); if (b.length) out.last = { raceNo: this.cur.raceNo, combo: this.cur.combo, bets: b }; }
    return out;
  }
  report() {
    const s = this.stats, p = this.previewRtp(this.rtp), paidIn = s.staked;
    return {
      mode: 'live', rtpSetting: this.rtp, rtpOfCurrentRace: this.cur ? this.cur.rtp : null, bestBetRtp: p.bestRtp, cheapPairsRtp: p.cheapRtp, evenSpreadRtp: p.evenSpreadRtp,
      theoreticalRtp: this.rtp, shuffleOdds: this.shuffle, oddsValues: this.values, winsByOdds: s.winsByOdds,
      oddsProb: p.rows.reduce((o, r) => { o[r.odds] = r.probability; return o; }, {}), limits: { minBet: this.cfg.minBet, maxBet: this.cfg.maxBet, maxRoundStake: this.cfg.maxRoundStake },
      rounds: s.rounds, bets: s.bets, staked: s.staked, paid: s.paid, actualRtp: paidIn ? s.paid / paidIn : null,
      houseWin: paidIn - s.paid, wins: s.wins, pendingCredits: this.pending.size, pendingRollbacks: this.pendingRb.size, activeSessions: this.sessions.size, currency: this.cfg.currency,
      recent: this.recent.slice(-50).reverse(), commit: this.cur ? this.cur.commit : null, currentRound: this.cur ? this.cur.raceNo : null
    };
  }
}

module.exports = { Engine, httpError };
