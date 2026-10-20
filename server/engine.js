'use strict';
/*
 * Live game engine: continuous rounds, bets, draw, settlement and the audit ledger.
 *
 *   BETTING (BET_MS) -> draw at bet close -> COUNTDOWN -> RACE -> RESULTS (settlement at the end of the race)
 *
 * Fixed odds per pair (server/odds.js): a winning bet pays stake x odds (stake included). Each pair is drawn with
 * probability proportional to 1/odds, so every bet has the same RTP. Money is integer minor units; payouts round down.
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
      rtp: 0.9, betMs: 25000, countdownMs: Core.COUNTDOWN_MS, raceMs: Core.RACE_MS, resultsMs: Core.RESULTS_MS,
      minBet: 100, maxBet: 100000, maxRoundStake: 500000, sessionTtlMs: 12 * 3600 * 1000, odds: null, currency: 'PHP'
    }, opts.config || {});
    this.table = oddsLib.build(this.cfg.odds);                          // odds, draw weights and the RTP they give
    this.ledgerFile = opts.ledgerFile || null;
    this.sessions = new Map(); this.cur = null; this.done = []; this.counter = 0;
    this.pending = new Map();                                          // credits that still have to reach the wallet
    this.stats = { rounds: 0, bets: 0, staked: 0, paid: 0, wins: {} };
    rng.COMBOS.forEach((c) => { this.stats.wins[c] = 0; });
    this.recent = []; this.reveals = []; this.busy = false;
    this.log = [];
  }

  get theoreticalRtp() { return this.table.rtp; }
  payoutFor(stake, combo) { return Math.floor(stake * Math.round(this.table.odds[combo] * 1000) / 1000); }

  /* ---------- ledger ---------- */
  _log(ev) {
    ev.t = this.now();
    if (this.ledgerFile) fs.appendFileSync(this.ledgerFile, JSON.stringify(ev) + '\n');
    this.log.push(ev); if (this.log.length > 2000) this.log.shift();
  }

  // rebuild state from the ledger after a restart, then settle / refund whatever was in flight
  async recover() {
    if (!this.ledgerFile || !fs.existsSync(this.ledgerFile)) return;
    const rounds = new Map(), due = new Map(), ok = new Set();
    fs.readFileSync(this.ledgerFile, 'utf8').split('\n').filter(Boolean).forEach((line) => {
      let ev; try { ev = JSON.parse(line); } catch (e) { return; }
      if (ev.e === 'open') rounds.set(ev.raceNo, { raceNo: ev.raceNo, seed: ev.seed, commit: ev.commit, openAt: ev.openAt, betCloseAt: ev.betCloseAt, status: 'betting', bets: [], betsByPlayer: new Map() });
      const r = rounds.get(ev.raceNo);
      if (ev.e === 'bet' && r) { r.bets.push({ id: ev.id, raceNo: ev.raceNo, playerId: ev.playerId, combo: ev.combo, stake: ev.stake, status: 'open', payout: 0 }); }
      if (ev.e === 'draw' && r) Object.assign(r, { status: 'racing', combo: ev.combo, order: ev.order, animSeed: ev.animSeed, startAt: ev.startAt });
      if (ev.e === 'settled' && r) { r.status = 'settled'; r.payouts = ev.payouts; r.staked = ev.staked; r.paid = ev.paid; }
      if (ev.e === 'void' && r) r.status = 'void';
      if (ev.e === 'credit_due') due.set(ev.txId, ev);
      if (ev.e === 'credit_ok') ok.add(ev.txId);
      if (ev.raceNo > this.counter) this.counter = ev.raceNo;
    });
    for (const [txId, ev] of due) if (!ok.has(txId)) this.pending.set(txId, { txId, playerId: ev.playerId, amount: ev.amount, raceNo: ev.raceNo, kind: ev.kind, tries: 0, nextAt: 0 });
    for (const r of rounds.values()) {
      const staked = r.bets.reduce((a, b) => a + b.stake, 0);
      if (r.status === 'settled') {
        this.stats.rounds++; this.stats.bets += r.bets.length; this.stats.staked += r.staked; this.stats.paid += r.paid; if (r.combo) this.stats.wins[r.combo]++;
        this.recent.push({ raceNo: r.raceNo, combo: r.combo, order: r.order, staked: r.staked, paid: r.paid, bets: r.bets.length });
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
  async auth(token) {
    let info;
    try { info = await this.wallet.validateToken(token); } catch (e) { throw httpError(401, 'INVALID_TOKEN'); }
    const id = crypto.randomBytes(24).toString('hex');
    this.sessions.set(id, { id, playerId: info.playerId, currency: info.currency || this.cfg.currency, balance: info.balance, returnUrl: info.returnUrl || null,
      created: this.now(), expires: this.now() + this.cfg.sessionTtlMs, refreshed: this.now(), calls: [] });
    return { session: id, playerId: info.playerId, currency: info.currency, balance: info.balance, returnUrl: info.returnUrl || null };
  }
  session(id) {
    const s = this.sessions.get(id);
    if (!s || s.expires < this.now()) { this.sessions.delete(id); return null; }
    return s;
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
        if (attempt === 1) { this._log({ e: 'debit_unknown', playerId, amount, txId }); throw httpError(502, 'WALLET_UNAVAILABLE'); }
        await new Promise((ok) => setTimeout(ok, 250));    // same txId again: the wallet is idempotent
      }
    }
  }

  _queueCredit(txId, playerId, amount, raceNo, kind) {
    if (!(amount > 0) || this.pending.has(txId)) return;
    this._log({ e: 'credit_due', txId, playerId, amount, raceNo, kind });
    this.pending.set(txId, { txId, playerId, amount, raceNo, kind, tries: 0, nextAt: 0 });
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
    this.cur = { raceNo: this.counter, seed, commit: rng.commitOf(seed), openAt: t, betCloseAt: t + this.cfg.betMs, status: 'betting', bets: [], betsByPlayer: new Map() };
    this._log({ e: 'open', raceNo: this.cur.raceNo, seed, commit: this.cur.commit, openAt: t, betCloseAt: this.cur.betCloseAt });
  }
  _drawNow(r) {
    const o = rng.draw(r.seed, r.raceNo, this.table.weights);
    Object.assign(r, { status: 'racing', combo: o.combo, order: o.order, animSeed: o.animSeed, startAt: this.now() + this.cfg.countdownMs });
    this._log({ e: 'draw', raceNo: r.raceNo, combo: r.combo, order: r.order, animSeed: r.animSeed, startAt: r.startAt });
  }
  async _settle(r) {
    const payouts = new Map(); let staked = 0, paid = 0;
    r.bets.forEach((b) => {
      staked += b.stake;
      if (b.combo === r.combo) { b.status = 'won'; b.payout = this.payoutFor(b.stake, b.combo); paid += b.payout; payouts.set(b.playerId, (payouts.get(b.playerId) || 0) + b.payout); }
      else { b.status = 'lost'; b.payout = 0; }
    });
    r.status = 'settled'; r.staked = staked; r.paid = paid;
    this._log({ e: 'settled', raceNo: r.raceNo, combo: r.combo, staked, paid, payouts: [...payouts].map(([playerId, amount]) => ({ playerId, amount })) });
    for (const [playerId, amount] of payouts) this._queueCredit('win:' + r.raceNo + ':' + playerId, playerId, amount, r.raceNo, 'win');
    this.stats.rounds++; this.stats.bets += r.bets.length; this.stats.staked += staked; this.stats.paid += paid; this.stats.wins[r.combo]++;
    this.recent.push({ raceNo: r.raceNo, combo: r.combo, order: r.order, staked, paid, bets: r.bets.length });
    if (this.recent.length > 100) this.recent.shift();
    this.reveals.push({ raceNo: r.raceNo, seed: r.seed, commit: r.commit, combo: r.combo, order: r.order });
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
      await this._flushCredits();
      for (const [id, s] of this.sessions) if (s.expires < t) this.sessions.delete(id);
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
    return { combos: rng.COMBOS, odds: this.table.odds, minBet: this.cfg.minBet, maxBet: this.cfg.maxBet, maxRoundStake: this.cfg.maxRoundStake, currency: this.cfg.currency };
  }
  publicState() {
    const t = this.now(), r = this.cur, drawn = r && r.order ? r : this.done[this.done.length - 1];
    const st = {
      mode: 'live', serverNow: t, nextRaceNo: r ? r.raceNo + (r.status === 'betting' ? 0 : 1) : 1,
      timings: { countdown: this.cfg.countdownMs, race: this.cfg.raceMs, results: this.cfg.resultsMs, bet: this.cfg.betMs },
      rules: this.rules(),
      round: r ? { raceNo: r.raceNo, phase: this._phase(r, t), openAt: r.openAt, betCloseAt: r.betCloseAt, startAt: r.startAt || null, commit: r.commit } : null,
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
    const mine = (r) => r.bets.filter((b) => b.playerId === s.playerId).map((b) => ({ combo: b.combo, stake: b.stake, status: b.status, payout: b.payout }));
    const out = { playerId: s.playerId, currency: s.currency, balance: s.balance, returnUrl: s.returnUrl, raceNo: null, bets: [], last: null };
    if (this.cur) { out.raceNo = this.cur.raceNo; out.bets = mine(this.cur); }
    const prev = this.cur && this.cur.status === 'settled' ? this.cur : this.done[this.done.length - 1];
    if (prev && prev !== this.cur) { const b = mine(prev); if (b.length) out.last = { raceNo: prev.raceNo, combo: prev.combo, bets: b }; }
    if (this.cur && this.cur.status === 'settled') { const b = mine(this.cur); if (b.length) out.last = { raceNo: this.cur.raceNo, combo: this.cur.combo, bets: b }; }
    return out;
  }
  report() {
    const s = this.stats;
    return {
      mode: 'live', theoreticalRtp: this.theoreticalRtp, rtpMin: this.table.rtpMin, rtpMax: this.table.rtpMax, odds: this.table.odds, prob: this.table.prob,
      rounds: s.rounds, bets: s.bets, staked: s.staked, paid: s.paid, actualRtp: s.staked ? s.paid / s.staked : null,
      houseWin: s.staked - s.paid, wins: s.wins, pendingCredits: this.pending.size, activeSessions: this.sessions.size,
      limits: { minBet: this.cfg.minBet, maxBet: this.cfg.maxBet, maxRoundStake: this.cfg.maxRoundStake }, currency: this.cfg.currency,
      recent: this.recent.slice(-50).reverse(), commit: this.cur ? this.cur.commit : null, currentRound: this.cur ? this.cur.raceNo : null
    };
  }
}

module.exports = { Engine, httpError };
