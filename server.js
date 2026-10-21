#!/usr/bin/env node
/*
 * Zero-dependency server: serves /public and the game API.
 *
 *   GAME_MODE=demo (default)  controller picks the winners, no betting (spectator demo)
 *   GAME_MODE=live            fixed-odds betting, server-side random draw, wallet integration (see README)
 *
 *   PORT=8080 CONTROLLER_KEY=secret node server.js
 *   GAME_MODE=live WALLET=mock node server.js         (local testing with play money: launch with ?token=demo-alice)
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Director, execCommand } = require('./public/js/core.js');
const { Engine } = require('./server/engine.js');
const walletFactory = require('./server/wallet.js');
const webhookFactory = require('./server/webhook.js');
const { Lease } = require('./server/lease.js');
const { ClientRegistry } = require('./server/clients.js');
const { UserStore } = require('./server/users.js');
const { BackOffice } = require('./server/backoffice.js');
const { AlertManager, webhookNotifier, diskFreeMb } = require('./server/alerts.js');
const metricsLib = require('./server/metrics.js');

const env = process.env;
const PORT = env.PORT || 8080;
const HOST = env.HOST || '0.0.0.0';          // use HOST=127.0.0.1 behind a reverse proxy
const LIVE = env.GAME_MODE === 'live';
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = env.DATA_DIR || path.join(__dirname, 'data');
const generatedKey = !env.CONTROLLER_KEY;
const KEY = env.CONTROLLER_KEY || crypto.randomBytes(5).toString('hex');
fs.mkdirSync(DATA_DIR, { recursive: true });

/* ---------- demo mode: controller driven ---------- */
let director = null, engine = null, lastSaved = '';
let role = LIVE ? 'starting' : 'demo', lease = null, alerts = null, clients = null, users = null, backoffice = null;       // live: starting | standby | active | stopping
const timers = [];
if (!LIVE) {
  try { director = new Director(JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'state.json'), 'utf8'))); } catch (e) { director = new Director(); }
  setInterval(() => {
    director.tick(Date.now());
    const json = JSON.stringify(director.serialize());
    if (json === lastSaved) return;
    lastSaved = json;
    try { fs.writeFileSync(path.join(DATA_DIR, 'state.json'), json); } catch (e) { console.error('could not save state:', e.message); }
  }, 250);
}

/* ---------- live mode: fixed odds, wallet, ledger ---------- */
function loadOdds() {          // ODDS='{"1-2":60,...}' or ODDS_FILE=path.json; default: the video karera board in server/odds.js
  if (env.ODDS_FILE) return JSON.parse(fs.readFileSync(env.ODDS_FILE, 'utf8'));
  if (env.ODDS) return JSON.parse(env.ODDS);
  return null;
}

async function startLive() {
  const num = (v, d) => (v === undefined || v === '' ? d : Number(v));
  const production = env.NODE_ENV === 'production';
  clients = new ClientRegistry({ file: path.join(DATA_DIR, 'clients.json'), secret: env.CLIENTS_KEY, allowMock: env.ALLOW_MOCK_WALLET === '1' && !production, allowHttp: env.ALLOW_HTTP_WALLET === '1' });
  if (clients.loadError) throw new Error('data/clients.json: ' + clients.loadError);
  users = new UserStore({ file: path.join(DATA_DIR, 'users.json'), secret: env.CLIENTS_KEY });
  if (users.loadError) throw new Error('data/users.json: ' + users.loadError);
  backoffice = new BackOffice({ users, clients, cookieSecure: env.COOKIE_SECURE ? env.COOKIE_SECURE === '1' : production });
  if (clients.count() && !env.CLIENTS_KEY) console.warn('WARNING: CLIENTS_KEY is not set, so the client wallet secrets in data/clients.json are stored in plain text (the file is owner-only).');
  // the implicit "default" client comes from the WALLET / WEBHOOK settings; with WALLET unset and clients in the registry there is none
  const defaultWallet = env.WALLET || clients.count() === 0 ? walletFactory.create(env) : null;
  if (!defaultWallet && clients.count() === 0) console.warn('No clients yet: add one with  node scripts/clients.js add <id> ...  (or POST /api/clients) before players can launch the game.');
  engine = new Engine({
    wallet: defaultWallet, webhook: defaultWallet ? webhookFactory.create(env) : null, clients,
    ledgerFile: path.join(DATA_DIR, 'ledger.jsonl'),
    config: {
      odds: loadOdds(), rtp: num(env.RTP, 0.9) > 1 ? num(env.RTP, 90) / 100 : num(env.RTP, 0.9), settingsFile: path.join(DATA_DIR, 'settings.json'), sessionsFile: path.join(DATA_DIR, 'sessions.json'), blockedFile: path.join(DATA_DIR, 'blocked.json'),
      dailyLossLimit: num(env.DAILY_LOSS_LIMIT, 0), realityCheckMinutes: num(env.REALITY_CHECK_MIN, 0), bigWinMin: num(env.BIG_WIN_MIN, 1000000),
      currencyLimits: env.CURRENCY_LIMITS ? JSON.parse(env.CURRENCY_LIMITS) : {},
      betMs: num(env.BET_MS, 25000), minBet: num(env.MIN_BET, 100), maxBet: num(env.MAX_BET, 100000),
      maxRoundStake: num(env.MAX_ROUND_STAKE, 500000), currency: env.CURRENCY || 'PHP', ledgerStrict: env.LEDGER_STRICT === '1'
    }
  });
  if (!engine.ledger.ok) console.error('ALERT the ledger hash chain is broken at line ' + engine.ledger.check.broken.line + ': ' + engine.ledger.check.broken.reason + ' (node scripts/verify-ledger.js)');
  await engine.recover();
  timers.push(setInterval(() => {
    if (lease && !lease.valid()) return fatal('the lease expired (this process was frozen or the lease file is not writable): stopping so that no two instances act at once');
    engine.tick().catch((e) => { engine.metrics.tickErrors++; console.error('tick failed:', e.message); });
  }, 250));
  alerts = new AlertManager({ config: alertConfig(), notify: env.ALERT_WEBHOOK_URL ? webhookNotifier(env.ALERT_WEBHOOK_URL) : null });
  timers.push(setInterval(() => { if (clients.reload()) console.log('clients: registry reloaded (' + clients.count() + ' clients)'); if (users.reload()) console.log('users: reloaded'); backoffice.sweep(); }, 3000));
  timers.push(setInterval(() => { try { alerts.evaluate({ snapshot: engine.opsSnapshot(), wallet: engine.metrics.walletWindow(300000), walletClients: walletClients(), clientsError: clients.loadError, tickAge: engine.metrics.tickAge(), diskFreeMb: diskFreeMb(DATA_DIR) }); } catch (e) { console.error('alert check failed:', e.message); } }, 10000));
  if (defaultWallet && (env.WALLET || 'mock') === 'mock') console.warn('WARNING: play-money MOCK wallet (ALLOW_MOCK_WALLET=1). Never use this in production.');
  const pv = engine.previewRtp(engine.rtp);
  console.log('LIVE mode: wallet=' + (env.WALLET || 'mock') + ', RTP setting ' + (engine.rtp * 100).toFixed(2) + '% (best bets ' + (pv.bestRtp * 100).toFixed(2) + '%, three cheapest pairs ' + (pv.cheapRtp * 100).toFixed(2) + '%). Editable 88-99% in the controller.');
}

function walletClients() { const m = {}; engine.metrics.walletClients(300000).forEach((c) => { m[c] = engine.metrics.walletWindow(300000, c); }); return m; }
function clientIp(req) {          // behind the reverse proxy set TRUST_PROXY=1 to use X-Forwarded-For
  if (env.TRUST_PROXY === '1') { const f = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim(); if (f) return f; }
  return (req.socket && req.socket.remoteAddress) || '';
}
function clientAuth(req) {        // the client API: Authorization: Bearer hrk_<client>_<secret>
  const c = clients.authenticate(bearer(req), clientIp(req));
  if (!c) throw Object.assign(new Error('INVALID_API_KEY'), { status: 401, code: 'INVALID_API_KEY' });
  return c;
}
function alertConfig() {              // ALERT_CREDIT_MIN, ALERT_ROLLBACK_MIN, ALERT_WEBHOOK_MIN, ALERT_WALLET_FAIL_RATE, ALERT_WALLET_P95_MS, ALERT_RTP_Z, ALERT_DISK_FREE_MB, ALERT_REPEAT_MIN
  const m = { ALERT_CREDIT_MIN: 'creditMinutes', ALERT_ROLLBACK_MIN: 'rollbackMinutes', ALERT_WEBHOOK_MIN: 'webhookMinutes', ALERT_WALLET_FAIL_RATE: 'walletFailRate',
    ALERT_WALLET_P95_MS: 'walletP95Ms', ALERT_RTP_Z: 'rtpZ', ALERT_DISK_FREE_MB: 'diskFreeMb', ALERT_REPEAT_MIN: 'repeatMinutes' }, c = {};
  Object.keys(m).forEach((k) => { if (env[k] !== undefined && env[k] !== '' && Number.isFinite(Number(env[k]))) c[m[k]] = Number(env[k]); });
  return c;
}

/* ---------- active / standby, shutdown ---------- */
function fatal(msg) { console.error('FATAL: ' + msg); process.exit(2); }

async function bootLive() {
  const ttl = Number(env.LEASE_TTL_MS) || 10000;
  if (env.LEASE === 'off') { await startLive(); role = 'active'; return; }
  lease = new Lease(path.join(DATA_DIR, 'instance.lease'), { ttlMs: ttl });
  const activate = async () => {
    timers.push(setInterval(() => { if (!lease.renew()) fatal('the instance lease was lost'); }, 1000));
    await startLive(); role = 'active';
  };
  if (await lease.tryAcquire()) return activate();
  const other = lease.info();
  if (env.STANDBY !== '1') {
    console.error('Cannot start: another instance is running on this data directory' + (other ? ' (host ' + other.host + ', pid ' + other.pid + ', lease renewed ' + other.ageSeconds + ' s ago)' : '') + '. Set STANDBY=1 to wait as a standby instead.');
    process.exit(1);
  }
  role = 'standby'; console.log('STANDBY: waiting for the active instance' + (other ? ' (host ' + other.host + ', pid ' + other.pid + ')' : '') + ' to stop; taking over when its lease is older than ' + ttl / 1000 + ' s');
  const wait = setInterval(async () => {
    try { if (role === 'standby' && await lease.tryAcquire()) { clearInterval(wait); console.log('STANDBY: lease acquired, taking over'); await activate(); } }
    catch (e) { fatal('takeover failed: ' + e.message); }
  }, 2000);
  timers.push(wait);
}

let stopping = false;
async function shutdown(sig) {            // deploys and restarts: stop taking bets, deliver what is queued, store the sessions, free the lease
  if (stopping) return; stopping = true;
  console.log(sig + ': shutting down'); const was = role; role = 'stopping';
  setTimeout(() => process.exit(1), 9000).unref();
  timers.forEach(clearInterval);
  try { if (engine && was === 'active') await engine.shutdown(5000); } catch (e) { console.error('shutdown:', e.message); }
  try { if (lease) lease.release(); } catch (e) { /* ignore */ }
  server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 500).unref();
}
['SIGTERM', 'SIGINT'].forEach((s) => process.on(s, () => shutdown(s)));

/* ---------- http helpers ---------- */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon'
};

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'content-type, x-controller-key, authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
}
function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function fail(res, e) {
  if (e && e.status) return json(res, e.status, e.code === 'BAD_CLIENT' ? { ok: false, error: e.code, message: e.message } : { ok: false, error: e.code || e.message });
  console.error(e); return json(res, 500, { ok: false, error: 'SERVER_ERROR' });
}
function authorized(req) {
  const given = Buffer.from(String(req.headers['x-controller-key'] || bearer(req) || ''));    // Prometheus sends the key as a bearer token
  const want = Buffer.from(KEY);
  return given.length === want.length && crypto.timingSafeEqual(given, want);
}
function bearer(req) { const m = /^Bearer (.+)$/.exec(req.headers.authorization || ''); return m ? m[1] : ''; }
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 100000) { reject(new Error('too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function serveStatic(req, res, pathname) {
  if (pathname === '/' || pathname === '/play') pathname = '/index.html';
  if (pathname === '/controller') pathname = '/controller.html';
  if (pathname === '/backoffice') pathname = '/backoffice.html';
  const file = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    const hdr = {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache',
      'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff'   // the launch token is in the URL: never leak it
    };
    if (/^\/(backoffice|controller)/.test(pathname) || /\/(backoffice|controller)\.(html|js|css)$/.test(file)) {       // the panels must not be framed and may only load their own files
      hdr['X-Frame-Options'] = 'DENY'; hdr['Content-Security-Policy'] = "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; form-action 'self'";
    }
    res.writeHead(200, hdr);
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/bo/api/')) {          // the client back office: same-origin only, no CORS headers
    if (!LIVE || !backoffice) { res.writeHead(404); return res.end(); }
    try { if (await backoffice.handle({ req, res, url, readBody: () => readBody(req), engine: role === 'active' ? engine : null, ip: clientIp(req) })) return; } catch (e) { console.error('back office:', e); res.writeHead(500); return res.end(); }
  }
  if (url.pathname.startsWith('/api/')) {
    cors(res);
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    const now = Date.now();
    try {
      if (LIVE && !engine) {          // standby or still starting: only the operator can ask what is going on
        if (url.pathname === '/api/admin' && authorized(req)) return json(res, 200, { ok: true, role, lease: lease ? lease.info() : null, standby: true });
        return json(res, 503, { ok: false, error: role === 'standby' ? 'STANDBY' : 'STARTING' });
      }
      if (url.pathname === '/api/public' && req.method === 'GET') return json(res, 200, LIVE ? engine.publicState() : director.publicState(now));

      /* player endpoints (live mode only) */
      if (LIVE && url.pathname === '/api/auth' && req.method === 'POST') {
        const body = JSON.parse(await readBody(req) || '{}');
        return json(res, 200, Object.assign({ ok: true, rules: engine.rules() }, await engine.auth(String(body.token || ''), body.client ? String(body.client) : '')));
      }
      if (LIVE && url.pathname === '/api/me' && req.method === 'GET') return json(res, 200, Object.assign({ ok: true }, await engine.me(bearer(req))));
      if (LIVE && url.pathname === '/api/bet' && req.method === 'POST') {
        const body = JSON.parse(await readBody(req) || '{}');
        return json(res, 200, Object.assign({ ok: true }, await engine.placeBets(bearer(req), body.bets)));
      }

      if (LIVE && url.pathname === '/api/history' && req.method === 'GET') {
        const sess = engine.session(bearer(req)); if (!sess) return json(res, 401, { ok: false, error: 'SESSION_EXPIRED' });
        return json(res, 200, engine.historyFor(sess.playerId, url.searchParams.get('limit')));
      }
      const pr = /^\/api\/round\/(\d{1,12})$/.exec(url.pathname);      // draw proof of a finished race (public: the seed is revealed after the race)
      if (LIVE && pr && req.method === 'GET') return json(res, 200, engine.proof(pr[1]));

      /* client API: a platform with its own API key, limited to its own players (see docs/CLIENT_API.md) */
      if (LIVE && url.pathname.startsWith('/api/client/')) {
        const c = clientAuth(req), sub = url.pathname.slice('/api/client/'.length);
        if (sub === 'info' && req.method === 'GET') return json(res, 200, { ok: true, client: clients.publicView(c) });
        if (sub === 'report' && req.method === 'GET') return json(res, 200, engine.clientReport(c.id));
        if (sub === 'history' && req.method === 'GET') return json(res, 200, engine.historyFor(engine.playerKey(c.id, url.searchParams.get('playerId')), url.searchParams.get('limit')));
        if (req.method === 'POST' && ['players/block', 'players/unblock', 'players/close-sessions'].includes(sub)) {
          const body = JSON.parse(await readBody(req) || '{}'), pk = engine.playerKey(c.id, body.playerId);
          if (sub === 'players/block') return json(res, 200, engine.blockPlayer(pk, 'client:' + c.id));
          if (sub === 'players/unblock') return json(res, 200, engine.unblockPlayer(pk, 'client:' + c.id));
          return json(res, 200, { ok: true, closed: engine.closeSessions(pk) });
        }
        return json(res, 404, { ok: false, error: 'not found' });
      }

      /* operator endpoints */
      if (!authorized(req)) return json(res, 401, { ok: false, error: 'bad controller key' });
      if (LIVE) {
        if ((url.pathname === '/api/admin' || url.pathname === '/api/report') && req.method === 'GET') return json(res, 200, Object.assign({ serverNow: now }, engine.report(), { ops: ops() }));
        if (url.pathname === '/api/admin/history' && req.method === 'GET') return json(res, 200, engine.historyFor(engine.playerKey(url.searchParams.get('client'), url.searchParams.get('playerId')), url.searchParams.get('limit')));
        /* the client registry: platforms that offer the game */
        if (url.pathname === '/api/clients' && req.method === 'GET') return json(res, 200, { ok: true, clients: clients.list().map((c) => Object.assign(c, { stats: engine.clientReport(c.id), users: users.count(c.id) })), defaultClient: !!engine.wallet });
        const audit = (action, id) => engine._log({ e: 'client_admin', action, clientId: id, who: 'controller' });          // who changed which client is in the ledger
        if (url.pathname === '/api/clients' && req.method === 'POST') { const body = JSON.parse(await readBody(req) || '{}'); const r = clients.create(body.client || body); audit('created', r.client.id); return json(res, 200, Object.assign({ ok: true }, r)); }
        const um = /^\/api\/clients\/([a-z0-9-]{2,32})\/users(?:\/([a-z0-9._@-]{3,64})\/(reset-password|status|delete))?$/.exec(url.pathname);
        if (um && (clients.get(um[1]) || um[1] === 'default')) {        // back-office logins of a client, managed by the operator (the first administrator is created here)
          if (!um[2] && req.method === 'GET') return json(res, 200, { ok: true, users: users.list(um[1]) });
          if (!um[2] && req.method === 'POST') { const b = JSON.parse(await readBody(req) || '{}'); const r = await users.create(um[1], { username: b.username, role: b.role, password: b.password }, 'operator'); audit('user_created:' + r.user.username, um[1]); return json(res, 200, Object.assign({ ok: true }, r)); }
          if (um[2] && req.method === 'POST') {
            const b = JSON.parse(await readBody(req) || '{}'); let out = {};
            if (um[3] === 'reset-password') out = await users.resetPassword(um[1], um[2]); else if (um[3] === 'status') out = { user: users.setStatus(um[1], um[2], b.status) }; else { users.remove(um[1], um[2]); }
            backoffice.endSessions(um[1], um[2]); audit('user_' + um[3].replace('-', '_') + ':' + um[2], um[1]); return json(res, 200, Object.assign({ ok: true }, out));
          }
        }
        const cm = /^\/api\/clients\/([a-z0-9-]{2,32})(?:\/(rotate-key|revoke-key|status|delete))?$/.exec(url.pathname);
        if (cm && req.method === 'GET' && !cm[2]) { const c = clients.get(cm[1]); return c ? json(res, 200, { ok: true, client: clients.publicView(c), report: engine.clientReport(cm[1]) }) : json(res, 404, { ok: false, error: 'NOT_FOUND' }); }
        if (cm && req.method === 'POST') {
          const body = JSON.parse(await readBody(req) || '{}');
          if (!cm[2]) { const r = clients.update(cm[1], body.client || body); audit('updated', cm[1]); return json(res, 200, { ok: true, client: r }); }
          if (cm[2] === 'rotate-key') { const r = clients.rotateKey(cm[1], body.graceHours === undefined ? undefined : Number(body.graceHours) * 3600000); audit('key_rotated', cm[1]); return json(res, 200, Object.assign({ ok: true }, r)); }
          if (cm[2] === 'revoke-key') { const r = clients.revokeKey(cm[1], String(body.keyId || '')); audit('key_revoked', cm[1]); return json(res, 200, { ok: true, client: r }); }
          if (cm[2] === 'status') { const r = clients.setStatus(cm[1], body.status === 'disabled' ? 'disabled' : 'active'); audit(r.status === 'disabled' ? 'disabled' : 'enabled', cm[1]); return json(res, 200, { ok: true, client: r }); }
          if (cm[2] === 'delete') { if (body.confirm !== cm[1]) return json(res, 400, { ok: false, error: 'send {"confirm":"<client id>"} to delete' }); clients.remove(cm[1]); audit('deleted', cm[1]); return json(res, 200, { ok: true }); }
        }
        if (url.pathname === '/api/command' && req.method === 'POST') {          // the only live setting is the RTP; results can never be set
          const body = JSON.parse(await readBody(req) || '{}');
          if (body.cmd === 'setRtp') return json(res, 200, engine.setRtp(body.rtp, 'controller'));
          if (body.cmd === 'previewRtp') return json(res, 200, engine.previewRtp(body.rtp));
          const pkOf = () => engine.playerKey(body.clientId, body.playerId);                                                            // clientId is optional (default client)
          if (body.cmd === 'closeSessions') return json(res, 200, { ok: true, closed: engine.closeSessions(pkOf()) });   // kick a player
          if (body.cmd === 'blockPlayer') return json(res, 200, engine.blockPlayer(pkOf(), 'controller'));          // self-exclusion: no new sessions, current ones end
          if (body.cmd === 'unblockPlayer') return json(res, 200, engine.unblockPlayer(pkOf(), 'controller'));
          return json(res, 403, { ok: false, error: 'the controller cannot change results in live mode' });
        }
      } else {
        if (url.pathname === '/api/admin' && req.method === 'GET') return json(res, 200, director.adminState(now));
        if (url.pathname === '/api/command' && req.method === 'POST') {
          const result = execCommand(director, JSON.parse(await readBody(req) || '{}'), now);
          return json(res, result.ok ? 200 : 400, result);
        }
      }
      return json(res, 404, { ok: false, error: 'not found' });
    } catch (e) {
      if (e instanceof SyntaxError) return json(res, 400, { ok: false, error: 'BAD_JSON' });
      return fail(res, e);
    }
  }
  if (url.pathname === '/healthz') {          // 200 only while this process is the healthy active instance (use it for load balancer and uptime checks)
    if (!LIVE) return json(res, 200, { ok: true, mode: 'demo' });
    const h = engine && role === 'active' ? engine.health() : { ok: false, reasons: [role] };
    return json(res, h.ok ? 200 : 503, { ok: h.ok, mode: 'live', role, reasons: h.reasons });
  }
  if (url.pathname === '/metrics') {          // Prometheus text format, operator key as X-Controller-Key or Bearer token
    if (!LIVE) { res.writeHead(404); return res.end('Not found'); }
    if (!authorized(req)) { res.writeHead(401); return res.end('bad controller key'); }
    res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(engine ? metricsLib.render(engine, { role, alerts: alerts ? alerts.list() : [] }) : '# standby\nhorse_up 1\nhorse_role{role="' + role + '"} 1\n');
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
  serveStatic(req, res, decodeURIComponent(url.pathname));
});

function ops() {          // what the controller page shows under "Health and alerts"
  return { role, health: engine.health(), alerts: alerts ? alerts.list() : [], recentAlerts: alerts ? alerts.history.slice(-10).reverse() : [], snapshot: engine.opsSnapshot(),
    wallet: engine.metrics.walletWindow(300000), clients: { count: clients.count(), error: clients.loadError }, tickAge: engine.metrics.tickAge(), lease: lease ? lease.info() : null, uptime: Math.round(process.uptime()), diskFreeMb: diskFreeMb(DATA_DIR) };
}

(async () => {
  if (LIVE) { bootLive().catch((e) => { console.error('Cannot start: ' + e.message); process.exit(1); }); }
  server.listen(PORT, HOST, () => {
    console.log('Horse Race (' + (LIVE ? 'LIVE' : 'demo') + ') running on http://' + HOST + ':' + PORT);
    console.log('  game       http://localhost:' + PORT + '/' + (LIVE && (env.WALLET || 'mock') === 'mock' ? '?token=demo-alice' : ''));
    console.log('  controller http://localhost:' + PORT + '/controller');
    console.log('  controller key: ' + KEY + (generatedKey ? '  (random - set CONTROLLER_KEY to keep it fixed)' : ''));
  });
})();
