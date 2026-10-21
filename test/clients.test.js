'use strict';
// client registry and multi-client routing: wallets, keys, webhooks, isolation, limits, disable, client API over HTTP
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const rng = require('../server/rng.js');
const sign = require('../server/sign.js');
const { ClientRegistry, ipAllowed, encrypt, decrypt } = require('../server/clients.js');
const { Engine } = require('../server/engine.js');
const { MockWallet } = require('../server/wallet.js');

const tmp = (n) => path.join(os.tmpdir(), 'cl-' + n + '-' + process.pid);
const rm = (...f) => f.forEach((x) => { try { fs.unlinkSync(x); } catch (e) { /* none */ } });
const ALL = (stake) => rng.COMBOS.map((c) => ({ combo: c, stake }));
const mkSecret = () => crypto.randomBytes(24).toString('hex');

// a stand-in platform: verifies the signature with its own secret, keeps its own accounts, receives webhooks
function platform(secret, opts) {
  opts = opts || {};
  const P = { calls: [], hooks: [], accounts: new Map(), applied: new Map(), badSig: 0, hookStatus: 200 };
  const verifier = new sign.Verifier(secret);
  P.server = http.createServer((req, res) => {
    let raw = ''; req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const out = (code, o) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
      const v = verifier.verify(req.headers, req.method, new URL(req.url, 'http://x').pathname, raw);
      if (!v.ok) { P.badSig++; return out(401, { ok: false, error: v.error }); }
      const b = JSON.parse(raw), pathname = new URL(req.url, 'http://x').pathname;
      if (pathname.endsWith('/events')) { P.hooks.push(b); return out(P.hookStatus, { ok: true }); }
      P.calls.push({ path: pathname, body: b });
      const bal = (id) => { if (!P.accounts.has(id)) P.accounts.set(id, opts.start || 100000); return P.accounts.get(id); };
      if (pathname.endsWith('/session/validate')) { const id = b.token.replace('tok-', ''); return out(200, Object.assign({ ok: true, playerId: id, currency: opts.currency || 'PHP', balance: bal(id), returnUrl: opts.returnUrl }, opts.validate)); }
      if (pathname.endsWith('/wallet/balance')) return out(200, { ok: true, balance: bal(b.playerId) });
      if (pathname.endsWith('/wallet/debit')) {
        if (!P.applied.has(b.txId)) { if (bal(b.playerId) < b.amount) return out(402, { ok: false, error: 'INSUFFICIENT_FUNDS' }); P.accounts.set(b.playerId, bal(b.playerId) - b.amount); P.applied.set(b.txId, b.amount); }
        return out(200, { ok: true, balance: bal(b.playerId) });
      }
      if (pathname.endsWith('/wallet/credit')) { if (!P.applied.has(b.txId)) { P.accounts.set(b.playerId, bal(b.playerId) + b.amount); P.applied.set(b.txId, -b.amount); } return out(200, { ok: true, balance: bal(b.playerId) }); }
      if (pathname.endsWith('/wallet/rollback')) { if (P.applied.has(b.txId) && P.applied.get(b.txId) > 0) { P.accounts.set(b.playerId, bal(b.playerId) + P.applied.get(b.txId)); P.applied.delete(b.txId); } return out(200, { ok: true, balance: bal(b.playerId), status: 'rolled_back' }); }
      out(404, { ok: false });
    });
  });
  return new Promise((ok) => P.server.listen(0, '127.0.0.1', () => { P.url = 'http://127.0.0.1:' + P.server.address().port; ok(P); }));
}

(async () => {
  /* ---- registry: keys, secrets, validation ---- */
  const cf = tmp('clients') + '.json'; rm(cf);
  let reg = new ClientRegistry({ file: cf, secret: 'file-encryption-key', allowHttp: true });
  const secretA = mkSecret();
  const made = reg.create({ id: 'acme', name: 'Acme', currency: 'PHP', wallet: { url: 'https://acme.example/horse-api', secret: secretA, keyId: 'k1' }, limits: { maxBet: 5000 }, allowedIps: ['203.0.113.0/24', '198.51.100.7'] });
  assert(/^hrk_acme_[0-9a-f]{48}$/.test(made.apiKey)); assert.strictEqual(made.walletSecret, undefined);
  const gen = reg.create({ id: 'zeta', wallet: { url: 'https://zeta.example/api' } }); assert(/^[0-9a-f]{64}$/.test(gen.walletSecret));      // generated when not given, returned once
  const fileText = fs.readFileSync(cf, 'utf8');
  assert(!fileText.includes(made.apiKey) && !fileText.includes(secretA) && !fileText.includes(gen.walletSecret));              // neither keys nor secrets in plain text
  assert(fileText.includes('enc:v1:')); assert.strictEqual(fs.statSync(cf).mode & 0o077, 0);
  assert(!JSON.stringify(reg.list()).includes(secretA));                                                                       // secrets never leave through the listing
  assert.strictEqual(decrypt(encrypt('hello', 'k'), 'k'), 'hello'); assert.throws(() => decrypt(encrypt('hello', 'k'), 'wrong'));
  assert(/CLIENTS_KEY/.test(new ClientRegistry({ file: cf }).loadError));                                                      // encrypted file without the key: refuse to guess (the server then does not start)
  assert.throws(() => reg.create({ id: 'Bad Id', wallet: { url: 'https://x.example' } }), /id must be/);
  assert.throws(() => reg.create({ id: 'nowallet' }), /wallet.url/);
  assert.throws(() => reg.create({ id: 'weak', wallet: { url: 'https://x.example', secret: 'short' } }), /at least 16/);
  assert.throws(() => new ClientRegistry({}).create({ id: 'plainhttp', wallet: { url: 'http://platform.example/api', secret: mkSecret() } }), /https/);
  assert.throws(() => reg.create({ id: 'lim', wallet: { url: 'https://x.example', secret: mkSecret() }, limits: { minBet: 500, maxBet: 100 } }), /maxBet/);
  assert.throws(() => reg.create({ id: 'ipx', wallet: { url: 'https://x.example', secret: mkSecret() }, allowedIps: ['not-an-ip'] }), /allowedIps/);
  assert.throws(() => reg.create({ id: 'mock1', wallet: { type: 'mock' } }), /mock/);
  assert.throws(() => reg.create({ id: 'acme', wallet: { url: 'https://x.example' } }), /exists/);
  // api keys: only the hash is kept; ip allow list; rotation with a grace period; revoke; disable; brute force
  let t = 1e12; reg.now = () => t;
  assert.strictEqual(reg.authenticate(made.apiKey, '203.0.113.9').id, 'acme');
  assert.strictEqual(reg.authenticate(made.apiKey, '198.51.100.7').id, 'acme');
  assert.strictEqual(reg.authenticate(made.apiKey, '192.0.2.1'), null);                                                        // not from an allowed address
  assert.strictEqual(reg.authenticate(made.apiKey.slice(0, -1) + (made.apiKey.endsWith('0') ? '1' : '0'), '203.0.113.9'), null);
  assert.strictEqual(reg.authenticate(gen.apiKey.replace('zeta', 'acme'), '203.0.113.9'), null);                              // another client's key under this id
  const rot = reg.rotateKey('acme', 3600000);
  assert.strictEqual(reg.authenticate(rot.apiKey, '203.0.113.9').id, 'acme'); assert.strictEqual(reg.authenticate(made.apiKey, '203.0.113.9').id, 'acme');   // both work during the grace time
  t += 3600001; assert.strictEqual(reg.authenticate(made.apiKey, '203.0.113.9'), null); assert.strictEqual(reg.authenticate(rot.apiKey, '203.0.113.9').id, 'acme');
  const k2 = reg.rotateKey('acme', 0); assert.strictEqual(reg.authenticate(rot.apiKey, '203.0.113.9'), null);                // grace 0 = revoked at once
  assert.strictEqual(reg.authenticate(k2.apiKey, '203.0.113.9').id, 'acme');
  reg.setStatus('acme', 'disabled'); assert.strictEqual(reg.authenticate(k2.apiKey, '203.0.113.9'), null); reg.setStatus('acme', 'active');
  for (let i = 0; i < 10; i++) reg.authenticate('hrk_acme_' + '0'.repeat(48), '203.0.113.50');
  assert.strictEqual(reg.authenticate(k2.apiKey, '203.0.113.50'), null);                                                       // ten wrong keys block that address for a while
  t += 5 * 60000 + 1; assert.strictEqual(reg.authenticate(k2.apiKey, '203.0.113.50').id, 'acme');
  assert(ipAllowed([], '1.2.3.4') && ipAllowed(['10.0.0.0/8'], '10.20.30.40') && !ipAllowed(['10.0.0.0/8'], '11.0.0.1') && ipAllowed(['::1'], '::1') && ipAllowed(['10.0.0.1'], '::ffff:10.0.0.1'));
  // the file is reloaded when it changes (the CLI edits it); a broken file keeps the last good registry
  const reg2 = new ClientRegistry({ file: cf, secret: 'file-encryption-key', allowHttp: true }); assert.strictEqual(reg2.count(), 2);
  reg.update('zeta', { currency: 'USD', limits: { minBet: 50 } }); await new Promise((ok) => setTimeout(ok, 20));
  assert.strictEqual(reg2.reload(), true); assert.strictEqual(reg2.get('zeta').currency, 'USD');
  fs.writeFileSync(cf, '{ broken'); assert.strictEqual(reg2.reload(), false); assert(reg2.loadError && reg2.count() === 2);
  rm(cf);

  /* ---- two platforms with their own wallets, secrets and webhooks, plus the implicit default client ---- */
  const A = await platform(secretA, { currency: 'PHP', returnUrl: 'https://acme.example/lobby' }), secB = mkSecret();
  const B = await platform(secB, { currency: 'USD', start: 50000, returnUrl: 'https://evil.example/phish', validate: { limits: { minBet: 200 } } });
  const R = new ClientRegistry({ allowHttp: true });
  R.create({ id: 'acme', wallet: { url: A.url + '/horse', secret: secretA }, webhook: { url: A.url + '/events' }, currency: 'PHP', limits: { maxBet: 5000, minBet: 100 }, bigWinMin: 1, returnUrlHosts: ['acme.example'] });
  R.create({ id: 'zeta', wallet: { url: B.url + '/api', secret: secB }, webhook: { url: B.url + '/events', events: 'big.win' }, currency: 'USD', limits: { minBet: 100, maxBet: 8000 }, currencyLimits: { USD: { maxRoundStake: 20000 } }, returnUrlHosts: ['zeta.example'] });
  let clock = 5000000000000; const led = tmp('ledger') + '.jsonl'; rm(led);
  const dflt = new MockWallet({ startBalance: 1e9 });
  const mk = (extra) => new Engine({ wallet: dflt, clients: R, now: () => clock, ledgerFile: led, config: Object.assign({ betMs: 20000, maxRoundStake: 1e9, maxBet: 100000 }, extra || {}) });
  const finish = async (e) => { clock += 20001; await e.tick(); clock = e.cur.startAt + e.cfg.raceMs + 1; await e.tick(); clock = e.cur.startAt + e.cfg.raceMs + e.cfg.resultsMs + 1; await e.tick(); };
  let eng = mk(); await eng.tick();

  // launch routing
  await assert.rejects(() => eng.auth('tok-p1', 'nope'), /INVALID_CLIENT/);
  await assert.rejects(() => eng.auth('tok-p1', 'Bad Id!'), /INVALID_CLIENT/);
  assert.strictEqual(eng.resolveClient(''), 'default');                                     // no client in the link and a default wallet exists
  const a1 = await eng.auth('tok-p1', 'acme'), b1 = await eng.auth('tok-p1', 'zeta');       // the same player id at two platforms is two different players
  assert.strictEqual(a1.playerId, 'p1'); assert.strictEqual(b1.playerId, 'p1'); assert.strictEqual(a1.currency, 'PHP'); assert.strictEqual(b1.currency, 'USD');
  assert.strictEqual(a1.returnUrl, 'https://acme.example/lobby'); assert.strictEqual(b1.returnUrl, null);                   // a return link outside the client's hosts is dropped
  assert.deepStrictEqual([a1.limits.minBet, a1.limits.maxBet], [100, 5000]);                 // the client's limits
  assert.deepStrictEqual([b1.limits.minBet, b1.limits.maxBet, b1.limits.maxRoundStake], [200, 8000, 20000]);   // currency table, then the platform's own reply wins for minBet
  await assert.rejects(() => eng.auth('bad token with spaces/../', 'acme'), /INVALID_PLAYER_ID/);
  // bets go to the right wallet, signed with the right secret
  await eng.placeBets(a1.session, ALL(300)); await eng.placeBets(b1.session, [{ combo: '1-2', stake: 1000 }]);
  assert.strictEqual(A.badSig + B.badSig, 0, 'every wallet call was signed with the client\'s own secret');
  assert.strictEqual(A.accounts.get('p1'), 100000 - 15 * 300); assert.strictEqual(B.accounts.get('p1'), 50000 - 1000);
  assert(A.calls.every((c) => c.path.startsWith('/horse/'))); assert(B.calls.every((c) => c.path.startsWith('/api/')));
  assert.strictEqual((await dflt.balance('p1')), 1e9);                                       // the default wallet was not touched
  const debitA = A.calls.find((c) => c.path.endsWith('/wallet/debit')).body; assert.strictEqual(debitA.playerId, 'p1'); assert.strictEqual(debitA.gameId, 'horse-race');
  await assert.rejects(() => eng.placeBets(a1.session, [{ combo: '1-2', stake: 6000 }]), /BAD_BET/);                            // acme's maxBet 5000
  await finish(eng);
  const roundA = eng.history.get('acme:p1')[0], roundB = eng.history.get('zeta:p1')[0];
  assert.strictEqual(roundA.stake, 300); assert.strictEqual(roundB.stake, 1000);                                              // histories are separate
  assert.strictEqual(eng.historyFor(eng.playerKey('acme', 'p1')).rounds[0].bets.length, 15); assert.strictEqual(eng.historyFor(eng.playerKey('zeta', 'p1')).rounds[0].bets.length, 1);
  assert.strictEqual(eng.historyFor(eng.playerKey('zeta', 'p1')).clientId, 'zeta'); assert.strictEqual(eng.historyFor(eng.playerKey('zeta', 'p1')).playerId, 'p1');
  const winA = eng.history.get('acme:p1').find((b) => b.status === 'won'); assert.strictEqual(A.accounts.get('p1'), 100000 - 4500 + winA.payout);    // acme's player was paid by acme's wallet, once
  assert.strictEqual(B.accounts.get('p1') >= 49000, true);
  // webhooks: every client with a webhook gets the result with its own totals; big.win goes to that player's client
  await eng.tick();
  const rsA = A.hooks.find((h) => h.type === 'round.settled'), rsB = B.hooks.find((h) => h.type === 'round.settled');
  assert(rsA && rsA.clientId === 'acme' && rsA.id.startsWith('horse-race:acme:round:') && rsA.data.staked === 4500 && rsA.data.bets === 15);
  assert.strictEqual(rsB, undefined);                                                           // zeta only subscribed to big.win
  const bwA = A.hooks.find((h) => h.type === 'big.win'); assert(bwA && bwA.data.playerId === 'p1' && bwA.data.betIds.length === 1 && bwA.id.startsWith('horse-race:acme:win:'));
  // isolation: blocking, closing sessions and sessions of a disabled client
  eng.blockPlayer(eng.playerKey('acme', 'p1')); await assert.rejects(() => eng.me(a1.session), /SESSION_EXPIRED/);
  assert.strictEqual((await eng.me(b1.session)).playerId, 'p1');                                // the player with the same id at the other client is untouched
  await assert.rejects(() => eng.auth('tok-p1', 'acme'), /PLAYER_BLOCKED/); assert((await eng.auth('tok-p1', 'zeta')).session);
  R.setStatus('zeta', 'disabled'); await assert.rejects(() => eng.me(b1.session), /SESSION_EXPIRED/); await assert.rejects(() => eng.auth('tok-p1', 'zeta'), /CLIENT_DISABLED/);
  R.setStatus('zeta', 'active');
  // reports and metrics per client
  const rc = eng.clientReport('acme'); assert.strictEqual(rc.staked, 4500); assert.strictEqual(rc.blockedPlayers, 1); assert.strictEqual(eng.clientReport('zeta').staked, 1000);
  assert.strictEqual(eng.stats.byClient.acme.bets, 15);
  const { render } = require('../server/metrics.js'); const mt = render(eng, {});
  assert(mt.includes('horse_client_staked_total{client="acme"} 4500') && mt.includes('client="zeta",op="debit"'));
  // a credit that could not be delivered is retried against the right client's wallet, also after a restart
  eng.unblockPlayer(eng.playerKey('acme', 'p1'));
  const a2 = await eng.auth('tok-p2', 'acme'); await eng.placeBets(a2.session, ALL(300));
  const savedUrl = A.server; await new Promise((ok) => A.server.close(ok)); A.server.closeAllConnections && A.server.closeAllConnections();
  clock += 20001; await eng.tick(); clock = eng.cur.startAt + eng.cfg.raceMs + 1; await eng.tick();
  assert(eng.pending.size >= 1); const pend = [...eng.pending.values()][0]; assert.strictEqual(eng.splitPk(pend.playerId).clientId, 'acme');
  eng = mk(); await eng.recover(); assert(eng.pending.size >= 1);
  await new Promise((ok) => A.server.listen(+new URL(A.url).port, '127.0.0.1', ok));
  clock += 120000; for (let i = 0; i < 3; i++) { clock += 70000; await eng.tick(); }
  assert.strictEqual(eng.pending.size, 0); assert(A.calls.some((c) => c.path.endsWith('/wallet/credit') && c.body.playerId === 'p2'));
  A.server.close(); B.server.close(); rm(led);

  /* ---- one client only, no default wallet: the link may leave the client out; none at all is refused ---- */
  const onlyReg = new ClientRegistry({ allowMock: true }); onlyReg.create({ id: 'solo', wallet: { type: 'mock' } });
  const e1 = new Engine({ clients: onlyReg, now: () => clock, config: {} });
  assert.strictEqual(e1.resolveClient(''), 'solo'); onlyReg.create({ id: 'duo', wallet: { type: 'mock' } }); assert.throws(() => e1.resolveClient(''), /CLIENT_REQUIRED/);
  assert.throws(() => new Engine({ clients: new ClientRegistry({}), now: () => clock, config: {} }).resolveClient(''), /CLIENT_REQUIRED/);

  console.log('registry and routing tests passed');

  /* ---- over HTTP: operator creates a client, the client uses its API key, a player launches ---- */
  const dir = tmp('data') + '-dir'; fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
  const secC = mkSecret(), C = await platform(secC, { currency: 'PHP' });
  const port = 18000 + (process.pid % 1000), base = 'http://127.0.0.1:' + port;
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: Object.assign({}, process.env, { GAME_MODE: 'live', WALLET: 'none', PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dir, CONTROLLER_KEY: 'op-key', ALLOW_HTTP_WALLET: '1', CLIENTS_KEY: 'k'.repeat(20), LEASE: 'off', NODE_ENV: 'test' }), stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; });
  const call = async (method, p, body, headers) => { const r = await fetch(base + p, { method, headers: Object.assign({ 'content-type': 'application/json' }, headers), body: body ? JSON.stringify(body) : undefined }); let j = {}; try { j = await r.json(); } catch (e) { /* none */ } return { status: r.status, body: j }; };
  const op = { 'x-controller-key': 'op-key' };
  try {
    for (let i = 0; i < 50; i++) { try { const r = await fetch(base + '/healthz'); if (r.status === 200) break; } catch (e) { /* not up yet */ } await new Promise((ok) => setTimeout(ok, 100)); }
    assert.strictEqual((await call('POST', '/api/auth', { token: 'tok-p1', client: 'omega' })).body.error, 'INVALID_CLIENT');
    assert.strictEqual((await call('POST', '/api/auth', { token: 'tok-p1' })).body.error, 'CLIENT_REQUIRED');
    assert.strictEqual((await call('POST', '/api/clients', { client: { id: 'omega', wallet: { url: C.url + '/h', secret: secC } } })).status, 401);   // needs the operator key
    const cr = await call('POST', '/api/clients', { client: { id: 'omega', name: 'Omega', wallet: { url: C.url + '/h', secret: secC }, webhook: { url: C.url + '/events' }, currency: 'PHP', allowedIps: ['127.0.0.0/8'] } }, op);
    assert.strictEqual(cr.status, 200, JSON.stringify(cr.body)); assert(cr.body.apiKey.startsWith('hrk_omega_'));
    const bad = await call('POST', '/api/clients', { client: { id: 'xx', wallet: { url: 'ftp://nope' } } }, op); assert.strictEqual(bad.status, 400); assert(/wallet.url/.test(bad.body.message), JSON.stringify(bad.body));
    assert.strictEqual((await call('GET', '/api/clients', null, op)).body.clients.length, 1);
    assert(!fs.readFileSync(path.join(dir, 'clients.json'), 'utf8').includes(secC));                 // encrypted at rest (CLIENTS_KEY)
    const key = { authorization: 'Bearer ' + cr.body.apiKey };
    // a player launches through the client's link and bets
    const au = await call('POST', '/api/auth', { token: 'tok-pl1', client: 'omega' }); assert.strictEqual(au.status, 200, JSON.stringify(au.body)); assert.strictEqual(au.body.playerId, 'pl1');
    const bet = await call('POST', '/api/bet', { bets: [{ combo: '1-2', stake: 1000 }] }, { authorization: 'Bearer ' + au.body.session });
    if (bet.status !== 200) assert(/BETTING_CLOSED/.test(bet.body.error)); 
    // the client API: its own report, history and player controls
    assert.strictEqual((await call('GET', '/api/client/info')).status, 401);
    assert.strictEqual((await call('GET', '/api/client/info', null, { authorization: 'Bearer hrk_omega_' + '0'.repeat(48) })).status, 401);
    const info = await call('GET', '/api/client/info', null, key); assert.strictEqual(info.body.client.id, 'omega'); assert(!JSON.stringify(info.body).includes(secC) && !JSON.stringify(info.body).includes('hash'));
    assert.strictEqual((await call('GET', '/api/client/report', null, key)).body.clientId, 'omega');
    assert.strictEqual((await call('GET', '/api/client/history?playerId=pl1', null, key)).body.clientId, 'omega');
    assert.strictEqual((await call('POST', '/api/client/players/block', { playerId: 'pl1' }, key)).body.blocked, true);
    assert.strictEqual((await call('POST', '/api/auth', { token: 'tok-pl1', client: 'omega' })).body.error, 'PLAYER_BLOCKED');
    assert.strictEqual((await call('POST', '/api/client/players/unblock', { playerId: 'pl1' }, key)).body.blocked, false);
    assert.strictEqual((await call('POST', '/api/client/players/block', { playerId: 'bad:id' }, key)).status, 400);                  // ids are checked
    assert.strictEqual((await call('GET', '/api/admin/history?client=omega&playerId=pl1', null, op)).body.clientId, 'omega');
    // rotate the key: the old one works for the grace time, then not; disabling the client stops launches and its API
    const rot2 = await call('POST', '/api/clients/omega/rotate-key', { graceHours: 0 }, op); assert(rot2.body.apiKey);
    assert.strictEqual((await call('GET', '/api/client/info', null, key)).status, 401);
    assert.strictEqual((await call('GET', '/api/client/info', null, { authorization: 'Bearer ' + rot2.body.apiKey })).status, 200);
    assert.strictEqual((await call('POST', '/api/clients/omega/status', { status: 'disabled' }, op)).body.client.status, 'disabled');
    assert.strictEqual((await call('POST', '/api/auth', { token: 'tok-pl1', client: 'omega' })).body.error, 'CLIENT_DISABLED');
    assert.strictEqual((await call('GET', '/api/client/info', null, { authorization: 'Bearer ' + rot2.body.apiKey })).status, 401);
    assert.strictEqual((await call('GET', '/metrics', null, op)).status, 200);
    assert.strictEqual(C.badSig, 0, 'the wallet of the client was called with a valid signature');
  } finally { child.kill('SIGTERM'); C.server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  if (/FATAL|Cannot start/.test(log)) console.log(log);
  console.log('client API tests passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
