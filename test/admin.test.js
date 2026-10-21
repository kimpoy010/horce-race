'use strict';
// operator admin console: staff accounts and roles, clients, API keys, secrets, RTP, audit, separation from the client back office
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { UserStore } = require('../server/users.js');
const { BackOffice } = require('../server/backoffice.js');
const { adminRoutes } = require('../server/admin.js');
const { ClientRegistry } = require('../server/clients.js');
const { Engine } = require('../server/engine.js');

const tmp = (n) => path.join(os.tmpdir(), 'ad-' + n + '-' + process.pid);

(async () => {
  let clock = 5000000000000;
  const reg = new ClientRegistry({ allowMock: true, now: () => clock, allowHttp: true });
  reg.create({ id: 'acme', name: 'Acme Casino', wallet: { type: 'mock' }, currency: 'PHP' });
  const led = tmp('ledger') + '.jsonl'; try { fs.unlinkSync(led); } catch (e) { /* new */ }
  const eng = new Engine({ clients: reg, now: () => clock, ledgerFile: led, config: { betMs: 20000 } }); await eng.tick();
  const clientUsers = new UserStore({ now: () => clock }), staff = new UserStore({ now: () => clock });
  const clientBo = new BackOffice({ users: clientUsers, clients: reg, now: () => clock });
  const ops = () => ({ role: 'active', health: eng.health(), alerts: [], recentAlerts: [], uptime: 100, lease: null, diskFreeMb: 9999, tickAge: 0, wallet: eng.metrics.walletWindow(300000), snapshot: eng.opsSnapshot() });
  const admin = new BackOffice({ users: staff, clients: reg, now: () => clock, prefix: '/admin/api/', fixedClient: '_operator', routes: adminRoutes({ clients: reg, clientUsers, clientBackOffice: clientBo, ops }) });

  const call = async (bo, prefix, method, p, o) => {
    o = o || {};
    const req = { method, url: prefix + p, headers: Object.assign({ host: 'game.test' }, o.headers) };
    const cookieName = bo === admin ? 'admin_session' : 'bo_session';
    if (o.cookie) req.headers.cookie = cookieName + '=' + o.cookie;
    if (o.csrf) req.headers['x-csrf-token'] = o.csrf;
    const res = { code: 0, headers: {}, body: '', writeHead(c, h) { this.code = c; this.headers = h || {}; }, end(b) { this.body = b || ''; } };
    const handled = await bo.handle({ req, res, url: new URL(prefix + p, 'http://game.test'), readBody: async () => (o.body ? JSON.stringify(o.body) : ''), engine: eng, ip: o.ip || '203.0.113.5' });
    assert(handled, 'not handled: ' + p);
    let json = null; try { json = JSON.parse(res.body); } catch (e) { /* none */ }
    const sc = res.headers['Set-Cookie'], m = sc && /_session=([0-9a-f]{64})/.exec(sc);
    return { status: res.code, json, headers: res.headers, token: m ? m[1] : null, cookie: sc };
  };
  const A = (method, p, o) => call(admin, '/admin/api/', method, p, o);
  const C = (method, p, o) => call(clientBo, '/bo/api/', method, p, o);
  const sessionOf = async (name, pw) => { const r = await A('POST', 'login', { body: { username: name, password: pw } }); assert.strictEqual(r.status, 200, JSON.stringify(r.json)); return { cookie: r.token, csrf: r.json.csrf, r }; };
  const mkStaff = async (name, role) => { await staff.create('_operator', { username: name, role, password: 'long-secret-phrase-9' }, 'test'); return sessionOf(name, 'long-secret-phrase-9'); };

  // bootstrap account (created by the CLI): temporary password, replaced at the first sign-in
  const first = await staff.create('_operator', { username: 'owner', role: 'admin' }, 'cli');
  assert.strictEqual((await A('POST', 'login', { body: { username: 'owner', password: 'wrong-password-123' } })).status, 401);
  const lg = await A('POST', 'login', { body: { client: 'acme', username: 'owner', password: first.tempPassword } });          // a "client" in the body is ignored: staff are one fixed group
  assert.strictEqual(lg.status, 200); assert(/^admin_session=/.test(lg.cookie) && /Path=\/admin/.test(lg.cookie) && /HttpOnly/.test(lg.cookie) && /SameSite=Strict/.test(lg.cookie));
  assert.strictEqual((await A('GET', 'overview', { cookie: lg.token })).json.error, 'MUST_CHANGE_PASSWORD');
  assert.strictEqual((await A('POST', 'password', { cookie: lg.token, csrf: lg.json.csrf, body: { current: first.tempPassword, next: 'operator-long-phrase-1' } })).status, 200);
  const owner = await sessionOf('owner', 'operator-long-phrase-1');
  // the two sessions are separate worlds: an operator cookie means nothing in the client back office, and the other way round
  assert.strictEqual((await C('GET', 'me', { cookie: owner.cookie })).status, 401);
  await clientUsers.create('acme', { username: 'boss', role: 'admin', password: 'acme-long-phrase-42' }, 'x');
  const cl = await C('POST', 'login', { body: { client: 'acme', username: 'boss', password: 'acme-long-phrase-42' } }); assert.strictEqual(cl.status, 200);
  assert.strictEqual((await A('GET', 'overview', { cookie: cl.token })).status, 401);
  assert.strictEqual((await A('GET', 'players', { cookie: owner.cookie })).status, 404);                                       // client-only routes do not exist in the console
  assert.strictEqual((await C('GET', 'overview', { cookie: cl.token })).status, 404);                                          // and the console routes do not exist in the back office

  // overview
  const ov = (await A('GET', 'overview', { cookie: owner.cookie })).json;
  if (!ov.ok) console.log(JSON.stringify(await A('GET', 'overview', { cookie: owner.cookie })));
  assert(ov.ok && ov.health.ok && ov.game && ov.rtp.rows.length === 15 && Array.isArray(ov.clients) && ov.clients[0].id === 'acme' && ov.clients[0].wallet === 'mock wallet' && ov.clients[0].users === 1);
  assert(!JSON.stringify(ov).includes('hash'));

  // roles
  const viewer = await mkStaff('vera', 'viewer'), support = await mkStaff('sam', 'support');
  assert.strictEqual((await A('GET', 'overview', { cookie: viewer.cookie })).status, 200);
  assert.strictEqual((await A('GET', 'clients/acme', { cookie: viewer.cookie })).status, 200);
  const newClientBody = { client: { id: 'zeta', name: 'Zeta Play', currency: 'USD', wallet: { url: 'https://zeta.example/api' }, webhook: { url: 'https://zeta.example/hook' } } };
  assert.strictEqual((await A('POST', 'clients', { cookie: viewer.cookie, csrf: viewer.csrf, body: newClientBody })).status, 403);
  assert.strictEqual((await A('POST', 'clients', { cookie: support.cookie, csrf: support.csrf, body: newClientBody })).status, 403);
  assert.strictEqual((await A('POST', 'rtp', { cookie: support.cookie, csrf: support.csrf, body: { rtp: 0.95 } })).status, 403);
  assert.strictEqual((await A('GET', 'users', { cookie: support.cookie })).status, 403);                                         // staff list: admin only
  assert.strictEqual((await A('POST', 'clients', { cookie: owner.cookie, body: newClientBody })).json.error, 'BAD_CSRF');
  // create a client: API key and generated wallet secret are returned once
  const made = await A('POST', 'clients', { cookie: owner.cookie, csrf: owner.csrf, body: newClientBody });
  assert.strictEqual(made.status, 200, JSON.stringify(made.json)); assert(/^hrk_zeta_[0-9a-f]{48}$/.test(made.json.apiKey)); assert(/^[0-9a-f]{64}$/.test(made.json.walletSecret)); assert(made.json.client.wallet.secret.startsWith('***'));
  assert.strictEqual(reg.walletFor('zeta') !== null, true);
  assert.strictEqual((await A('POST', 'clients', { cookie: owner.cookie, csrf: owner.csrf, body: newClientBody })).status, 409);
  assert.strictEqual((await A('POST', 'clients', { cookie: owner.cookie, csrf: owner.csrf, body: { client: { id: 'bad id', wallet: { url: 'https://x.example' } } } })).json.error, 'BAD_CLIENT');
  const detail = (await A('GET', 'clients/zeta', { cookie: viewer.cookie })).json;
  assert.strictEqual(detail.client.id, 'zeta'); assert.strictEqual(detail.client.apiKeys.length, 1); assert(!JSON.stringify(detail).includes(made.json.apiKey) && !JSON.stringify(detail).includes(made.json.walletSecret));   // never shown again
  // edit settings: limits in minor units, allow list, secret kept when empty
  const secretBefore = reg.get('zeta').wallet.secret;
  const upd = await A('POST', 'clients/zeta', { cookie: owner.cookie, csrf: owner.csrf, body: { name: 'Zeta Games', limits: { minBet: 200, maxBet: 9000, dailyLossLimit: 50000 }, allowedIps: ['203.0.113.0/24'], returnUrlHosts: ['lobby.zeta.example'], wallet: { url: 'https://zeta.example/v2', secret: '' }, webhook: { url: 'https://zeta.example/hook2', events: 'big.win' } } });
  assert.strictEqual(upd.status, 200, JSON.stringify(upd.json));
  const z = reg.get('zeta'); assert.strictEqual(z.name, 'Zeta Games'); assert.deepStrictEqual(z.limits, { minBet: 200, maxBet: 9000, dailyLossLimit: 50000 }); assert.strictEqual(z.wallet.url, 'https://zeta.example/v2'); assert.strictEqual(z.wallet.secret, secretBefore);
  assert.strictEqual(z.webhook.secret.length >= 16, true); assert.strictEqual(z.webhook.events, 'big.win');
  assert.strictEqual((await A('POST', 'clients/zeta', { cookie: owner.cookie, csrf: owner.csrf, body: { limits: { minBet: 500, maxBet: 100 } } })).json.error, 'BAD_CLIENT');
  // keys: rotate with a grace period, then revoke; wallet and webhook secrets
  const rot = await A('POST', 'clients/zeta/rotate-key', { cookie: owner.cookie, csrf: owner.csrf, body: { graceHours: 2 } });
  assert.strictEqual(rot.status, 200); assert(/^hrk_zeta_/.test(rot.json.apiKey)); assert.strictEqual(rot.json.client.apiKeys.length, 2);
  assert.strictEqual(reg.authenticate(made.json.apiKey, '203.0.113.9').id, 'zeta'); assert.strictEqual(reg.authenticate(rot.json.apiKey, '203.0.113.9').id, 'zeta');
  assert.strictEqual((await A('POST', 'clients/zeta/revoke-key', { cookie: owner.cookie, csrf: owner.csrf, body: { keyId: 'k1' } })).json.client.apiKeys.length, 1);
  assert.strictEqual(reg.authenticate(made.json.apiKey, '203.0.113.9'), null);
  assert.strictEqual((await A('POST', 'clients/zeta/rotate-key', { cookie: support.cookie, csrf: support.csrf, body: {} })).status, 403);
  const ws = await A('POST', 'clients/zeta/rotate-wallet-secret', { cookie: owner.cookie, csrf: owner.csrf, body: {} }); assert(/^[0-9a-f]{64}$/.test(ws.json.walletSecret)); assert.notStrictEqual(reg.get('zeta').wallet.secret, secretBefore); assert.strictEqual(reg.get('zeta').wallet.secret, ws.json.walletSecret);
  const whs = await A('POST', 'clients/zeta/rotate-webhook-secret', { cookie: owner.cookie, csrf: owner.csrf, body: {} }); assert(/^[0-9a-f]{64}$/.test(whs.json.webhookSecret));
  assert.strictEqual((await A('POST', 'clients/acme/rotate-wallet-secret', { cookie: owner.cookie, csrf: owner.csrf, body: {} })).status, 400);       // the mock wallet has no secret
  // suspend / enable: support may; a suspended client cannot log in to its back office
  assert.strictEqual((await A('POST', 'clients/acme/status', { cookie: viewer.cookie, csrf: viewer.csrf, body: { status: 'disabled' } })).status, 403);
  assert.strictEqual((await A('POST', 'clients/acme/status', { cookie: support.cookie, csrf: support.csrf, body: { status: 'disabled' } })).json.client.status, 'disabled');
  assert.strictEqual((await C('POST', 'login', { body: { client: 'acme', username: 'boss', password: 'acme-long-phrase-42' } })).status, 401);
  assert.strictEqual((await C('GET', 'me', { cookie: cl.token })).status, 401);                                                // its signed-in sessions end at once
  await A('POST', 'clients/acme/status', { cookie: support.cookie, csrf: support.csrf, body: { status: 'active' } });
  assert.strictEqual((await C('POST', 'login', { body: { client: 'acme', username: 'boss', password: 'acme-long-phrase-42' } })).status, 200);
  // back-office users of a client
  const cu = await A('POST', 'clients/acme/users', { cookie: owner.cookie, csrf: owner.csrf, body: { username: 'newbie', role: 'viewer' } }); assert(cu.json.tempPassword && cu.json.user.mustChange);
  assert.strictEqual((await A('POST', 'clients/acme/users', { cookie: support.cookie, csrf: support.csrf, body: { username: 'other', role: 'viewer' } })).status, 403);
  assert.strictEqual((await A('GET', 'clients/acme/users', { cookie: viewer.cookie })).json.users.length, 2);
  const rp = await A('POST', 'clients/acme/users/newbie/reset-password', { cookie: support.cookie, csrf: support.csrf, body: {} }); assert(rp.json.tempPassword && rp.json.tempPassword !== cu.json.tempPassword);
  assert.strictEqual((await A('POST', 'clients/acme/users/newbie/status', { cookie: support.cookie, csrf: support.csrf, body: { status: 'disabled' } })).json.user.status, 'disabled');
  assert.strictEqual((await A('POST', 'clients/acme/users/newbie/delete', { cookie: support.cookie, csrf: support.csrf, body: {} })).status, 403);                // delete: admin only
  assert.strictEqual((await A('POST', 'clients/acme/users/newbie/delete', { cookie: owner.cookie, csrf: owner.csrf, body: {} })).status, 200);
  // RTP
  assert.strictEqual((await A('GET', 'rtp/preview?value=0.93', { cookie: viewer.cookie })).json.rtp, 0.93);
  assert.strictEqual((await A('GET', 'rtp/preview?value=0.5', { cookie: viewer.cookie })).status, 400);
  assert.strictEqual((await A('POST', 'rtp', { cookie: owner.cookie, csrf: owner.csrf, body: { rtp: 0.5 } })).status, 400);
  const rtp = await A('POST', 'rtp', { cookie: owner.cookie, csrf: owner.csrf, body: { rtp: 0.93 } }); assert.strictEqual(rtp.status, 200); assert.strictEqual(eng.rtp, 0.93);
  // delete a client: needs the id typed in; sessions go
  assert.strictEqual((await A('POST', 'clients/zeta/delete', { cookie: owner.cookie, csrf: owner.csrf, body: { confirm: 'nope' } })).json.error, 'CONFIRM');
  assert.strictEqual((await A('POST', 'clients/zeta/delete', { cookie: support.cookie, csrf: support.csrf, body: { confirm: 'zeta' } })).status, 403);
  assert.strictEqual((await A('POST', 'clients/zeta/delete', { cookie: owner.cookie, csrf: owner.csrf, body: { confirm: 'zeta' } })).status, 200); assert.strictEqual(reg.get('zeta'), null);
  assert.strictEqual((await A('GET', 'clients/zeta', { cookie: owner.cookie })).status, 404);
  // staff management guards (shared engine with the client back office)
  assert.strictEqual((await A('POST', 'users/owner/status', { cookie: owner.cookie, csrf: owner.csrf, body: { status: 'disabled' } })).json.error, 'SELF');
  assert.strictEqual((await A('POST', 'users/sam/role', { cookie: owner.cookie, csrf: owner.csrf, body: { role: 'admin' } })).status, 200);
  assert.strictEqual((await A('GET', 'overview', { cookie: support.cookie })).status, 401);                                    // role change signs the account out
  // audit: who did what
  const log = (await A('GET', 'audit?limit=200', { cookie: owner.cookie })).json.entries, acts = log.map((e) => e.action);
  ['login', 'client_created', 'client_updated', 'api_key_rotated', 'api_key_revoked', 'wallet_secret_rotated', 'webhook_secret_rotated', 'client_suspended', 'client_enabled', 'client_user_created', 'client_user_reset_password', 'rtp_set', 'client_deleted', 'user_role'].forEach((a) => assert(acts.includes(a), 'audit missing ' + a));
  assert(log.every((e) => !JSON.stringify(e).includes(made.json.walletSecret) && !JSON.stringify(e).includes(rot.json.apiKey)));            // no secrets in the log
  const upe = log.find((e) => e.action === 'client_updated'); assert(/wallet/.test(upe.detail) && upe.user === 'owner');
  assert(/"e":"bo_action"/.test(fs.readFileSync(led, 'utf8')));
  console.log('admin console logic tests passed');

  /* ---- over HTTP: page, headers, cookie, staff created by the CLI path ---- */
  const dir = tmp('dir'); fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
  const st = new UserStore({ file: path.join(dir, 'admins.json'), secret: 'k'.repeat(20) }), tmpPw = (await st.create('_operator', { username: 'root', role: 'admin' }, 'cli')).tempPassword;
  const port = 19900 + (process.pid % 90), base = 'http://127.0.0.1:' + port;
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: Object.assign({}, process.env, { GAME_MODE: 'live', WALLET: 'none', PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dir, CONTROLLER_KEY: 'op-key', ALLOW_MOCK_WALLET: '1', CLIENTS_KEY: 'k'.repeat(20), LEASE: 'off', NODE_ENV: 'test', COOKIE_SECURE: '0' }), stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { out += d; });
  try {
    for (let i = 0; i < 50; i++) { try { if ((await fetch(base + '/healthz')).status === 200) break; } catch (e) { /* not up */ } await new Promise((ok) => setTimeout(ok, 100)); }
    const page = await fetch(base + '/admin'); assert.strictEqual(page.status, 200); assert(/Operator Console/.test(await page.text()));
    assert(/frame-ancestors 'none'/.test(page.headers.get('content-security-policy'))); assert.strictEqual(page.headers.get('x-frame-options'), 'DENY');
    assert.strictEqual((await fetch(base + '/js/admin.js')).status, 200);
    assert.strictEqual((await fetch(base + '/admin/api/overview')).status, 401);
    const lg2 = await fetch(base + '/admin/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'root', password: tmpPw }) }), j2 = await lg2.json();
    assert.strictEqual(lg2.status, 200); const ck = lg2.headers.get('set-cookie'); assert(/admin_session=/.test(ck) && /Path=\/admin/.test(ck));
    const cookie = /admin_session=[0-9a-f]+/.exec(ck)[0], hd = { cookie, 'x-csrf-token': j2.csrf, 'content-type': 'application/json' };
    assert.strictEqual((await fetch(base + '/admin/api/overview', { headers: { cookie } })).status, 403);                         // temporary password first
    assert.strictEqual((await fetch(base + '/admin/api/password', { method: 'POST', headers: hd, body: JSON.stringify({ current: tmpPw, next: 'long-account-phrase-33' }) })).status, 200);
    const ovr = await fetch(base + '/admin/api/overview', { headers: { cookie } }), ovj = await ovr.json(); assert.strictEqual(ovr.status, 200); assert(ovj.health.ok);
    const mk = await fetch(base + '/admin/api/clients', { method: 'POST', headers: hd, body: JSON.stringify({ client: { id: 'omega', wallet: { type: 'mock' } } }) }); assert.strictEqual(mk.status, 200);
    assert.strictEqual((await fetch(base + '/api/clients', { headers: { 'x-controller-key': 'op-key' } })).status, 200);          // the controller key still works for scripts
    assert.strictEqual((await fetch(base + '/bo/api/me', { headers: { cookie } })).status, 401);
    assert(!fs.readFileSync(path.join(dir, 'admins.json'), 'utf8').includes('long-account-phrase-33'));
  } finally {
    await new Promise((ok) => { child.on('exit', ok); child.kill('SIGTERM'); setTimeout(ok, 4000); });
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch (e) { /* ignore */ }
    try { fs.unlinkSync(led); } catch (e) { /* ignore */ }
  }
  if (/FATAL|Cannot start|TypeError/.test(out)) console.log(out);
  console.log('admin console HTTP tests passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
