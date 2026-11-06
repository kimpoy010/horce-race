#!/usr/bin/env node
/*
 * Load test for Bingo Pinball (Phase 6). Many virtual players play through the real HTTP API of a STAGING server, one play after another with the pause the server
 * demands (at least minIntervalMs per player, 3 s by default: 300 players make about 100 plays a second). It measures latency and errors, checks that repeating a
 * request id never makes a second play, and prints totals to compare with `php artisan games:reconcile` and the consoles afterwards.
 *
 *   node bin/bingo-loadtest.cjs --base http://127.0.0.1:8000 --client demo --players 100 --duration 120
 *   node bin/bingo-loadtest.cjs --base https://staging.example --client acme --tokens launch-tokens.txt --yes-this-is-not-production
 *
 * Players come from play-money tokens `demo-<name>` (the mock wallet), or from --tokens: a file with one launch token per line (the client's test wallet).
 * It refuses any host that is not local unless you add --yes-this-is-not-production. NEVER point it at production: every play moves (test) money and fills the ledger.
 */
'use strict';

function arg(argv, name, def) { const i = argv.indexOf('--' + name); return i >= 0 && i + 1 < argv.length && !argv[i + 1].startsWith('--') ? argv[i + 1] : def; }
function flag(argv, name) { return argv.includes('--' + name); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function pct(sorted, p) { return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : 0; }
function isLocal(host) { return /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?$)/.test(host) || host.endsWith('.local') || host.endsWith('.test'); }

async function call(base, method, path, session, body, timeoutMs) {
  const t0 = performance.now(), ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), timeoutMs || 20000);
  try {
    const r = await fetch(base + path, { method, signal: ctl.signal, headers: Object.assign({ 'Content-Type': 'application/json' }, session ? { Authorization: 'Bearer ' + session } : {}), body: body === undefined ? undefined : JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    return { status: r.status, body: j, ms: performance.now() - t0 };
  } catch (e) { return { status: 0, body: { error: e.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK' }, ms: performance.now() - t0 }; } finally { clearTimeout(timer); }
}

/** @returns {Promise<object>} the summary; opts: base, client, players, durationS, stake, tokens (array or null), repeatRate, rampS, log */
async function run(opts) {
  const base = opts.base.replace(/\/$/, ''), api = base + '/api/games/bingo-pinball';
  const S = { plays: 0, errors: {}, status5xx: 0, latency: [], authLatency: [], staked: 0, paid: 0, wins: 0, repeats: 0, repeatViolations: 0, authFailed: 0, players: 0, timeouts: 0 };
  const end = Date.now() + opts.durationS * 1000, t0 = Date.now();
  const err = (code, status) => { S.errors[code] = (S.errors[code] || 0) + 1; if (status >= 500 || status === 0) S.status5xx++; if (code === 'TIMEOUT') S.timeouts++; };

  async function player(i) {
    const token = opts.tokens ? opts.tokens[i % opts.tokens.length] : 'demo-load' + i;
    await sleep((opts.rampS * 1000 * i) / opts.players);
    const a = await call(api, 'POST', '/auth', null, { token, client: opts.client });
    S.authLatency.push(a.ms);
    if (!a.body.ok) { S.authFailed++; err('AUTH_' + (a.body.error || a.status), a.status); return; }
    S.players++;
    const session = a.body.session, minGap = Math.max(a.body.minIntervalMs || 3000, 0);
    let n = 0, balance = a.body.balance;
    while (Date.now() < end) {
      const stake = opts.stake || a.body.limits.minBet, rid = 'lt' + i + '-' + Date.now().toString(36) + '-' + (n++);
      const r = await call(api, 'POST', '/play', session, { stake, requestId: rid }, 30000);
      if (r.body.ok) {
        S.plays++; S.latency.push(r.ms); S.staked += r.body.round.stake; S.paid += r.body.round.payout; if (r.body.round.payout > 0) S.wins++;
        if (balance != null && r.body.balance != null && opts.checkBalance !== false) balance = r.body.balance;
        if (Math.random() < opts.repeatRate) {                                   // the same request again: the same play, never a second debit
          S.repeats++;
          const again = await call(api, 'POST', '/play', session, { stake, requestId: rid }, 30000);
          if (!(again.body.ok && again.body.repeat === true && again.body.round.id === r.body.round.id)) { S.repeatViolations++; err('REPEAT_NOT_IDEMPOTENT', again.status); }
        }
      } else if (r.body.error === 'TOO_FAST' || r.body.error === 'TOO_MANY_REQUESTS') { err(r.body.error, r.status); await sleep(500); continue; }
      else {
        err(r.body.error || 'HTTP_' + r.status, r.status);
        if (r.body.error === 'INSUFFICIENT_FUNDS' || r.body.error === 'DAILY_LOSS_LIMIT' || r.body.error === 'SESSION_EXPIRED') return;
      }
      await sleep(minGap + 200 + Math.random() * 800);
    }
  }
  const ps = []; for (let i = 0; i < opts.players; i++) ps.push(player(i));
  await Promise.all(ps);
  const lat = S.latency.slice().sort((x, y) => x - y), secs = (Date.now() - t0) / 1000;
  return { players: S.players, authFailed: S.authFailed, plays: S.plays, playsPerSecond: +(S.plays / secs).toFixed(2), seconds: +secs.toFixed(1), staked: S.staked, paid: S.paid, wins: S.wins, returnToPlayer: S.staked ? +(S.paid / S.staked).toFixed(4) : null,
    latencyMs: { p50: Math.round(pct(lat, 0.5)), p95: Math.round(pct(lat, 0.95)), p99: Math.round(pct(lat, 0.99)), max: Math.round(lat[lat.length - 1] || 0) }, authMs: { p95: Math.round(pct(S.authLatency.slice().sort((x, y) => x - y), 0.95)) },
    repeats: S.repeats, repeatViolations: S.repeatViolations, serverErrors: S.status5xx, timeouts: S.timeouts, errors: S.errors };
}

async function main() {
  const argv = process.argv.slice(2);
  if (flag(argv, 'help') || !arg(argv, 'base')) { console.log(require('fs').readFileSync(__filename, 'utf8').split('*/')[0].replace(/^#!.*\n/, '')); process.exit(arg(argv, 'base') ? 0 : 2); }
  const base = arg(argv, 'base'), host = new URL(base).hostname;
  if (!isLocal(host) && !flag(argv, 'yes-this-is-not-production')) { console.error('Refusing to run against ' + host + ': it is not a local address. If this really is a staging server, add --yes-this-is-not-production.'); process.exit(2); }
  const tokensFile = arg(argv, 'tokens'), tokens = tokensFile ? require('fs').readFileSync(tokensFile, 'utf8').split(/\s+/).filter(Boolean) : null;
  const opts = { base, client: arg(argv, 'client', 'demo'), players: +arg(argv, 'players', 50), durationS: +arg(argv, 'duration', 60), stake: +arg(argv, 'stake', 0), tokens, repeatRate: +arg(argv, 'repeat-rate', 0.05), rampS: +arg(argv, 'ramp', 10) };
  console.error('load test: ' + opts.players + ' players for ' + opts.durationS + ' s against ' + base + ' (client ' + opts.client + ')');
  const sum = await run(opts);
  if (flag(argv, 'json')) console.log(JSON.stringify(sum, null, 2));
  else {
    console.log('plays ' + sum.plays + ' (' + sum.playsPerSecond + '/s) by ' + sum.players + ' players in ' + sum.seconds + ' s; wins ' + sum.wins + '; staked ' + sum.staked + ', paid ' + sum.paid + ' (return ' + sum.returnToPlayer + ')');
    console.log('latency of a play: p50 ' + sum.latencyMs.p50 + ' ms, p95 ' + sum.latencyMs.p95 + ' ms, p99 ' + sum.latencyMs.p99 + ' ms, max ' + sum.latencyMs.max + ' ms');
    console.log('repeated requests ' + sum.repeats + ', not idempotent ' + sum.repeatViolations + '; server errors ' + sum.serverErrors + '; timeouts ' + sum.timeouts + '; auth failures ' + sum.authFailed);
    console.log('errors by code: ' + JSON.stringify(sum.errors));
    console.log('Now run `php artisan games:reconcile` on the server and compare the totals above with the Games tab of the consoles.');
  }
  process.exit(sum.repeatViolations || sum.serverErrors || sum.authFailed === opts.players ? 1 : 0);
}

module.exports = { run, pct, isLocal };
if (require.main === module) main();
