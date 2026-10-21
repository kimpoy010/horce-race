'use strict';
/*
 * Operational metrics: wallet call timings and failures, plus a Prometheus text rendering of the engine state (GET /metrics).
 */
const BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];      // seconds

class Metrics {
  constructor(now) {
    this.now = now || Date.now;
    this.started = this.now();
    this.calls = {};            // op -> { ok, fail, sum, count, buckets[] }
    this.recent = [];           // last wallet calls: { t, op, ok, ms }
    this.lastTick = this.now(); this.tickErrors = 0;
  }
  walletCall(op, ms, ok) {
    const c = this.calls[op] || (this.calls[op] = { ok: 0, fail: 0, sum: 0, count: 0, buckets: BUCKETS.map(() => 0) });
    c[ok ? 'ok' : 'fail']++; c.sum += ms / 1000; c.count++;
    BUCKETS.forEach((b, i) => { if (ms / 1000 <= b) c.buckets[i]++; });
    this.recent.push({ t: this.now(), op, ok, ms });
    if (this.recent.length > 3000) this.recent.shift();
  }
  // calls in the last windowMs: { calls, failures, failRate, p95 (ms) }
  walletWindow(windowMs) {
    const since = this.now() - windowMs, r = this.recent.filter((x) => x.t >= since);
    const ms = r.map((x) => x.ms).sort((a, b) => a - b), fails = r.filter((x) => !x.ok).length;
    return { calls: r.length, failures: fails, failRate: r.length ? fails / r.length : 0, p95: ms.length ? ms[Math.min(ms.length - 1, Math.floor(ms.length * 0.95))] : 0 };
  }
  tickDone() { this.lastTick = this.now(); }
  tickAge() { return (this.now() - this.lastTick) / 1000; }
}

const esc = (v) => String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
function line(name, value, labels) {
  const l = labels ? '{' + Object.keys(labels).map((k) => k + '="' + esc(labels[k]) + '"').join(',') + '}' : '';
  return name + l + ' ' + (Number.isFinite(value) ? value : 0);
}

// engine = the live Engine, extra = { role, alerts: [ {name, severity} ] }
function render(engine, extra) {
  extra = extra || {};
  const out = [], help = (n, t, ty) => { out.push('# HELP ' + n + ' ' + t); out.push('# TYPE ' + n + ' ' + (ty || 'gauge')); };
  const m = engine.metrics, rep = engine.opsSnapshot();
  help('horse_up', 'the game process is running'); out.push(line('horse_up', 1));
  help('horse_role', 'active = running the game, standby = waiting to take over'); out.push(line('horse_role', 1, { role: extra.role || 'active' }));
  help('process_uptime_seconds', 'seconds since the process started'); out.push(line('process_uptime_seconds', process.uptime()));
  help('process_resident_memory_bytes', 'resident memory'); out.push(line('process_resident_memory_bytes', process.memoryUsage().rss));
  help('horse_tick_age_seconds', 'seconds since the round loop last completed (should stay under 1)'); out.push(line('horse_tick_age_seconds', m.tickAge()));
  help('horse_round_number', 'current race number'); out.push(line('horse_round_number', rep.round));
  help('horse_rounds_total', 'settled races', 'counter'); out.push(line('horse_rounds_total', rep.rounds));
  help('horse_bets_total', 'bets placed in settled races', 'counter'); out.push(line('horse_bets_total', rep.bets));
  help('horse_staked_total', 'amount staked (minor units) in settled races', 'counter');
  help('horse_paid_total', 'amount paid out (minor units) in settled races', 'counter');
  Object.keys(rep.byCurrency).forEach((c) => { out.push(line('horse_staked_total', rep.byCurrency[c].staked, { currency: c })); out.push(line('horse_paid_total', rep.byCurrency[c].paid, { currency: c })); });
  help('horse_rtp_setting', 'RTP setting'); out.push(line('horse_rtp_setting', rep.rtpSetting));
  help('horse_rtp_actual', 'paid / staked since start'); out.push(line('horse_rtp_actual', rep.rtpActual));
  help('horse_rtp_zscore', 'how many standard deviations the payouts are from what the odds predict for the bets placed'); out.push(line('horse_rtp_zscore', rep.rtpZ));
  help('horse_sessions_active', 'player sessions'); out.push(line('horse_sessions_active', rep.sessions));
  help('horse_pending_credits', 'wins and refunds not yet confirmed by the wallet'); out.push(line('horse_pending_credits', rep.pending.credits.count));
  help('horse_pending_rollbacks', 'rollbacks not yet confirmed by the wallet'); out.push(line('horse_pending_rollbacks', rep.pending.rollbacks.count));
  help('horse_pending_webhooks', 'webhook events not yet accepted by the platform'); out.push(line('horse_pending_webhooks', rep.pending.webhooks.count));
  help('horse_pending_oldest_seconds', 'age of the oldest unconfirmed item');
  ['credits', 'rollbacks', 'webhooks'].forEach((k) => out.push(line('horse_pending_oldest_seconds', rep.pending[k].oldestSeconds, { queue: k })));
  help('horse_ledger_ok', '1 when the ledger hash chain is intact'); out.push(line('horse_ledger_ok', rep.ledger.ok ? 1 : 0));
  help('horse_ledger_lines', 'ledger lines'); out.push(line('horse_ledger_lines', rep.ledger.lines));
  help('horse_wallet_calls_total', 'wallet calls by result', 'counter');
  Object.keys(m.calls).forEach((op) => { out.push(line('horse_wallet_calls_total', m.calls[op].ok, { op, result: 'ok' })); out.push(line('horse_wallet_calls_total', m.calls[op].fail, { op, result: 'error' })); });
  help('horse_wallet_latency_seconds', 'wallet call duration', 'histogram');
  Object.keys(m.calls).forEach((op) => {
    const c = m.calls[op];
    BUCKETS.forEach((b, i) => out.push(line('horse_wallet_latency_seconds_bucket', c.buckets[i], { op, le: b })));
    out.push(line('horse_wallet_latency_seconds_bucket', c.count, { op, le: '+Inf' })); out.push(line('horse_wallet_latency_seconds_sum', c.sum, { op })); out.push(line('horse_wallet_latency_seconds_count', c.count, { op }));
  });
  help('horse_alert_firing', '1 for every active alert'); (extra.alerts || []).forEach((a) => out.push(line('horse_alert_firing', 1, { name: a.name, severity: a.severity })));
  return out.join('\n') + '\n';
}

module.exports = { Metrics, render, BUCKETS };
