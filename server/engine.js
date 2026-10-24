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
const { Ledger } = require('./ledger.js');
const { asDoc } = require('./store.js');
const { Metrics } = require('./metrics.js');
const { ID_RE } = require('./clients.js');
const PLAYER_ID_RE = /^[A-Za-z0-9_.@-]{1,64}$/;      // a player id from a client wallet; no ':' so that "client:player" is unambiguous

function httpError(status, code) { const e = new Error(code); e.status = status; e.code = code; return e; }

class Engine {
  constructor(opts) {
    this.wallet = opts.wallet || null;                                 // wallet of the implicit "default" client (WALLET env); other clients come from the registry
    this.clients = opts.clients || null;                               // server/clients.js
    this.now = opts.now || Date.now;
    this.cfg = Object.assign({
      rtp: 0.9, settingsFile: null, betMs: 25000, countdownMs: Core.COUNTDOWN_MS, raceMs: Core.RACE_MS, resultsMs: Core.RESULTS_MS,
      minBet: 100, maxBet: 100000, maxRoundStake: 500000, sessionTtlMs: 12 * 3600 * 1000, sessionsFile: null, blockedFile: null, odds: null,
      dailyLossLimit: 0, realityCheckMinutes: 0, bigWinMin: 1000000, currencyLimits: {}, gameId: 'horse-race', currency: 'PHP'
    }, opts.config || {});
    this.table = oddsLib.build(this.cfg.odds);                          // base table: the odds values
    this.values = rng.COMBOS.map((c) => this.table.odds[c]).sort((a, b) => a - b);
    this.rtp = this.cfg.rtp;                                            // applies to rounds opened from now on
    this.cfg.settingsFile = asDoc(this.cfg.settingsFile); this.cfg.sessionsFile = asDoc(this.cfg.sessionsFile); this.cfg.blockedFile = asDoc(this.cfg.blockedFile);   // paths or storage docs
    try { if (this.cfg.settingsFile) { const st = JSON.parse(this.cfg.settingsFile.read()); if (st.rtp >= oddsLib.MIN_RTP && st.rtp <= oddsLib.MAX_RTP) this.rtp = st.rtp; } } catch (e) { /* no saved setting */ }
    oddsLib.buildForRtp(this.table.odds, this.rtp);                     // throws if the configured RTP is out of range
    this.shuffle = this.cfg.shuffleOdds !== false;                      // new random layout every race
    this.ledgerFile = asDoc(opts.ledgerFile);
    this.ledger = new Ledger(this.ledgerFile);                          // hash-chained audit log (server/ledger.js)
    if (!this.ledger.ok && this.cfg.ledgerStrict) throw new Error('LEDGER_TAMPERED: line ' + this.ledger.check.broken.line + ' - ' + this.ledger.check.broken.reason);
    this.sessions = new Map(); this.sessionsDirty = false; this._loadSessions(); this.cur = null; this.done = []; this.counter = 0;
    this.pending = new Map();                                          // credits that still have to reach the wallet
    this.metrics = new Metrics(this.now); this.closing = false;
    this.rtpTrack = { exp: 0, varsum: 0, paid: 0, staked: 0, rounds: 0 };   // what the odds predict for the bets actually placed
    this.clientRecent = new Map(); this.boAudit = new Map();           // per client: its recent rounds, back-office actions
    this.pendingWh = new Map();                                        // webhook events the platform has not confirmed yet
    this.webhook = opts.webhook || null;
    this.history = new Map(); this.proofs = new Map();                 // per-player bet history, revealed draws
    this.daily = new Map();                                            // per-player stake / payout of the current day (for loss limits)
    this.blocked = new Set(); this._loadBlocked();
    this.pendingRb = new Map();                                        // debits of unknown outcome that must be rolled back
    this.stats = { rounds: 0, bets: 0, staked: 0, paid: 0, wins: {}, winsByOdds: {}, byCurrency: {}, byClient: {} };
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
    try { if (this.cfg.settingsFile) this.cfg.settingsFile.write(JSON.stringify({ rtp: v })); } catch (e) { console.error('could not save the RTP setting:', e.message); }
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
    if (this.ledgerFile) this.ledger.append(ev);
    this.log.push(ev); if (this.log.length > 2000) this.log.shift();
  }

  // rebuild state from the ledger after a restart, then settle / refund whatever was in flight
  async recover() {
    if (!this.ledgerFile || !this.ledgerFile.exists()) return;
    const rounds = new Map(), due = new Map(), ok = new Set(), rbDue = new Map(), rbDone = new Set(), whDue = new Map(), whDone = new Set();
    (this.ledgerFile.read() || '').split('\n').filter(Boolean).forEach((line) => {
      let ev; try { ev = JSON.parse(line); } catch (e) { return; }
      if (ev.e === 'open') rounds.set(ev.raceNo, { raceNo: ev.raceNo, seed: ev.seed, commit: ev.commit, odds: ev.odds, rtp: ev.rtp, openAt: ev.openAt, betCloseAt: ev.betCloseAt, status: 'betting', bets: [], betsByPlayer: new Map() });
      const r = rounds.get(ev.raceNo);
      if (ev.e === 'bet' && r) {
        r.bets.push({ id: ev.id, raceNo: ev.raceNo, playerId: ev.playerId, combo: ev.combo, stake: ev.stake, status: 'open', payout: 0, currency: ev.currency || this.cfg.currency, brandId: ev.brandId || null, placedAt: ev.t });
        if (this._day(ev.t) === this._day()) this._dayRec(ev.playerId).staked += ev.stake;
      }
      if (ev.e === 'draw' && r) Object.assign(r, { status: 'racing', combo: ev.combo, order: ev.order, animSeed: ev.animSeed, startAt: ev.startAt });
      if (ev.e === 'bo_action') { const l = this.boAudit.get(ev.clientId) || []; this.boAudit.set(ev.clientId, l); const { e: _e, t: _t, h: _h, ...rest } = ev; l.push(Object.assign({ at: _t }, rest)); if (l.length > 500) l.shift(); }
      if (ev.e === 'settled' && r) { r.settledAt = ev.t; r.status = 'settled'; r.payouts = ev.payouts; r.staked = ev.staked; r.paid = ev.paid; if (this._day(ev.t) === this._day()) (ev.payouts || []).forEach((p) => { this._dayRec(p.playerId).paid += p.amount; }); }
      if (ev.e === 'void' && r) { r.status = 'void'; r.bets.forEach((b) => { if (this._day(b.placedAt) === this._day()) this._dayRec(b.playerId).staked -= b.stake; }); }
      if (ev.e === 'credit_due') due.set(ev.txId, ev);
      if (ev.e === 'credit_ok') ok.add(ev.txId);
      if (ev.e === 'webhook_due') whDue.set(ev.ev.id, ev.ev);
      if (ev.e === 'webhook_ok') whDone.add(ev.id);
      if (ev.e === 'rollback_due') rbDue.set(ev.txId, ev);
      if (ev.e === 'rollback_ok' || ev.e === 'rollback_unsupported') rbDone.add(ev.txId);
      if (ev.raceNo > this.counter) this.counter = ev.raceNo;
    });
    for (const [txId, ev] of due) if (!ok.has(txId)) this.pending.set(txId, { txId, playerId: ev.playerId, amount: ev.amount, raceNo: ev.raceNo, kind: ev.kind, extra: ev.extra || {}, since: ev.t || this.now(), tries: 0, nextAt: 0 });
    for (const [txId, ev] of rbDue) if (!rbDone.has(txId)) this.pendingRb.set(txId, { txId, playerId: ev.playerId, amount: ev.amount, raceNo: ev.raceNo, extra: ev.extra || {}, since: ev.t || this.now(), tries: 0, nextAt: 0 });
    if (this.webhook || this.clients) for (const [id, ev] of whDue) if (!whDone.has(id)) this.pendingWh.set(id, { ev, since: ev.createdAt || this.now(), tries: 0, nextAt: 0 });
    for (const r of rounds.values()) {
      r.odds = r.odds || this.table.odds;
      const staked = r.bets.reduce((a, b) => a + b.stake, 0);
      if (r.status === 'settled') {
        try { r.table = r.rtp ? oddsLib.buildForRtp(r.odds, r.rtp) : null; } catch (e) { r.table = null; }
        r.bets.forEach((b) => {                      // per-bet result, for the history and the per-currency totals
          const won = b.combo === r.combo; b.status = won ? 'won' : 'lost'; b.payout = won && r.odds ? this.payoutFor(b.stake, b.combo, r.odds) : 0;
          const cs = this.stats.byCurrency[b.currency] || (this.stats.byCurrency[b.currency] = { staked: 0, paid: 0 }); cs.staked += b.stake; cs.paid += b.payout;
          this._track(b, r); this._statClient(b);
        });
        this._archiveRound(r); this._clientRounds(r, r.settledAt);
        this.stats.rounds++; this.stats.bets += r.bets.length; this.stats.staked += r.staked; this.stats.paid += r.paid; if (r.combo) this.stats.wins[r.combo]++;
        this.recent.push({ raceNo: r.raceNo, combo: r.combo, order: r.order, staked: r.staked, paid: r.paid, bets: r.bets.length, odds: r.odds ? r.odds[r.combo] : null });
        if (r.odds) this.stats.winsByOdds[r.odds[r.combo]] = (this.stats.winsByOdds[r.odds[r.combo]] || 0) + 1;
      } else if (r.status === 'void') {
        r.bets.forEach((b) => { b.status = 'refunded'; this._archiveBet(b, r); });
      } else if (r.status === 'racing') {            // drawn but never settled: settle now with the stored result
        r.bets.forEach((b) => { b.status = 'open'; });
        await this._settle(r);
      } else if (r.status === 'betting' && r.bets.length) { // bets taken but never drawn: void the round and refund
        this._log({ e: 'void', raceNo: r.raceNo, reason: 'restart' });
        r.bets.forEach((b) => { if (this._day(b.placedAt) === this._day()) this._dayRec(b.playerId).staked -= b.stake; b.status = 'refunded'; this._archiveBet(b, r); });
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
    let list = []; try { list = JSON.parse(this.cfg.sessionsFile.read()) || []; } catch (e) { return; }
    const t = this.now();
    for (const x of list) if (x && x.key && x.expires > t) { const sp = this.splitPk(x.playerId); this.sessions.set(x.key, Object.assign({ clientId: sp.clientId, rawId: sp.playerId }, x, { refreshed: 0, calls: [] })); }
  }
  _saveSessions(force) {
    if (!this.cfg.sessionsFile || !this.sessionsDirty) return;
    if (!force && this.now() - (this.lastSessionSave || 0) < 5000) return;        // busy tables: at most one write every 5 s
    this.sessionsDirty = false; this.lastSessionSave = this.now();
    const list = [...this.sessions.values()].map((x) => ({ key: x.key, playerId: x.playerId, rawId: x.rawId, clientId: x.clientId, brandId: x.brandId, currency: x.currency, decimals: x.decimals, balance: x.balance, returnUrl: x.returnUrl,
      limits: x.limits, realityMinutes: x.realityMinutes, sStaked: x.sStaked, sPaid: x.sPaid, created: x.created, expires: x.expires }));
    try {
      this.cfg.sessionsFile.write(JSON.stringify(list), { mode: 0o600 });
    } catch (e) { this.sessionsDirty = true; console.error('could not save sessions:', e.message); }
  }
  /* ---------- clients: every player belongs to one client (platform). Internally a player is "clientId:playerId" ("default" client: just playerId) ---------- */
  pk(clientId, playerId) { return !clientId || clientId === 'default' ? playerId : clientId + ':' + playerId; }
  splitPk(pk) { const i = String(pk).indexOf(':'); return i < 0 ? { clientId: 'default', playerId: pk } : { clientId: pk.slice(0, i), playerId: pk.slice(i + 1) }; }
  _regClient(id) { return this.clients ? this.clients.get(id) : null; }
  _clientCfg(id) { return this._regClient(id) || { id, status: 'active', limits: {}, currencyLimits: {} }; }
  _walletFor(id) {
    if (this._regClient(id)) return this.clients.walletFor(id);
    return id === 'default' ? this.wallet : null;
  }
  _webhookFor(id) {
    if (this._regClient(id)) return this.clients.webhookFor(id);
    return id === 'default' ? this.webhook : null;
  }
  _clientActive(id) { const c = this._regClient(id); return c ? c.status === 'active' : (id === 'default' && !!this.wallet); }
  // which client a launch belongs to (the launch link may omit it when there is only one)
  resolveClient(clientId) {
    if (!clientId) {
      if (this._walletFor('default')) return 'default';
      const active = this.clients ? this.clients.list().filter((c) => c.status === 'active') : [];
      if (active.length === 1) return active[0].id;
      throw httpError(400, 'CLIENT_REQUIRED');
    }
    clientId = String(clientId);
    if (!ID_RE.test(clientId)) throw httpError(400, 'INVALID_CLIENT');
    const c = this._regClient(clientId);
    if (c) { if (c.status !== 'active') throw httpError(403, 'CLIENT_DISABLED'); return clientId; }
    if (clientId === 'default' && this.wallet) return 'default';
    throw httpError(400, 'INVALID_CLIENT');
  }
  playerKey(clientId, playerId) { clientId = clientId || 'default'; if (!PLAYER_ID_RE.test(String(playerId || ''))) throw httpError(400, 'BAD_REQUEST'); return this.pk(clientId, String(playerId)); }

  _limitsFor(currency, info, client) {
    const base = { minBet: this.cfg.minBet, maxBet: this.cfg.maxBet, maxRoundStake: this.cfg.maxRoundStake, dailyLossLimit: this.cfg.dailyLossLimit || 0 };
    const posInt = (v) => Number.isInteger(v) && v > 0;
    client = client || {};
    for (const src of [(this.cfg.currencyLimits || {})[currency], client.limits, (client.currencyLimits || {})[currency], info && info.limits]) {    // server table, then the client's settings, then what the platform sends for this player
      if (!src) continue;
      for (const k of ['minBet', 'maxBet', 'maxRoundStake']) if (posInt(src[k])) base[k] = src[k];
      if (Number.isInteger(src.dailyLossLimit) && src.dailyLossLimit >= 0) base.dailyLossLimit = src.dailyLossLimit;
    }
    if (base.maxBet < base.minBet) base.maxBet = base.minBet;
    if (base.maxRoundStake < base.minBet) base.maxRoundStake = base.minBet;
    return base;
  }
  _decimals(currency, info, client) {
    const d = info && Number.isInteger(info.decimals) ? info.decimals : (((client || {}).currencyLimits || {})[currency] || {}).decimals != null ? client.currencyLimits[currency].decimals : ((this.cfg.currencyLimits || {})[currency] || {}).decimals;
    return Number.isInteger(d) && d >= 0 && d <= 4 ? d : 2;
  }
  async auth(token, clientHint) {
    let info;
    if (this.closing) throw httpError(503, 'SHUTTING_DOWN');
    const clientId = this.resolveClient(clientHint), client = this._clientCfg(clientId), wallet = this._walletFor(clientId);
    if (!wallet) throw httpError(400, 'INVALID_CLIENT');
    try { info = await this._w('validate', () => wallet.validateToken(token), clientId); } catch (e) { throw httpError(401, 'INVALID_TOKEN'); }
    if (!PLAYER_ID_RE.test(String(info.playerId || ''))) throw httpError(401, 'INVALID_PLAYER_ID');
    const pk = this.pk(clientId, String(info.playerId));
    if (info.blocked || this.blocked.has(pk)) throw httpError(403, 'PLAYER_BLOCKED');
    const id = crypto.randomBytes(24).toString('hex'), key = this._skey(id), currency = info.currency || client.currency || this.cfg.currency;
    const rm = Number.isInteger(info.realityCheckMinutes) ? info.realityCheckMinutes : (client.realityCheckMinutes !== undefined ? client.realityCheckMinutes : this.cfg.realityCheckMinutes);
    let returnUrl = info.returnUrl || null;
    if (returnUrl && client.returnUrlHosts && client.returnUrlHosts.length) { try { if (!client.returnUrlHosts.includes(new URL(returnUrl).hostname.toLowerCase())) returnUrl = null; } catch (e) { returnUrl = null; } }
    this.sessions.set(key, { key, playerId: pk, rawId: String(info.playerId), clientId, brandId: info.brandId ? String(info.brandId) : null, currency, decimals: this._decimals(currency, info, client), balance: info.balance,
      returnUrl, limits: this._limitsFor(currency, info, client), realityMinutes: rm > 0 ? rm : 0, sStaked: 0, sPaid: 0,
      created: this.now(), expires: this.now() + this.cfg.sessionTtlMs, refreshed: this.now(), calls: [] });
    this.sessionsDirty = true; this._saveSessions(true);
    return Object.assign({ session: id, playerId: String(info.playerId), returnUrl }, this._sessionView(this.sessions.get(key)));
  }
  _sessionView(s) {
    return { currency: s.currency, decimals: s.decimals, balance: s.balance, limits: s.limits, brandId: s.brandId,
      responsible: { realityCheckMinutes: s.realityMinutes, startedAt: s.created, staked: s.sStaked, paid: s.sPaid, dailyNetLoss: Math.max(0, this._dayNet(s.playerId)) } };
  }
  session(id) {
    const key = this._skey(id), s = this.sessions.get(key);
    if (!s || s.expires < this.now() || !this._clientActive(s.clientId || 'default')) { if (s) { this.sessions.delete(key); this.sessionsDirty = true; } return null; }     // a disabled client ends its sessions
    return s;
  }
  // operator / platform: end a player's sessions (all of them) at once
  closeSessions(playerId) {
    let n = 0; for (const [k, s] of this.sessions) if (s.playerId === playerId) { this.sessions.delete(k); n++; }
    if (n) { this.sessionsDirty = true; this._saveSessions(); this._log({ e: 'sessions_closed', playerId, count: n }); }
    return n;
  }
  /* ---------- blocked players (self-exclusion, set by the platform / operator) ---------- */
  _loadBlocked() { try { if (this.cfg.blockedFile) this.blocked = new Set(JSON.parse(this.cfg.blockedFile.read())); } catch (e) { /* none yet */ } }
  _saveBlocked() { try { if (this.cfg.blockedFile) this.cfg.blockedFile.write(JSON.stringify([...this.blocked])); } catch (e) { console.error('could not save the block list:', e.message); } }
  blockPlayer(playerId, who) {
    if (!playerId) throw httpError(400, 'BAD_REQUEST');
    this.blocked.add(playerId); this._saveBlocked(); this._log({ e: 'player_blocked', playerId, who: who || 'operator' });
    return { ok: true, blocked: true, closed: this.closeSessions(playerId) };
  }
  unblockPlayer(playerId, who) { this.blocked.delete(playerId); this._saveBlocked(); this._log({ e: 'player_unblocked', playerId, who: who || 'operator' }); return { ok: true, blocked: false }; }

  /* ---------- daily stake / payout per player (UTC day), used for the daily loss limit ---------- */
  _day(t) { return new Date(t === undefined ? this.now() : t).toISOString().slice(0, 10); }
  _dayRec(playerId, t) {
    const day = this._day(t); let d = this.daily.get(playerId);
    if (!d || d.day !== day) { d = { day, staked: 0, paid: 0 }; this.daily.set(playerId, d); }
    return d;
  }
  _dayNet(playerId) { const d = this.daily.get(playerId); return d && d.day === this._day() ? d.staked - d.paid : 0; }

  /* ---------- history and draw proofs ---------- */
  _archiveBet(b, r) {
    let list = this.history.get(b.playerId); if (!list) { list = []; this.history.set(b.playerId, list); }
    list.push({ raceNo: b.raceNo, betId: b.id, combo: b.combo, stake: b.stake, odds: r.odds ? r.odds[b.combo] : null, status: b.status, payout: b.payout, placedAt: b.placedAt || null, currency: b.currency || null, brandId: b.brandId || null });
    if (list.length > 400) list.shift();
  }
  _archiveRound(r) {
    r.bets.forEach((b) => this._archiveBet(b, r));
    if (r.status === 'settled') {
      this.proofs.set(r.raceNo, { raceNo: r.raceNo, roundId: String(r.raceNo), commit: r.commit, seed: r.seed, odds: r.odds, rtp: r.rtp, combo: r.combo, order: r.order });
      if (this.proofs.size > 500) this.proofs.delete(this.proofs.keys().next().value);
    }
  }
  // a revealed round, so anyone can check: sha256(seed) === commit, the odds layout and the draw (see docs/WALLET_API.md)
  proof(raceNo) {
    const p = this.proofs.get(Number(raceNo)); if (!p) throw httpError(404, 'NOT_FOUND');
    return Object.assign({ ok: true, hash: 'sha256' }, p);
  }
  historyFor(playerId, limit) {
    limit = Math.max(1, Math.min(200, Number(limit) || 50));
    const byRound = new Map();
    const add = (h) => { let x = byRound.get(h.raceNo); if (!x) { const pr = this.proofs.get(h.raceNo); x = { raceNo: h.raceNo, roundId: String(h.raceNo), combo: pr ? pr.combo : null, order: pr ? pr.order : null, commit: pr ? pr.commit : null, staked: 0, paid: 0, bets: [] }; byRound.set(h.raceNo, x); } x.bets.push(h); x.staked += h.stake; x.paid += h.status === 'refunded' ? h.stake : (h.payout || 0); };
    (this.history.get(playerId) || []).forEach(add);
    if (this.cur && this.cur.status !== 'settled') this.cur.bets.filter((b) => b.playerId === playerId).forEach((b) => add({ raceNo: b.raceNo, betId: b.id, combo: b.combo, stake: b.stake, odds: this.cur.odds[b.combo], status: 'open', payout: 0, placedAt: b.placedAt || null, currency: b.currency || null, brandId: b.brandId || null }));
    const rounds = [...byRound.values()].sort((a, b) => b.raceNo - a.raceNo).slice(0, limit);
    return { ok: true, playerId: this.splitPk(playerId).playerId, clientId: this.splitPk(playerId).clientId, rounds };
  }

  // every wallet call goes through here: timing and failures feed /metrics and the alerts
  async _w(op, fn, clientId) {
    const t0 = process.hrtime.bigint();
    const done = (ok) => this.metrics.walletCall(op, Number(process.hrtime.bigint() - t0) / 1e6, ok, clientId || 'default');
    try { const r = await fn(); done(true); return r; }
    catch (e) {
      // a normal refusal (no funds, a rejected transaction) is an answer; no answer, a server error or a rejected signature is a failure
      done(e && (e.message === 'INSUFFICIENT_FUNDS' || (e.definitive && e.status !== 401 && e.status !== 403)));
      throw e;
    }
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
    if (this.closing) throw httpError(503, 'SHUTTING_DOWN');
    if (this.blocked.has(s.playerId)) throw httpError(403, 'PLAYER_BLOCKED');
    this._rate(s);
    const r = this.cur, lim = s.limits;
    if (!r || r.status !== 'betting' || this.now() >= r.betCloseAt) throw httpError(409, 'BETTING_CLOSED');
    if (!Array.isArray(list) || !list.length || list.length > rng.COMBOS.length) throw httpError(400, 'BAD_REQUEST');
    const merged = new Map();
    for (const b of list) {
      const stake = b && b.stake;
      if (!b || !rng.COMBOS.includes(b.combo) || !Number.isInteger(stake) || stake < lim.minBet || stake > lim.maxBet) throw httpError(400, 'BAD_BET');
      merged.set(b.combo, (merged.get(b.combo) || 0) + stake);
    }
    const mine = r.betsByPlayer.get(s.playerId) || { total: 0, per: {} };
    let total = 0;
    for (const [combo, stake] of merged) {
      if ((mine.per[combo] || 0) + stake > lim.maxBet) throw httpError(400, 'MAX_BET_EXCEEDED');
      total += stake;
    }
    if (mine.total + total > lim.maxRoundStake) throw httpError(400, 'MAX_ROUND_STAKE_EXCEEDED');
    const day = this._dayRec(s.playerId);
    if (lim.dailyLossLimit > 0 && day.staked - day.paid + total > lim.dailyLossLimit) throw httpError(400, 'DAILY_LOSS_LIMIT');

    // reserve the limits before waiting for the wallet so parallel requests cannot exceed them
    mine.total += total; merged.forEach((st, c) => { mine.per[c] = (mine.per[c] || 0) + st; }); r.betsByPlayer.set(s.playerId, mine); day.staked += total;
    const rollback = () => { mine.total -= total; merged.forEach((st, c) => { mine.per[c] -= st; }); day.staked -= total; };
    const batch = crypto.randomBytes(8).toString('hex'), txId = 'bet:' + r.raceNo + ':' + batch;
    const base = { raceNo: r.raceNo, roundId: String(r.raceNo), currency: s.currency, brandId: s.brandId };
    const betIds = [...merged.keys()].map((c) => batch + ':' + c);
    let res;
    try { res = await this._debit(s.playerId, total, txId, Object.assign({ kind: 'bet', betId: batch, betIds }, base)); }
    catch (e) { rollback(); throw e; }
    if (this.cur !== r || r.status !== 'betting' || this.now() >= r.betCloseAt) { // betting closed while the wallet was busy
      rollback(); this._queueCredit('refund:' + txId, s.playerId, total, r.raceNo, 'refund', Object.assign({ betId: batch, betIds, refTxId: txId }, base));
      throw httpError(409, 'BETTING_CLOSED');
    }
    s.balance = res.balance; s.sStaked += total; this.sessionsDirty = true;
    const placed = [];
    merged.forEach((stake, combo) => {
      const bet = { id: batch + ':' + combo, raceNo: r.raceNo, playerId: s.playerId, combo, stake, status: 'open', payout: 0, currency: s.currency, brandId: s.brandId, placedAt: this.now() };
      r.bets.push(bet); placed.push(bet);
      this._log({ e: 'bet', raceNo: r.raceNo, id: bet.id, playerId: s.playerId, combo, stake, txId, currency: s.currency, brandId: s.brandId });
    });
    const cs = this.stats.byCurrency[s.currency] || (this.stats.byCurrency[s.currency] = { staked: 0, paid: 0 }); cs.staked += total;
    return { bets: placed.map((b) => ({ id: b.id, raceNo: b.raceNo, combo: b.combo, stake: b.stake, status: b.status, payout: b.payout, odds: r.odds[b.combo] })), balance: s.balance };
  }
  async _debit(playerId, amount, txId, meta) {
    const who = this.splitPk(playerId), wallet = this._walletFor(who.clientId);
    if (!wallet) throw httpError(502, 'WALLET_UNAVAILABLE');
    for (let attempt = 0; attempt < 2; attempt++) {
      try { return await this._w('debit', () => wallet.debit(who.playerId, amount, txId, meta), who.clientId); }
      catch (e) {
        if (e.message === 'INSUFFICIENT_FUNDS') throw httpError(402, 'INSUFFICIENT_FUNDS');
        if (e.definitive) throw httpError(502, 'WALLET_REJECTED');
        if (attempt === 1) { this._log({ e: 'debit_unknown', playerId, amount, txId }); this._queueRollback(txId, playerId, amount, meta); throw httpError(502, 'WALLET_UNAVAILABLE'); }
        await new Promise((ok) => setTimeout(ok, 250));    // same txId again: the wallet is idempotent
      }
    }
  }

  _queueCredit(txId, playerId, amount, raceNo, kind, extra) {
    if (!(amount > 0) || this.pending.has(txId)) return;
    extra = extra || {};
    this._log({ e: 'credit_due', txId, playerId, amount, raceNo, kind, extra });
    this.pending.set(txId, { txId, playerId, amount, raceNo, kind, extra, since: this.now(), tries: 0, nextAt: 0 });
  }
  // a debit that timed out twice may or may not have been applied: ask the wallet to cancel it (and to refuse it if it arrives late)
  _queueRollback(txId, playerId, amount, meta) {
    if (this.pendingRb.has(txId)) return;
    meta = meta || {}; const raceNo = meta.raceNo, extra = { currency: meta.currency, brandId: meta.brandId, betId: meta.betId, betIds: meta.betIds };
    this._log({ e: 'rollback_due', txId, playerId, amount, raceNo, extra });
    this.pendingRb.set(txId, { txId, playerId, amount, raceNo, extra, since: this.now(), tries: 0, nextAt: 0 });
  }
  async _flushRollbacks() {
    const t = this.now();
    for (const p of [...this.pendingRb.values()]) {
      if (p.nextAt > t) continue;
      const w0 = this._walletFor(this.splitPk(p.playerId).clientId);
      if (w0 && typeof w0.rollback !== 'function') { this.pendingRb.delete(p.txId); this._log({ e: 'rollback_unsupported', txId: p.txId }); continue; }
      try {
        const who = this.splitPk(p.playerId), wallet = this._walletFor(who.clientId);
        if (!wallet) throw Object.assign(new Error('no wallet for client'), { unsupported: false });
        const res = await this._w('rollback', () => wallet.rollback(who.playerId, p.amount, p.txId, Object.assign({ raceNo: p.raceNo, roundId: String(p.raceNo), kind: 'rollback', refTxId: p.txId }, p.extra)), who.clientId);
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
        const who = this.splitPk(p.playerId), wallet = this._walletFor(who.clientId);
        if (!wallet) throw new Error('no wallet for client ' + who.clientId);
        const res = await this._w('credit', () => wallet.credit(who.playerId, p.amount, p.txId, Object.assign({ raceNo: p.raceNo, roundId: String(p.raceNo), kind: p.kind }, p.extra)), who.clientId);
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
      if (b.combo === r.combo) {
        b.status = 'won'; b.payout = this.payoutFor(b.stake, b.combo, r.odds); paid += b.payout;
        const w = payouts.get(b.playerId) || { amount: 0, stake: 0, betIds: [], currency: b.currency, brandId: b.brandId, odds: r.odds[b.combo] };
        w.amount += b.payout; w.stake += b.stake; w.betIds.push(b.id); payouts.set(b.playerId, w);
      } else { b.status = 'lost'; b.payout = 0; }
      this._track(b, r); this._statClient(b);
      const cur = b.currency || this.cfg.currency, cs = this.stats.byCurrency[cur] || (this.stats.byCurrency[cur] = { staked: 0, paid: 0 });
      cs.paid += b.payout;
    });
    r.status = 'settled'; r.staked = staked; r.paid = paid;
    this._log({ e: 'settled', raceNo: r.raceNo, combo: r.combo, staked, paid, payouts: [...payouts].map(([playerId, w]) => ({ playerId, amount: w.amount })) });
    for (const [playerId, w] of payouts) {
      this._queueCredit('win:' + r.raceNo + ':' + playerId, playerId, w.amount, r.raceNo, 'win', { betIds: w.betIds, currency: w.currency, brandId: w.brandId });
      this._dayRec(playerId).paid += w.amount;
      for (const s of this.sessions.values()) if (s.playerId === playerId) { s.sPaid += w.amount; this.sessionsDirty = true; }
    }
    this.stats.rounds++; this.stats.bets += r.bets.length; this.stats.staked += staked; this.stats.paid += paid; this.stats.wins[r.combo]++;
    const wo = r.odds[r.combo]; this.stats.winsByOdds[wo] = (this.stats.winsByOdds[wo] || 0) + 1;
    this.recent.push({ raceNo: r.raceNo, combo: r.combo, order: r.order, staked, paid, bets: r.bets.length, odds: wo });
    if (this.recent.length > 100) this.recent.shift();
    this.reveals.push({ raceNo: r.raceNo, seed: r.seed, commit: r.commit, combo: r.combo, order: r.order, odds: r.odds, rtp: r.rtp });
    if (this.reveals.length > 20) this.reveals.shift();
    this._archiveRound(r);
    const per = new Map();                         // every client with a webhook gets the result; the money figures are its own players'
    r.bets.forEach((b) => { const c = this.splitPk(b.playerId).clientId, x = per.get(c) || { bets: 0, staked: 0, paid: 0 }; x.bets++; x.staked += b.stake; x.paid += b.payout; per.set(c, x); });
    this._clientRounds(r, this.now());
    const cids = new Set(['default']); if (this.clients) this.clients.list().forEach((c) => cids.add(c.id));
    for (const cid of cids) {
      const x = per.get(cid) || { bets: 0, staked: 0, paid: 0 };
      this._emit('round.settled', 'round:' + r.raceNo, { roundId: String(r.raceNo), raceNo: r.raceNo, combo: r.combo, order: r.order, odds: r.odds, oddsOfWinner: wo, rtp: r.rtp, commit: r.commit, seed: r.seed, bets: x.bets, staked: x.staked, paid: x.paid, ledgerHash: this.ledger.head, ledgerLines: this.ledger.lines }, cid);
    }
    for (const [playerId, w] of payouts) {
      const who = this.splitPk(playerId), cc = this._clientCfg(who.clientId);
      if (w.amount >= (cc.bigWinMin || this.cfg.bigWinMin)) this._emit('big.win', 'win:' + r.raceNo + ':' + who.playerId, { roundId: String(r.raceNo), raceNo: r.raceNo, playerId: who.playerId, brandId: w.brandId, currency: w.currency, stake: w.stake, payout: w.amount, odds: w.odds, betIds: w.betIds }, who.clientId);
    }
    await this._flushCredits();
  }

  /* ---------- webhooks to the platform (at least once; the platform de-duplicates on `id`) ---------- */
  _emit(type, key, data, clientId) {
    clientId = clientId || 'default';
    const wh = this._clientActive(clientId) ? this._webhookFor(clientId) : null;
    if (!wh || !wh.wants(type)) return;
    const ev = { id: this.cfg.gameId + ':' + (clientId === 'default' ? '' : clientId + ':') + key, type, createdAt: this.now(), gameId: this.cfg.gameId, clientId, data };
    this._log({ e: 'webhook_due', ev });
    this.pendingWh.set(ev.id, { ev, since: this.now(), tries: 0, nextAt: 0 });
  }
  async _flushWebhooks() {
    const t = this.now();
    for (const [id, p] of [...this.pendingWh]) {
      if (p.nextAt > t) continue;
      const cid = p.ev.clientId || 'default', wh = this._clientActive(cid) ? this._webhookFor(cid) : null;
      if (!wh) { this.pendingWh.delete(id); this._log({ e: 'webhook_dropped', id, reason: 'client has no webhook any more' }); continue; }
      try { await wh.send(p.ev); this.pendingWh.delete(id); this._log({ e: 'webhook_ok', id }); }
      catch (e) { p.tries++; p.nextAt = t + Math.min(60000, 1000 * Math.pow(2, Math.min(p.tries, 6))); }
    }
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
      await this._flushCredits(); await this._flushRollbacks(); await this._flushWebhooks();
      this.metrics.tickDone();
      for (const [k, s] of this.sessions) if (s.expires < t) { this.sessions.delete(k); this.sessionsDirty = true; }
      this._saveSessions();
    } finally { this.busy = false; }
  }

  /* ---------- operations: expected-vs-actual payouts, snapshot for /metrics and the alerts, health, shutdown ---------- */
  // each bet is a lottery ticket: it pays stake x odds with probability p. Summing the expectation and variance over all bets tells
  // whether the payouts are in line with what the odds predict for the bets that were actually placed.
  _track(b, r) {
    const p = r.table && r.table.prob ? r.table.prob[b.combo] : null, T = this.rtpTrack;
    T.staked += b.stake; T.paid += b.payout; if (p == null) return;
    const w = b.stake * (r.odds[b.combo]); T.exp += w * p; T.varsum += w * w * p * (1 - p);
  }
  _statClient(b) {
    const c = this.splitPk(b.playerId).clientId, s = this.stats.byClient[c] || (this.stats.byClient[c] = { bets: 0, staked: 0, paid: 0, byCurrency: {} });
    s.bets++; s.staked += b.stake; s.paid += b.payout;
    const cur = b.currency || this.cfg.currency, x = s.byCurrency[cur] || (s.byCurrency[cur] = { staked: 0, paid: 0 }); x.staked += b.stake; x.paid += b.payout;
  }
  // one line per client for a settled race: its own bets, players, staked and paid (for the back office)
  _clientRounds(r, at) {
    const per = new Map();
    r.bets.forEach((b) => {
      const c = this.splitPk(b.playerId).clientId, x = per.get(c) || { players: new Set(), bets: 0, staked: 0, paid: 0 };
      x.players.add(b.playerId); x.bets++; x.staked += b.stake; x.paid += b.payout; per.set(c, x);
    });
    for (const [c, x] of per) {
      const list = this.clientRecent.get(c) || []; this.clientRecent.set(c, list);
      list.push({ raceNo: r.raceNo, combo: r.combo, odds: r.odds ? r.odds[r.combo] : null, order: r.order, at: at || this.now(), players: x.players.size, bets: x.bets, staked: x.staked, paid: x.paid });
      if (list.length > 300) list.shift();
    }
  }
  // players of a client that the game knows from its history, open bets, sessions and block list
  players(clientId, opts) {
    opts = opts || {}; const q = String(opts.query || '').toLowerCase(), by = new Map();
    const get = (pk) => { let p = by.get(pk); if (!p) { p = { playerId: this.splitPk(pk).playerId, bets: 0, staked: 0, paid: 0, lastBetAt: null, online: false, blocked: this.blocked.has(pk) }; by.set(pk, p); } return p; };
    const mine = (pk) => { const s = this.splitPk(pk); return s.clientId === clientId && (!q || s.playerId.toLowerCase().includes(q)); };
    for (const [pk, list] of this.history) if (mine(pk)) for (const h of list) {
      const p = get(pk); if (h.status === 'refunded') continue;
      p.bets++; p.staked += h.stake; p.paid += h.payout || 0; if (!p.lastBetAt || (h.placedAt || 0) > p.lastBetAt) p.lastBetAt = h.placedAt || p.lastBetAt;
    }
    if (this.cur && this.cur.status !== 'settled') this.cur.bets.forEach((b) => { if (mine(b.playerId)) { const p = get(b.playerId); p.bets++; p.staked += b.stake; p.lastBetAt = Math.max(p.lastBetAt || 0, b.placedAt || 0); } });
    for (const s of this.sessions.values()) if (s.clientId === clientId && mine(s.playerId)) get(s.playerId).online = true;
    for (const pk of this.blocked) if (mine(pk)) get(pk);
    const all = [...by.values()].sort((a, b) => (b.lastBetAt || 0) - (a.lastBetAt || 0));
    return { ok: true, total: all.length, players: all.slice(0, Math.max(1, Math.min(500, Number(opts.limit) || 100))) };
  }
  playerDetail(clientId, playerId) {
    const pk = this.playerKey(clientId, playerId), h = this.historyFor(pk, 100), sessions = [];
    for (const s of this.sessions.values()) if (s.playerId === pk) sessions.push({ since: s.created, currency: s.currency, balance: s.balance, limits: s.limits, staked: s.sStaked, paid: s.sPaid });
    const totals = { bets: 0, staked: 0, paid: 0 }; h.rounds.forEach((r) => r.bets.forEach((b) => { if (b.status !== 'refunded') { totals.bets++; totals.staked += b.stake; totals.paid += b.payout || 0; } }));
    return { ok: true, playerId, clientId, blocked: this.blocked.has(pk), sessions, dailyNetLoss: Math.max(0, this._dayNet(pk)), totals, rounds: h.rounds };
  }
  rounds(clientId, limit) { return { ok: true, rounds: (this.clientRecent.get(clientId) || []).slice(-Math.max(1, Math.min(300, Number(limit) || 50))).reverse() }; }
  // back-office actions are kept in the ledger and in a short list per client
  audit(clientId, entry) {
    const e = Object.assign({ at: this.now() }, entry), list = this.boAudit.get(clientId) || []; this.boAudit.set(clientId, list);
    list.push(e); if (list.length > 500) list.shift();
    this._log(Object.assign({ e: 'bo_action', clientId }, entry));
  }
  auditFor(clientId, limit) { return { ok: true, entries: (this.boAudit.get(clientId) || []).slice(-Math.max(1, Math.min(500, Number(limit) || 100))).reverse() }; }
  rtpZ() { const T = this.rtpTrack; return T.varsum > 0 ? (T.paid - T.exp) / Math.sqrt(T.varsum) : 0; }

  // numbers for one client (its own back office / client API)
  clientReport(clientId) {
    const st = this.stats.byClient[clientId] || { bets: 0, staked: 0, paid: 0 }, mine = (pk) => this.splitPk(pk).clientId === clientId;
    let sessions = 0; for (const s of this.sessions.values()) if (s.clientId === clientId) sessions++;
    const count = (m) => { let n = 0; for (const p of m.values()) if (mine(p.playerId)) n++; return n; };
    let blocked = 0; for (const b of this.blocked) if (mine(b)) blocked++;
    return { ok: true, clientId, bets: st.bets, staked: st.staked, paid: st.paid, ggr: st.staked - st.paid, byCurrency: st.byCurrency || {}, rtp: st.staked ? st.paid / st.staked : null, activeSessions: sessions,
      pendingCredits: count(this.pending), pendingRollbacks: count(this.pendingRb), blockedPlayers: blocked, currentRound: this.cur ? this.cur.raceNo : null, rtpSetting: this.rtp };
  }
  opsSnapshot() {
    const t = this.now(), age = (m, f) => { let o = 0; for (const p of m.values()) o = Math.max(o, (t - (p.since || t)) / 1000); return o; };
    const s = this.stats;
    return {
      round: this.cur ? this.cur.raceNo : 0, rounds: s.rounds, bets: s.bets, byCurrency: s.byCurrency, byClient: s.byClient, rtpSetting: this.rtp, rtpActual: s.staked ? s.paid / s.staked : 0, rtpZ: this.rtpZ(),
      sessions: this.sessions.size, closing: this.closing,
      pending: { credits: { count: this.pending.size, oldestSeconds: age(this.pending) }, rollbacks: { count: this.pendingRb.size, oldestSeconds: age(this.pendingRb) }, webhooks: { count: this.pendingWh.size, oldestSeconds: age(this.pendingWh) } },
      ledger: { ok: this.ledger.ok, lines: this.ledger.lines, head: this.ledger.head, broken: this.ledger.check.broken }
    };
  }
  health() {
    const reasons = [];
    if (!this.ledger.ok) reasons.push('ledger hash chain is broken at line ' + this.ledger.check.broken.line);
    if (this.metrics.tickAge() > 5) reasons.push('the round loop has not run for ' + Math.round(this.metrics.tickAge()) + ' s');
    if (this.closing) reasons.push('shutting down');
    return { ok: reasons.length === 0, reasons };
  }
  // stop taking bets, give the wallet queues a last chance to deliver, store the sessions (SIGTERM during a deploy)
  async shutdown(maxMs) {
    this.closing = true;
    const end = Date.now() + (maxMs || 5000);
    while (Date.now() < end && (this.pending.size || this.pendingRb.size || this.pendingWh.size)) {
      for (const m of [this.pending, this.pendingRb, this.pendingWh]) for (const p of m.values()) p.nextAt = 0;
      await this._flushCredits(); await this._flushRollbacks(); await this._flushWebhooks();
      if (this.pending.size || this.pendingRb.size || this.pendingWh.size) await new Promise((ok) => setTimeout(ok, 200));
    }
    this._saveSessions(true);
    this._log({ e: 'shutdown', pendingCredits: this.pending.size, pendingRollbacks: this.pendingRb.size, pendingWebhooks: this.pendingWh.size });
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
      try { s.balance = await this._w('balance', () => this._walletFor(s.clientId).balance(s.rawId), s.clientId); } catch (e) { /* keep the cached balance */ }
    }
    const mine = (r) => r.bets.filter((b) => b.playerId === s.playerId).map((b) => ({ combo: b.combo, stake: b.stake, odds: r.odds[b.combo], status: b.status, payout: b.payout }));
    const out = Object.assign({ playerId: s.rawId, returnUrl: s.returnUrl, raceNo: null, bets: [], last: null }, this._sessionView(s));
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
      houseWin: paidIn - s.paid, wins: s.wins, pendingCredits: this.pending.size, pendingRollbacks: this.pendingRb.size, pendingWebhooks: this.pendingWh.size, blockedPlayers: this.blocked.size, byCurrency: s.byCurrency, byClient: s.byClient, activeSessions: this.sessions.size, currency: this.cfg.currency,
      recent: this.recent.slice(-50).reverse(), commit: this.cur ? this.cur.commit : null, currentRound: this.cur ? this.cur.raceNo : null
    };
  }
}

module.exports = { Engine, httpError };
