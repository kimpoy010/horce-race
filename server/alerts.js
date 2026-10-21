'use strict';
/*
 * Alerts: rules over the engine snapshot, evaluated every few seconds. An alert fires when its condition starts, is repeated while it
 * lasts, and resolves when it ends. Every change is printed to the log and, with ALERT_WEBHOOK_URL, posted as JSON
 * ({ text, status, name, severity, message, since, at, id }; `text` makes it work with Slack / Teams / Discord style incoming webhooks).
 */
const fs = require('fs');

const DEFAULTS = {
  creditMinutes: 5,            // a win or refund still undelivered after this long
  rollbackMinutes: 2,          // a rollback still undelivered after this long
  webhookMinutes: 10,          // a webhook event still undelivered after this long
  walletFailRate: 0.2,         // share of wallet calls failing in the last 5 minutes (with at least 5 calls)
  walletP95Ms: 3000,           // slow wallet
  tickStallSeconds: 5,         // the round loop has not run
  rtpZ: 4,                     // payouts this many standard deviations from what the odds predict (after enough rounds)
  rtpMinRounds: 300,
  diskFreeMb: 500,             // free space where the ledger is kept
  repeatMinutes: 30            // reminder while an alert stays active
};

function rules(cfg, ctx) {
  const snap = ctx.snapshot, win = ctx.wallet, list = [];
  const add = (name, severity, bad, message) => { if (bad) list.push({ name, severity, message }); };
  add('ledger_broken', 'critical', !snap.ledger.ok, 'the audit ledger hash chain is broken' + (snap.ledger.broken ? ' at line ' + snap.ledger.broken.line + ': ' + snap.ledger.broken.reason : ''));
  add('round_loop_stalled', 'critical', ctx.tickAge > cfg.tickStallSeconds, 'the round loop has not run for ' + Math.round(ctx.tickAge) + ' s');
  add('credits_stuck', 'critical', snap.pending.credits.count > 0 && snap.pending.credits.oldestSeconds > cfg.creditMinutes * 60,
    snap.pending.credits.count + ' win/refund credit(s) not delivered to the wallet, the oldest for ' + Math.round(snap.pending.credits.oldestSeconds / 60) + ' min');
  add('rollbacks_stuck', 'critical', snap.pending.rollbacks.count > 0 && snap.pending.rollbacks.oldestSeconds > cfg.rollbackMinutes * 60,
    snap.pending.rollbacks.count + ' rollback(s) not confirmed by the wallet, the oldest for ' + Math.round(snap.pending.rollbacks.oldestSeconds / 60) + ' min (a player may be charged for a bet that was not placed)');
  add('webhooks_stuck', 'warning', snap.pending.webhooks.count > 0 && snap.pending.webhooks.oldestSeconds > cfg.webhookMinutes * 60,
    snap.pending.webhooks.count + ' webhook event(s) not accepted by the platform, the oldest for ' + Math.round(snap.pending.webhooks.oldestSeconds / 60) + ' min');
  add('wallet_failing', 'critical', win.calls >= 5 && win.failRate > cfg.walletFailRate, 'wallet calls failing: ' + Math.round(win.failRate * 100) + '% of ' + win.calls + ' in the last 5 minutes');
  add('wallet_slow', 'warning', win.calls >= 5 && win.p95 > cfg.walletP95Ms, 'wallet is slow: the slowest 5% of calls took over ' + Math.round(win.p95) + ' ms in the last 5 minutes');
  add('rtp_drift', 'warning', snap.rounds >= cfg.rtpMinRounds && Math.abs(snap.rtpZ) > cfg.rtpZ,
    'payouts are ' + snap.rtpZ.toFixed(1) + ' standard deviations ' + (snap.rtpZ > 0 ? 'above' : 'below') + ' what the odds predict for the bets placed (' + snap.rounds + ' races)');
  if (ctx.diskFreeMb != null) add('disk_low', 'critical', ctx.diskFreeMb < cfg.diskFreeMb, 'only ' + Math.round(ctx.diskFreeMb) + ' MB free where the ledger is kept');
  return list;
}

class AlertManager {
  constructor(opts) {
    opts = opts || {};
    this.cfg = Object.assign({}, DEFAULTS, opts.config || {});
    this.now = opts.now || Date.now; this.notify = opts.notify || (() => {}); this.log = opts.log || console.log;
    this.active = new Map();           // name -> { name, severity, message, since, lastNotified }
    this.history = [];                 // recent changes, newest last
  }
  // ctx: { snapshot, wallet, tickAge, diskFreeMb }
  evaluate(ctx) {
    const t = this.now(), current = rules(this.cfg, ctx), names = new Set(current.map((a) => a.name));
    for (const a of current) {
      const prev = this.active.get(a.name);
      if (!prev) { this.active.set(a.name, { name: a.name, severity: a.severity, message: a.message, since: t, lastNotified: t }); this._send('firing', this.active.get(a.name)); }
      else {
        prev.message = a.message;
        if (t - prev.lastNotified >= this.cfg.repeatMinutes * 60000) { prev.lastNotified = t; this._send('firing', prev, true); }
      }
    }
    for (const [name, a] of [...this.active]) if (!names.has(name)) { this.active.delete(name); this._send('resolved', a); }
    return this.list();
  }
  list() { return [...this.active.values()].map((a) => ({ name: a.name, severity: a.severity, message: a.message, since: a.since })); }
  _send(status, a, reminder) {
    const at = this.now(), text = (status === 'firing' ? (a.severity === 'critical' ? '[CRITICAL] ' : '[WARNING] ') : '[RESOLVED] ') + 'Horse Race: ' + a.name + (reminder ? ' (still active)' : '') + ' - ' + a.message;
    const ev = { id: a.name + ':' + a.since, status, name: a.name, severity: a.severity, message: a.message, since: a.since, at, reminder: !!reminder, text };
    this.history.push(ev); if (this.history.length > 100) this.history.shift();
    this.log('ALERT ' + text);
    try { Promise.resolve(this.notify(ev)).catch(() => {}); } catch (e) { /* ignore */ }
  }
}

function webhookNotifier(url, timeoutMs) {
  return async function (ev) {
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), timeoutMs || 5000);
    try { await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(ev), signal: ctl.signal }); }
    finally { clearTimeout(timer); }
  };
}

// free space in MB of the disk holding dir (Node 18.15+), or null when it cannot be read
function diskFreeMb(dir) {
  try { const s = fs.statfsSync(dir); return s.bavail * s.bsize / 1048576; } catch (e) { return null; }
}

module.exports = { AlertManager, webhookNotifier, diskFreeMb, DEFAULTS, rules };
