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

const env = process.env;
const PORT = env.PORT || 8080;
const LIVE = env.GAME_MODE === 'live';
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const generatedKey = !env.CONTROLLER_KEY;
const KEY = env.CONTROLLER_KEY || crypto.randomBytes(5).toString('hex');
fs.mkdirSync(DATA_DIR, { recursive: true });

/* ---------- demo mode: controller driven ---------- */
let director = null, engine = null, lastSaved = '';
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
async function startLive() {
  const num = (v, d) => (v === undefined || v === '' ? d : Number(v));
  engine = new Engine({
    wallet: walletFactory.create(env),
    ledgerFile: path.join(DATA_DIR, 'ledger.jsonl'),
    config: {
      rtp: num(env.RTP, 0.9), payoutMultiplier: env.PAYOUT_MULTIPLIER ? Number(env.PAYOUT_MULTIPLIER) : null,
      betMs: num(env.BET_MS, 25000), minBet: num(env.MIN_BET, 100), maxBet: num(env.MAX_BET, 100000),
      maxRoundStake: num(env.MAX_ROUND_STAKE, 500000), currency: env.CURRENCY || 'PHP'
    }
  });
  await engine.recover();
  setInterval(() => engine.tick().catch((e) => console.error('tick failed:', e.message)), 250);
  console.log('LIVE mode: wallet=' + (env.WALLET || 'mock') + ', payout x' + engine.rules().payoutMultiplier + ', theoretical RTP ' + (engine.theoreticalRtp * 100).toFixed(2) + '%');
}

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
  if (e && e.status) return json(res, e.status, { ok: false, error: e.code || e.message });
  console.error(e); return json(res, 500, { ok: false, error: 'SERVER_ERROR' });
}
function authorized(req) {
  const given = Buffer.from(String(req.headers['x-controller-key'] || ''));
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
  const file = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache',
      'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff'   // the launch token is in the URL: never leak it
    });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/')) {
    cors(res);
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    const now = Date.now();
    try {
      if (url.pathname === '/api/public' && req.method === 'GET') return json(res, 200, LIVE ? engine.publicState() : director.publicState(now));

      /* player endpoints (live mode only) */
      if (LIVE && url.pathname === '/api/auth' && req.method === 'POST') {
        const body = JSON.parse(await readBody(req) || '{}');
        return json(res, 200, Object.assign({ ok: true, rules: engine.rules() }, await engine.auth(String(body.token || ''))));
      }
      if (LIVE && url.pathname === '/api/me' && req.method === 'GET') return json(res, 200, Object.assign({ ok: true }, await engine.me(bearer(req))));
      if (LIVE && url.pathname === '/api/bet' && req.method === 'POST') {
        const body = JSON.parse(await readBody(req) || '{}');
        return json(res, 200, Object.assign({ ok: true }, await engine.placeBets(bearer(req), body.bets)));
      }

      /* operator endpoints */
      if (!authorized(req)) return json(res, 401, { ok: false, error: 'bad controller key' });
      if (LIVE) {
        if ((url.pathname === '/api/admin' || url.pathname === '/api/report') && req.method === 'GET') return json(res, 200, Object.assign({ serverNow: now }, engine.report()));
        if (url.pathname === '/api/command') return json(res, 403, { ok: false, error: 'the controller cannot change results in live mode' });
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
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
  serveStatic(req, res, decodeURIComponent(url.pathname));
});

(async () => {
  if (LIVE) await startLive();
  server.listen(PORT, () => {
    console.log('Horse Race (' + (LIVE ? 'LIVE' : 'demo') + ') running on http://localhost:' + PORT);
    console.log('  game       http://localhost:' + PORT + '/' + (LIVE && (env.WALLET || 'mock') === 'mock' ? '?token=demo-alice' : ''));
    console.log('  controller http://localhost:' + PORT + '/controller');
    console.log('  controller key: ' + KEY + (generatedKey ? '  (random - set CONTROLLER_KEY to keep it fixed)' : ''));
  });
})();
