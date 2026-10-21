'use strict';
// wallet signing, rollback of unknown debits, persistent sessions, mock wallet guard
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const sign = require('../server/sign.js');
const walletLib = require('../server/wallet.js');
const { Engine } = require('../server/engine.js');

(async () => {
  /* ---- signing ---- */
  const secret = 'a'.repeat(32), body = '{"playerId":"p1","amount":500,"txId":"bet:1:x"}';
  let clock = 1700000000000;
  const h = sign.signedHeaders(secret, 'k1', 'POST', '/api/wallet/debit', body, clock);
  const V = () => new sign.Verifier(secret, { now: () => clock });
  assert.deepStrictEqual(V().verify(h, 'POST', '/api/wallet/debit', body), { ok: true });
  assert.strictEqual(V().verify(h, 'POST', '/api/wallet/debit', body.replace('500', '5000')).error, 'BAD_SIGNATURE');   // tampered body
  assert.strictEqual(V().verify(h, 'POST', '/api/wallet/credit', body).error, 'BAD_SIGNATURE');                       // other path
  assert.strictEqual(new sign.Verifier('b'.repeat(32), { now: () => clock }).verify(h, 'POST', '/api/wallet/debit', body).error, 'BAD_SIGNATURE');
  const v = V(); assert.strictEqual(v.verify(h, 'POST', '/api/wallet/debit', body).ok, true);
  assert.strictEqual(v.verify(h, 'POST', '/api/wallet/debit', body).error, 'REPLAYED_NONCE');                         // replay
  clock += 6 * 60 * 1000; assert.strictEqual(V().verify(h, 'POST', '/api/wallet/debit', body).error, 'STALE_TIMESTAMP'); clock -= 6 * 60 * 1000;
  assert.strictEqual(V().verify({}, 'POST', '/x', body).error, 'MISSING_SIGNATURE');

  /* ---- HttpWallet against a local platform that verifies the signature and supports rollback ---- */
  const verifier = new sign.Verifier(secret), applied = new Map(), cancelled = new Set(); let rejected = [], dropReplies = 0, balance = 100000;
  const platform = http.createServer((req, res) => {
    let raw = ''; req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const out = (code, o) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
      const r = verifier.verify(req.headers, req.method, new URL(req.url, 'http://x').pathname, raw);
      if (!r.ok) { rejected.push(r.error); return out(401, { ok: false, error: r.error }); }
      const b = JSON.parse(raw);
      if (req.url.endsWith('/session/validate')) return out(200, { ok: true, playerId: 'p1', currency: 'PHP', balance });
      if (req.url.endsWith('/wallet/balance')) return out(200, { ok: true, balance });
      if (req.url.endsWith('/wallet/debit')) {
        if (cancelled.has(b.txId)) return out(409, { ok: false, error: 'TX_ROLLED_BACK' });
        if (!applied.has(b.txId)) { balance -= b.amount; applied.set(b.txId, b.amount); }
        if (dropReplies > 0) { dropReplies--; return req.socket.destroy(); }             // applied, but the game never gets the answer
        return out(200, { ok: true, balance });
      }
      if (req.url.endsWith('/wallet/rollback')) {
        cancelled.add(b.txId);
        if (applied.has(b.txId)) { balance += applied.get(b.txId); applied.delete(b.txId); return out(200, { ok: true, balance, status: 'rolled_back' }); }
        return out(200, { ok: true, balance, status: 'not_found' });
      }
      if (req.url.endsWith('/wallet/credit')) { balance += b.amount; return out(200, { ok: true, balance }); }
      out(404, { ok: false, error: 'NOT_FOUND' });
    });
  });
  await new Promise((ok) => platform.listen(0, '127.0.0.1', ok));
  const url = 'http://127.0.0.1:' + platform.address().port + '/horse-api';
  const wallet = walletLib.create({ WALLET: 'http', WALLET_URL: url, WALLET_KEY: secret, WALLET_KEY_ID: 'k1', GAME_MODE: 'live' });
  assert.strictEqual((await wallet.validateToken('t')).playerId, 'p1');                 // signed calls are accepted
  const bad = new walletLib.HttpWallet({ url, key: 'c'.repeat(32) });
  await assert.rejects(() => bad.validateToken('t'), /BAD_SIGNATURE/);                  // wrong secret is refused
  assert(rejected.includes('BAD_SIGNATURE'));

  /* ---- a debit whose answer is lost is rolled back, the player is not charged ---- */
  const led = path.join(os.tmpdir(), 'int-ledger-' + process.pid + '.jsonl'), sess = path.join(os.tmpdir(), 'int-sessions-' + process.pid + '.json');
  [led, sess].forEach((f) => { try { fs.unlinkSync(f); } catch (e) { /* new */ } });
  let t = 5000000;
  const mk = () => new Engine({ wallet, now: () => t, ledgerFile: led, config: { betMs: 20000, sessionsFile: sess, maxRoundStake: 1e9 } });
  let eng = mk(); await eng.tick();
  const a = await eng.auth('token'), start = balance;
  dropReplies = 2;                                                                       // both attempts are applied but unanswered
  await assert.rejects(() => eng.placeBets(a.session, [{ combo: '1-2', stake: 1000 }]), /WALLET_UNAVAILABLE/);
  assert.strictEqual(balance, start - 1000);                                             // charged on the platform...
  assert.strictEqual(eng.pendingRb.size, 1);
  await eng.tick();
  assert.strictEqual(balance, start);                                                    // ...and given back by the rollback
  assert.strictEqual(eng.pendingRb.size, 0);
  assert.strictEqual(eng.cur.bets.length, 0);
  assert(fs.readFileSync(led, 'utf8').includes('rollback_ok'));
  // a rollback that cannot be delivered is kept and retried; it also survives a restart
  dropReplies = 2; platform.close(); const url2 = url;
  await assert.rejects(() => eng.placeBets(a.session, [{ combo: '1-3', stake: 1000 }]), /WALLET_UNAVAILABLE|WALLET_REJECTED/);
  assert.strictEqual(eng.pendingRb.size, 1);
  eng = mk(); await eng.recover();
  assert.strictEqual(eng.pendingRb.size, 1);                                             // recovered from the ledger
  assert(url2);

  /* ---- no rollback support: left for manual reconciliation, not retried forever ---- */
  const noRb = { debit: async () => { const e = new Error('HTTP_500'); throw e; }, balance: async () => 0, validateToken: async () => ({ playerId: 'z', balance: 1e6 }), credit: async () => ({ balance: 1 }) };
  const e5 = new Engine({ wallet: noRb, now: () => t, config: { betMs: 20000 } }); await e5.tick();
  const z = await e5.auth('x');
  await assert.rejects(() => e5.placeBets(z.session, [{ combo: '1-2', stake: 1000 }]), /WALLET_UNAVAILABLE/);
  await e5.tick(); assert.strictEqual(e5.pendingRb.size, 0);

  /* ---- sessions survive a restart (and are stored hashed) ---- */
  const w2 = new walletLib.MockWallet();
  const mk2 = () => new Engine({ wallet: w2, now: () => t, config: { betMs: 20000, sessionsFile: sess + '2' } });
  try { fs.unlinkSync(sess + '2'); } catch (e) { /* new */ }
  let e2 = mk2(); await e2.tick(); const s = await e2.auth('demo-carol');
  assert(!fs.readFileSync(sess + '2', 'utf8').includes(s.session), 'the raw session id must not be stored');
  assert.strictEqual(fs.statSync(sess + '2').mode & 0o077, 0);                           // owner-only file
  e2 = mk2(); await e2.tick();
  assert.strictEqual((await e2.me(s.session)).playerId, 'carol');                         // same session id still works
  await e2.placeBets(s.session, [{ combo: '1-2', stake: 1000 }]);
  t += 13 * 3600 * 1000; e2 = mk2(); await assert.rejects(() => e2.me(s.session), /SESSION_EXPIRED/);   // expired sessions are not restored
  const e6 = mk2(); const s6 = await e6.auth('demo-dave'); assert.strictEqual(e6.closeSessions('dave'), 1); await assert.rejects(() => e6.me(s6.session), /SESSION_EXPIRED/);

  /* ---- the mock wallet is refused in live mode unless explicitly allowed, never in production ---- */
  assert.throws(() => walletLib.create({ GAME_MODE: 'live' }), /needs WALLET=http/);
  assert.throws(() => walletLib.create({ GAME_MODE: 'live', WALLET: 'mock' }), /ALLOW_MOCK_WALLET/);
  assert.throws(() => walletLib.create({ GAME_MODE: 'live', WALLET: 'mock', ALLOW_MOCK_WALLET: '1', NODE_ENV: 'production' }), /production/);
  assert(walletLib.create({ GAME_MODE: 'live', WALLET: 'mock', ALLOW_MOCK_WALLET: '1' }) instanceof walletLib.MockWallet);
  assert(walletLib.create({ GAME_MODE: 'demo' }) instanceof walletLib.MockWallet);
  assert.throws(() => walletLib.create({ WALLET: 'http', WALLET_URL: 'https://x', WALLET_KEY: 'short' }), /too short/);

  [led, sess, sess + '2'].forEach((f) => { try { fs.unlinkSync(f); } catch (e) { /* ignore */ } });
  console.log('integration tests passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
