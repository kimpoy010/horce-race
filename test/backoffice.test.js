'use strict';
// client back office: users, login, roles, CSRF, throttling, data, 2FA, audit; plus the pages over HTTP
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const rng = require('../server/rng.js');
const { UserStore, totpAt, b32decode, passwordProblem } = require('../server/users.js');
const { BackOffice } = require('../server/backoffice.js');
const { ClientRegistry } = require('../server/clients.js');
const { Engine } = require('../server/engine.js');
const { MockWallet } = require('../server/wallet.js');

const tmp = (n) => path.join(os.tmpdir(), 'bo-' + n + '-' + process.pid);
const ALL = (stake) => rng.COMBOS.map((c) => ({ combo: c, stake }));

(async () => {
  /* ---- password policy and TOTP (RFC 6238 test vector) ---- */
  assert(passwordProblem('short1') && passwordProblem('aaaaaaaaaaaaaa') && passwordProblem('alice-is-great-1', 'alice') && !passwordProblem('correct horse battery staple'));
  assert.strictEqual(totpAt(require('../server/users.js').b32encode(Buffer.from('12345678901234567890')), 1), '287082');

  /* ---- in-process: engine with two clients, user store, back office ---- */
  let clock = 5000000000000;
  const reg = new ClientRegistry({ allowMock: true });
  reg.create({ id: 'acme', name: 'Acme Casino', wallet: { type: 'mock' }, currency: 'PHP' }); reg.create({ id: 'zeta', wallet: { type: 'mock' }, currency: 'USD' });
  const ledger = tmp('ledger') + '.jsonl'; try { fs.unlinkSync(ledger); } catch (e) { /* new */ }
  const eng = new Engine({ clients: reg, now: () => clock, ledgerFile: ledger, config: { betMs: 20000, maxRoundStake: 1e9 } }); await eng.tick();
  const finish = async () => { clock += 20001; await eng.tick(); clock = eng.cur.startAt + eng.cfg.raceMs + 1; await eng.tick(); clock = eng.cur.startAt + eng.cfg.raceMs + eng.cfg.resultsMs + 1; await eng.tick(); };
  const uf = tmp('users') + '.json'; try { fs.unlinkSync(uf); } catch (e) { /* new */ }
  const users = new UserStore({ file: uf, secret: 'users-key', now: () => clock });
  const bo = new BackOffice({ users, clients: reg, now: () => clock, cookieSecure: true });

  const call = async (method, p, o) => {
    o = o || {};
    const req = { method, url: p, headers: Object.assign({ host: 'game.test' }, o.headers) };
    if (o.cookie) req.headers.cookie = 'bo_session=' + o.cookie;
    if (o.csrf) req.headers['x-csrf-token'] = o.csrf;
    const res = { code: 0, headers: {}, body: '', writeHead(c, h) { this.code = c; this.headers = h || {}; }, end(b) { this.body = b || ''; } };
    const url = new URL(p, 'http://game.test');
    const handled = await bo.handle({ req, res, url, readBody: async () => (o.body ? JSON.stringify(o.body) : ''), engine: o.noEngine ? null : eng, ip: o.ip || '203.0.113.5' });
    assert(handled);
    let json = null; try { json = JSON.parse(res.body); } catch (e) { /* csv */ }
    const sc = res.headers['Set-Cookie'], token = sc && /bo_session=([0-9a-f]{64})/.exec(sc);
    return { status: res.code, json, text: res.body, headers: res.headers, token: token ? token[1] : null, cookieHeader: sc };
  };
  const login = async (client, username, password, extra) => call('POST', '/bo/api/login', { body: Object.assign({ client, username, password }, extra) });
  const session = async (client, username, password) => { const r = await login(client, username, password); assert.strictEqual(r.status, 200, JSON.stringify(r.json)); return { cookie: r.token, csrf: r.json.csrf, r }; };

  // the operator creates the first administrator: a temporary password that must be changed
  const first = await users.create('acme', { username: 'Boss', role: 'admin' }, 'operator');
  assert.strictEqual(first.user.username, 'boss'); assert(/^[a-z0-9]{4}(-[a-z0-9]{4}){3}$/.test(first.tempPassword)); assert.strictEqual(first.user.mustChange, true);
  assert(!fs.readFileSync(uf, 'utf8').includes(first.tempPassword));                                           // only a hash is stored
  assert.strictEqual(fs.statSync(uf).mode & 0o077, 0);
  assert.strictEqual((await call('GET', '/bo/api/me')).status, 401);                                           // not logged in
  const bad = await login('acme', 'boss', 'wrong-password-here'); assert.strictEqual(bad.status, 401); assert.strictEqual(bad.json.error, 'BAD_LOGIN');
  assert.strictEqual((await login('nope', 'boss', first.tempPassword)).status, 401);                          // unknown client looks the same as a wrong password
  assert.strictEqual((await login('zeta', 'boss', first.tempPassword)).json.error, 'BAD_LOGIN');              // a user belongs to one client only
  let s = await session('acme', 'boss', first.tempPassword);
  assert(/HttpOnly/.test(s.r.cookieHeader) && /SameSite=Strict/.test(s.r.cookieHeader) && /Secure/.test(s.r.cookieHeader) && /Path=\/bo/.test(s.r.cookieHeader));
  assert.strictEqual(s.r.json.user.mustChange, true);
  assert.strictEqual((await call('GET', '/bo/api/report', { cookie: s.cookie })).json.error, 'MUST_CHANGE_PASSWORD');       // nothing but the password change until it is done
  assert.strictEqual((await call('POST', '/bo/api/password', { cookie: s.cookie, body: { current: first.tempPassword, next: 'weak' } })).status, 403);   // CSRF header missing
  assert.strictEqual((await call('POST', '/bo/api/password', { cookie: s.cookie, csrf: s.csrf, body: { current: first.tempPassword, next: 'weak' } })).json.error, 'WEAK_PASSWORD');
  assert.strictEqual((await call('POST', '/bo/api/password', { cookie: s.cookie, csrf: s.csrf, body: { current: 'not-the-password', next: 'a-really-long-password-1' } })).json.error, 'BAD_PASSWORD');
  assert.strictEqual((await call('POST', '/bo/api/password', { cookie: s.cookie, csrf: s.csrf, body: { current: first.tempPassword, next: 'a-really-long-password-1' } })).status, 200);
  assert.strictEqual((await login('acme', 'boss', first.tempPassword)).status, 401);                          // the temporary password is gone
  s = await session('acme', 'boss', 'a-really-long-password-1');
  assert.strictEqual((await call('GET', '/bo/api/report', { cookie: s.cookie })).status, 200);

  // data of this client only
  const a1 = await eng.auth('demo-alice', 'acme'), a2 = await eng.auth('demo-bob', 'acme'), z1 = await eng.auth('demo-alice', 'zeta');
  await eng.placeBets(a1.session, ALL(300)); await eng.placeBets(a2.session, [{ combo: '1-2', stake: 500 }]); await eng.placeBets(z1.session, [{ combo: '1-2', stake: 777 }]);
  await finish();
  let rep = (await call('GET', '/bo/api/report', { cookie: s.cookie })).json;
  assert.strictEqual(rep.clientId, 'acme'); assert.strictEqual(rep.staked, 4500 + 500); assert.strictEqual(rep.bets, 16); assert.strictEqual(rep.rounds.length, 1); assert.strictEqual(rep.rounds[0].players, 2);
  assert.strictEqual(rep.rounds[0].staked, 5000); assert.strictEqual(rep.ggr, rep.staked - rep.paid); assert.strictEqual(rep.rounds[0].raceNo, eng.cur.raceNo - 1);
  const pl = (await call('GET', '/bo/api/players', { cookie: s.cookie })).json; assert.deepStrictEqual(pl.players.map((p) => p.playerId).sort(), ['alice', 'bob']);
  assert.strictEqual((await call('GET', '/bo/api/players?query=BO', { cookie: s.cookie })).json.players.length, 1);
  const det = (await call('GET', '/bo/api/players/alice', { cookie: s.cookie })).json; assert.strictEqual(det.totals.staked, 4500); assert.strictEqual(det.clientId, 'acme');
  assert.strictEqual(JSON.stringify(pl).includes('777'), false);                                               // zeta's bets are not visible
  assert.strictEqual((await call('GET', '/bo/api/players/alice', { cookie: s.cookie })).json.rounds[0].bets.length, 15);

  // roles: viewer < support < admin
  const mkUser = async (name, role) => { const r = await call('POST', '/bo/api/users', { cookie: s.cookie, csrf: s.csrf, body: { username: name, role } }); assert.strictEqual(r.status, 200, JSON.stringify(r.json)); const c = await users.changePassword('acme', name, 'long-secret-phrase-9'); return r.json.tempPassword; };
  await mkUser('vera', 'viewer'); await mkUser('sam', 'support');
  const viewer = await session('acme', 'vera', 'long-secret-phrase-9'), support = await session('acme', 'sam', 'long-secret-phrase-9');
  assert.strictEqual((await call('GET', '/bo/api/report', { cookie: viewer.cookie })).status, 200);
  assert.strictEqual((await call('POST', '/bo/api/players/alice/block', { cookie: viewer.cookie, csrf: viewer.csrf, body: {} })).status, 403);
  assert.strictEqual((await call('GET', '/bo/api/users', { cookie: support.cookie })).status, 403);
  assert.strictEqual((await call('GET', '/bo/api/audit', { cookie: support.cookie })).status, 403);
  assert.strictEqual((await call('POST', '/bo/api/apikey/rotate', { cookie: support.cookie, csrf: support.csrf, body: {} })).status, 403);
  // CSRF and origin
  assert.strictEqual((await call('POST', '/bo/api/players/alice/block', { cookie: support.cookie, body: {} })).json.error, 'BAD_CSRF');
  assert.strictEqual((await call('POST', '/bo/api/players/alice/block', { cookie: support.cookie, csrf: 'x'.repeat(32), body: {} })).json.error, 'BAD_CSRF');
  assert.strictEqual((await call('POST', '/bo/api/players/alice/block', { cookie: support.cookie, csrf: support.csrf, headers: { origin: 'https://evil.example' }, body: {} })).json.error, 'BAD_ORIGIN');
  // support blocks a player: sessions end, launches refused, the audit log has it; unblock again
  const blockRes = await call('POST', '/bo/api/players/alice/block', { cookie: support.cookie, csrf: support.csrf, headers: { origin: 'http://game.test' }, body: { reason: 'self-exclusion requested' } });
  assert.strictEqual(blockRes.status, 200); await assert.rejects(() => eng.me(a1.session), /SESSION_EXPIRED/); await assert.rejects(() => eng.auth('demo-alice', 'acme'), /PLAYER_BLOCKED/);
  assert.strictEqual((await eng.auth('demo-alice', 'zeta')).playerId, 'alice');                               // the same id at another client is untouched
  assert.strictEqual((await call('GET', '/bo/api/players/alice', { cookie: viewer.cookie })).json.blocked, true);
  assert.strictEqual((await call('POST', '/bo/api/players/alice/unblock', { cookie: support.cookie, csrf: support.csrf, body: {} })).json.blocked, false);
  assert.strictEqual((await call('POST', '/bo/api/players/bad:id/block', { cookie: support.cookie, csrf: support.csrf, body: {} })).status, 404);
  const log = (await call('GET', '/bo/api/audit', { cookie: s.cookie })).json.entries;
  const blockEntry = log.find((e) => e.action === 'player_block'); assert(blockEntry && blockEntry.user === 'sam' && blockEntry.target === 'alice' && blockEntry.detail === 'self-exclusion requested' && blockEntry.ip);
  assert(log.some((e) => e.action === 'login' && e.user === 'boss') && log.some((e) => e.action === 'user_created' && e.target === 'sam'));
  assert(/"e":"bo_action"/.test(fs.readFileSync(ledger, 'utf8')));                                              // also in the tamper-evident ledger
  // user management guards
  assert.strictEqual((await call('POST', '/bo/api/users/boss/status', { cookie: s.cookie, csrf: s.csrf, body: { status: 'disabled' } })).json.error, 'SELF');
  assert.strictEqual((await call('POST', '/bo/api/users/boss/role', { cookie: s.cookie, csrf: s.csrf, body: { role: 'viewer' } })).json.error, 'SELF');
  assert.strictEqual((await call('POST', '/bo/api/users', { cookie: s.cookie, csrf: s.csrf, body: { username: 'sam', role: 'viewer' } })).status, 409);
  assert.strictEqual((await call('POST', '/bo/api/users', { cookie: s.cookie, csrf: s.csrf, body: { username: 'x', role: 'viewer' } })).json.error, 'BAD_USER');
  await mkUser('ann', 'admin'); const ann = await session('acme', 'ann', 'long-secret-phrase-9');
  assert.strictEqual((await call('POST', '/bo/api/users/boss/status', { cookie: ann.cookie, csrf: ann.csrf, body: { status: 'disabled' } })).status, 200);       // two admins: one may disable the other
  assert.strictEqual((await call('GET', '/bo/api/me', { cookie: s.cookie })).status, 401);                    // and is signed out at once
  assert.strictEqual((await call('POST', '/bo/api/users/ann/delete', { cookie: ann.cookie, csrf: ann.csrf, body: {} })).json.error, 'SELF');
  const reset = await call('POST', '/bo/api/users/sam/reset-password', { cookie: ann.cookie, csrf: ann.csrf, body: {} }); assert(reset.json.tempPassword);
  assert.strictEqual((await call('GET', '/bo/api/report', { cookie: support.cookie })).status, 401);          // sessions of a reset user end
  await call('POST', '/bo/api/users/boss/status', { cookie: ann.cookie, csrf: ann.csrf, body: { status: 'active' } });
  // idle timeout
  clock += 31 * 60000; assert.strictEqual((await call('GET', '/bo/api/report', { cookie: ann.cookie })).json.error, 'SESSION_EXPIRED');
  // csv export (formula injection safe)
  s = await session('acme', 'boss', 'a-really-long-password-1');
  const csv = await call('GET', '/bo/api/export/players.csv', { cookie: s.cookie }); assert.strictEqual(csv.status, 200); assert(/^player,bets,staked/.test(csv.text)); assert(/alice,15,4500/.test(csv.text));
  assert.strictEqual(bo._csv(['a'], [['=HYPERLINK("x")'], ['-12.5'], ['x,y']]), 'a\r\n\'=HYPERLINK(""x"")\r\n-12.5\r\n"x,y"\r\n'.replace("'=HYPERLINK(\"\"x\"\")", "\"'=HYPERLINK(\"\"x\"\")\""));
  // throttling: five wrong passwords lock the account, whatever the address; the right password is refused while locked
  for (let i = 0; i < 5; i++) await login('acme', 'vera', 'wrong-password-' + i, {});
  const locked = await login('acme', 'vera', 'long-secret-phrase-9', {}); assert.strictEqual(locked.status, 429);
  clock += 11 * 60000; assert.strictEqual((await login('acme', 'vera', 'long-secret-phrase-9')).status, 200);   // the lock ends
  for (let i = 0; i < 20; i++) await login('acme', 'nobody' + i, 'x', { }).catch(() => {});                       // one address spraying many accounts gets blocked too
  assert.strictEqual((await login('acme', 'boss', 'a-really-long-password-1')).status, 429);
  assert.strictEqual((await call('POST', '/bo/api/login', { body: { client: 'acme', username: 'boss', password: 'a-really-long-password-1' }, ip: '198.51.100.9' })).status, 200);   // another address is fine
  clock += 11 * 60000;                                                                                          // the locks run out
  // 2FA: setup, enforced at login, one code works once, disable
  s = await session('acme', 'boss', 'a-really-long-password-1');
  const setup = await call('POST', '/bo/api/totp/setup', { cookie: s.cookie, csrf: s.csrf, body: {} }); assert(/^[A-Z2-7]{32}$/.test(setup.json.secret)); assert(/^otpauth:\/\/totp\//.test(setup.json.otpauth));
  const code = () => totpAt(setup.json.secret, Math.floor(clock / 30000));
  assert.strictEqual((await call('POST', '/bo/api/totp/enable', { cookie: s.cookie, csrf: s.csrf, body: { otp: '000000' } })).status, 400);
  assert.strictEqual((await call('POST', '/bo/api/totp/enable', { cookie: s.cookie, csrf: s.csrf, body: { otp: code() } })).status, 200);
  clock += 30000; assert.strictEqual((await login('acme', 'boss', 'a-really-long-password-1')).json.error, 'OTP_REQUIRED');
  assert.strictEqual((await login('acme', 'boss', 'a-really-long-password-1', { otp: '123456' })).status, 401);
  const good = code(); assert.strictEqual((await login('acme', 'boss', 'a-really-long-password-1', { otp: good })).status, 200);
  assert.strictEqual((await login('acme', 'boss', 'a-really-long-password-1', { otp: good })).status, 401);        // the same code cannot be used twice
  assert(!fs.readFileSync(uf, 'utf8').includes(setup.json.secret), 'the 2FA secret is encrypted at rest');
  // the API key of the client can be rotated by an admin and is not visible to others
  clock += 60000; s = await session('acme', 'boss', 'a-really-long-password-1').catch(async () => { clock += 30000; const r = await login('acme', 'boss', 'a-really-long-password-1', { otp: totpAt(setup.json.secret, Math.floor(clock / 30000)) }); return { cookie: r.token, csrf: r.json.csrf }; });
  const rot = await call('POST', '/bo/api/apikey/rotate', { cookie: s.cookie, csrf: s.csrf, body: { graceHours: 1 } }); assert.strictEqual(rot.status, 200); assert(/^hrk_acme_/.test(rot.json.apiKey));
  const cinfo = (await call('GET', '/bo/api/client', { cookie: s.cookie })).json.client; assert(!JSON.stringify(cinfo).includes('hash')); assert.strictEqual(cinfo.id, 'acme');
  assert.strictEqual((await call('GET', '/bo/api/report', { noEngine: true })).status, 503);                    // standby
  console.log('back office logic tests passed');

  /* ---- over HTTP: the pages, headers, cookie, operator-created admin ---- */
  const dir = tmp('dir'); fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
  const port = 19000 + (process.pid % 900), base = 'http://127.0.0.1:' + port;
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: Object.assign({}, process.env, { GAME_MODE: 'live', WALLET: 'none', PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dir, CONTROLLER_KEY: 'op-key', ALLOW_MOCK_WALLET: '1', CLIENTS_KEY: 'k'.repeat(20), LEASE: 'off', NODE_ENV: 'test', COOKIE_SECURE: '0' }), stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { out += d; });
  const op = { 'x-controller-key': 'op-key', 'content-type': 'application/json' };
  try {
    for (let i = 0; i < 50; i++) { try { if ((await fetch(base + '/healthz')).status === 200) break; } catch (e) { /* not up */ } await new Promise((ok) => setTimeout(ok, 100)); }
    const page = await fetch(base + '/backoffice'); assert.strictEqual(page.status, 200); assert(/Back Office/.test(await page.text()));
    assert(/frame-ancestors 'none'/.test(page.headers.get('content-security-policy'))); assert.strictEqual(page.headers.get('x-frame-options'), 'DENY');
    assert.strictEqual((await fetch(base + '/js/backoffice.js')).status, 200);
    assert.strictEqual((await fetch(base + '/bo/api/me')).status, 401);
    const mk = await fetch(base + '/api/clients', { method: 'POST', headers: op, body: JSON.stringify({ client: { id: 'omega', name: 'Omega', wallet: { type: 'mock' } } }) }); assert.strictEqual(mk.status, 200);
    const cu = await fetch(base + '/api/clients/omega/users', { method: 'POST', headers: op, body: JSON.stringify({ username: 'chief', role: 'admin' }) }), cuj = await cu.json(); assert.strictEqual(cu.status, 200, JSON.stringify(cuj)); assert(cuj.tempPassword);
    assert.strictEqual((await fetch(base + '/api/clients/omega/users', { method: 'POST', body: JSON.stringify({ username: 'x1x', role: 'admin' }) })).status, 401);   // operator key needed
    const lg = await fetch(base + '/bo/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client: 'omega', username: 'chief', password: cuj.tempPassword }) }), lgj = await lg.json();
    assert.strictEqual(lg.status, 200); const ck = lg.headers.get('set-cookie'); assert(/HttpOnly/.test(ck) && /SameSite=Strict/.test(ck));
    const cookie = /bo_session=[0-9a-f]+/.exec(ck)[0];
    assert.strictEqual((await fetch(base + '/bo/api/me', { headers: { cookie } })).status, 200);
    assert.strictEqual((await fetch(base + '/bo/api/report', { headers: { cookie } })).status, 403);               // must change the temporary password first
    assert.strictEqual((await fetch(base + '/bo/api/password', { method: 'POST', headers: { cookie, 'x-csrf-token': lgj.csrf, 'content-type': 'application/json' }, body: JSON.stringify({ current: cuj.tempPassword, next: 'omega-long-phrase-77' }) })).status, 200);
    const rep = await fetch(base + '/bo/api/report', { headers: { cookie } }); assert.strictEqual(rep.status, 200); assert.strictEqual((await rep.json()).clientId, 'omega');
    assert.strictEqual((await fetch(base + '/bo/api/users', { headers: { cookie } })).status, 200);
    assert.strictEqual((await fetch(base + '/api/clients/omega/users', { headers: op })).status, 200);
    assert(!fs.readFileSync(path.join(dir, 'users.json'), 'utf8').includes('omega-long-phrase-77'));
  } finally {
    await new Promise((ok) => { child.on('exit', ok); child.kill('SIGTERM'); setTimeout(ok, 4000); });
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch (e) { /* ignore */ }
    try { fs.unlinkSync(uf); fs.unlinkSync(ledger); } catch (e) { /* ignore */ }
  }
  if (/FATAL|Cannot start|TypeError/.test(out)) console.log(out);
  console.log('back office HTTP tests passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
