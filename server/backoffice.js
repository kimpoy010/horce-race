'use strict';
/*
 * Client back office: the API behind /backoffice (a web panel for the platforms that offer the game).
 * A person logs in with client id + username + password (+ one-time code when the second factor is on) and gets a cookie session limited to that
 * client's own players. Roles (users.js): viewer < support < admin. Every change is written to the ledger and shown in the audit log.
 *
 * Security: scrypt passwords, login throttling per address and per account, HttpOnly + SameSite=Strict cookie (Secure over HTTPS), a CSRF token on every
 * change, an Origin check, idle and absolute session timeouts, role checked on every request (a disabled user or client is out at once), no caching.
 */
const crypto = require('crypto');
const { ROLES, checkPassword, hashPassword } = require('./users.js');

const IDLE_MS = 30 * 60000, ABSOLUTE_MS = 12 * 3600000, LOCK_MS = 10 * 60000;
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const httpErr = (status, code, message) => Object.assign(new Error(message || code), { status, code, expose: true });

class BackOffice {
  // opts: users (UserStore), clients (ClientRegistry), cookieSecure, now
  constructor(opts) {
    this.users = opts.users; this.clients = opts.clients; this.now = opts.now || Date.now; this.cookieSecure = !!opts.cookieSecure;
    this.sessions = new Map(); this.fails = new Map(); this.dummy = null;
  }

  /* ---------- helpers ---------- */
  _send(res, code, obj, extra) {
    res.writeHead(code, Object.assign({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }, extra));
    res.end(JSON.stringify(obj));
  }
  _cookie(req) { const m = /(?:^|;\s*)bo_session=([0-9a-f]{64})/.exec(req.headers.cookie || ''); return m ? m[1] : null; }
  _setCookie(token, maxAge) { return 'bo_session=' + token + '; Path=/bo; HttpOnly; SameSite=Strict; Max-Age=' + maxAge + (this.cookieSecure ? '; Secure' : ''); }
  _locked(key) { const f = this.fails.get(key); return !!f && f.until > this.now(); }
  _fail(key, limit) {
    const t = this.now(); let f = this.fails.get(key); if (!f || t - f.first > LOCK_MS) f = { n: 0, first: t, until: 0 };
    f.n++; if (f.n >= limit) f.until = t + LOCK_MS; this.fails.set(key, f); if (this.fails.size > 20000) this.fails.clear();
    return f.until > t;
  }
  _clientExists(id, engine) { return !!(this.clients && this.clients.get(id)) || (id === 'default' && !!(engine && engine.wallet)); }
  _clientActive(id, engine) { const c = this.clients && this.clients.get(id); return c ? c.status === 'active' : id === 'default' && !!(engine && engine.wallet); }

  // the session of this request (checked against the user store every time), or throws
  _session(req, mutating) {
    const token = this._cookie(req), s = token && this.sessions.get(sha(token)), t = this.now();
    if (!s) throw httpErr(401, 'NOT_LOGGED_IN');
    if (t - s.lastSeen > IDLE_MS || t - s.created > ABSOLUTE_MS) { this.sessions.delete(sha(token)); throw httpErr(401, 'SESSION_EXPIRED'); }
    const u = this.users.get(s.client, s.username);
    if (!u || u.status !== 'active') { this.sessions.delete(sha(token)); throw httpErr(401, 'NOT_LOGGED_IN'); }
    if (mutating) {
      if (String(req.headers['x-csrf-token'] || '') !== s.csrf) throw httpErr(403, 'BAD_CSRF');
      const o = req.headers.origin; if (o) { let ok = false; try { ok = new URL(o).host === req.headers.host; } catch (e) { /* bad origin */ } if (!ok) throw httpErr(403, 'BAD_ORIGIN'); }
    }
    s.lastSeen = t; s.role = u.role;
    return { s, u, token };
  }
  _need(sess, role) { if (ROLES[sess.u.role] < ROLES[role]) throw httpErr(403, 'FORBIDDEN', 'Your role (' + sess.u.role + ') cannot do this.'); }
  sweep() { const t = this.now(); for (const [k, s] of this.sessions) if (t - s.lastSeen > IDLE_MS || t - s.created > ABSOLUTE_MS) this.sessions.delete(k); }
  endSessions(client, username) { for (const [k, s] of this.sessions) if (s.client === client && (!username || s.username === username)) this.sessions.delete(k); }

  /* ---------- login ---------- */
  async login(body, ip, engine) {
    const client = String(body.client || '').toLowerCase(), username = String(body.username || '').toLowerCase(), pw = String(body.password || '').slice(0, 256);
    const kIp = 'ip:' + ip, kUser = 'user:' + client + ':' + username;
    if (this._locked(kIp) || this._locked(kUser)) throw httpErr(429, 'TOO_MANY_ATTEMPTS', 'Too many failed logins. Try again in a few minutes.');
    const u = this.users.get(client, username), ok = this._clientExists(client, engine) && u && u.status === 'active' && this._clientActive(client, engine);
    if (!this.dummy) this.dummy = await hashPassword('dummy-password-for-timing');
    const good = await checkPassword(pw, ok ? u.pass : this.dummy);
    const bad = () => {
      const lockedNow = this._fail(kUser, 5) | this._fail(kIp, 20);
      if (lockedNow && engine && this._clientExists(client, engine)) engine.audit(client, { user: username, action: 'login_locked', ip });
      throw httpErr(401, 'BAD_LOGIN', 'Wrong client, username or password.');
    };
    if (!ok || !good) return bad();
    if (u.totp && u.totp.enabled) {
      if (!body.otp) throw httpErr(401, 'OTP_REQUIRED', 'Enter the code from your authenticator app.');
      if (!this.users.totpVerify(client, username, body.otp)) return bad();
    }
    this.fails.delete(kUser);
    const token = crypto.randomBytes(32).toString('hex'), t = this.now();
    this.sessions.set(sha(token), { client, username, role: u.role, csrf: crypto.randomBytes(16).toString('hex'), created: t, lastSeen: t, ip });
    this.users.recordLogin(client, username);
    if (engine) engine.audit(client, { user: username, role: u.role, action: 'login', ip });
    return { token, session: this.sessions.get(sha(token)), user: u };
  }

  /* ---------- the routes ---------- */
  // ctx: { req, res, url, readBody, engine, ip }. Returns true when the request was for the back office.
  async handle(ctx) {
    const { req, res, url, engine, ip } = ctx;
    if (!url.pathname.startsWith('/bo/api/')) return false;
    const sub = url.pathname.slice('/bo/api/'.length), method = req.method;
    try {
      if (!engine) throw httpErr(503, 'STANDBY');
      if (sub === 'login' && method === 'POST') {
        const body = JSON.parse(await ctx.readBody() || '{}'), r = await this.login(body, ip, engine);
        return this._send(res, 200, Object.assign({ ok: true }, this._me(r)), { 'Set-Cookie': this._setCookie(r.token, ABSOLUTE_MS / 1000) }), true;
      }
      if (sub === 'logout' && method === 'POST') {
        const token = this._cookie(req); if (token) { const s = this.sessions.get(sha(token)); if (s && engine) engine.audit(s.client, { user: s.username, action: 'logout', ip }); this.sessions.delete(sha(token)); }
        return this._send(res, 200, { ok: true }, { 'Set-Cookie': this._setCookie('', 0) }), true;
      }
      const mutating = method !== 'GET' && method !== 'HEAD', sess = this._session(req, mutating), c = sess.s.client, me = sess.u;
      if (sub === 'me' && method === 'GET') return this._send(res, 200, Object.assign({ ok: true }, this._me({ session: sess.s, user: me }))), true;
      if (sub === 'password' && method === 'POST') {
        const b = JSON.parse(await ctx.readBody() || '{}');
        if (!(await checkPassword(String(b.current || ''), me.pass))) throw httpErr(403, 'BAD_PASSWORD', 'The current password is wrong.');
        await this.users.changePassword(c, me.username, String(b.next || '')); engine.audit(c, { user: me.username, action: 'password_changed', ip });
        for (const [k, s] of this.sessions) if (s.client === c && s.username === me.username && k !== sha(sess.token)) this.sessions.delete(k);          // other devices are logged out
        return this._send(res, 200, { ok: true }), true;
      }
      if (me.mustChange) throw httpErr(403, 'MUST_CHANGE_PASSWORD', 'Choose a new password first.');

      /* two-step login */
      if (sub === 'totp/setup' && method === 'POST') { const secret = this.users.totpStart(c, me.username); return this._send(res, 200, { ok: true, secret, otpauth: 'otpauth://totp/' + encodeURIComponent('Horse Race (' + c + '):' + me.username) + '?secret=' + secret + '&issuer=' + encodeURIComponent('Horse Race ' + c) }), true; }
      if (sub === 'totp/enable' && method === 'POST') {
        const b = JSON.parse(await ctx.readBody() || '{}'); if (!this.users.totpEnable(c, me.username, b.otp)) throw httpErr(400, 'BAD_OTP', 'That code is not right. Check the clock of your phone and try again.');
        engine.audit(c, { user: me.username, action: 'totp_enabled', ip }); return this._send(res, 200, { ok: true }), true;
      }
      if (sub === 'totp/disable' && method === 'POST') {
        const b = JSON.parse(await ctx.readBody() || '{}'); if (!(await checkPassword(String(b.password || ''), me.pass))) throw httpErr(403, 'BAD_PASSWORD', 'The password is wrong.');
        this.users.totpDisable(c, me.username); engine.audit(c, { user: me.username, action: 'totp_disabled', ip }); return this._send(res, 200, { ok: true }), true;
      }

      /* reading (viewer) */
      if (sub === 'client' && method === 'GET') return this._send(res, 200, { ok: true, client: this._clientInfo(c, engine) }), true;
      if (sub === 'report' && method === 'GET') return this._send(res, 200, Object.assign({}, engine.clientReport(c), { rounds: engine.rounds(c, 30).rounds, rtpSetting: undefined })), true;
      if (sub === 'rounds' && method === 'GET') return this._send(res, 200, engine.rounds(c, url.searchParams.get('limit'))), true;
      if (sub === 'players' && method === 'GET') return this._send(res, 200, engine.players(c, { query: url.searchParams.get('query'), limit: url.searchParams.get('limit') })), true;
      const pm = /^players\/([A-Za-z0-9_.@-]{1,64})(?:\/(block|unblock|close-sessions))?$/.exec(sub);
      if (pm && method === 'GET' && !pm[2]) return this._send(res, 200, engine.playerDetail(c, pm[1])), true;
      if (pm && method === 'POST' && pm[2]) {
        this._need(sess, 'support'); const b = JSON.parse(await ctx.readBody() || '{}'), pk = engine.playerKey(c, pm[1]), reason = String(b.reason || '').slice(0, 200);
        engine.audit(c, { user: me.username, role: me.role, action: 'player_' + pm[2].replace('-', '_'), target: pm[1], detail: reason, ip });
        if (pm[2] === 'block') return this._send(res, 200, engine.blockPlayer(pk, 'backoffice:' + c + ':' + me.username)), true;
        if (pm[2] === 'unblock') return this._send(res, 200, engine.unblockPlayer(pk, 'backoffice:' + c + ':' + me.username)), true;
        return this._send(res, 200, { ok: true, closed: engine.closeSessions(pk) }), true;
      }
      if ((sub === 'export/players.csv' || sub === 'export/rounds.csv') && method === 'GET') {
        engine.audit(c, { user: me.username, role: me.role, action: 'export', target: sub, ip });
        const csv = sub === 'export/players.csv' ? this._csv(['player', 'bets', 'staked', 'paid', 'net_for_player', 'last_bet', 'online', 'blocked'], engine.players(c, { limit: 500 }).players.map((p) => [p.playerId, p.bets, p.staked, p.paid, p.paid - p.staked, p.lastBetAt ? new Date(p.lastBetAt).toISOString() : '', p.online, p.blocked]))
          : this._csv(['race', 'time', 'winning_pair', 'odds', 'players', 'bets', 'staked', 'paid', 'ggr'], engine.rounds(c, 300).rounds.map((r) => [r.raceNo, new Date(r.at).toISOString(), r.combo, r.odds, r.players, r.bets, r.staked, r.paid, r.staked - r.paid]));
        res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="' + sub.slice(7) + '"', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); return res.end(csv), true;
      }

      /* admin */
      if (sub === 'users' && method === 'GET') { this._need(sess, 'admin'); return this._send(res, 200, { ok: true, users: this.users.list(c) }), true; }
      if (sub === 'users' && method === 'POST') {
        this._need(sess, 'admin'); const b = JSON.parse(await ctx.readBody() || '{}'), r = await this.users.create(c, { username: b.username, role: b.role }, me.username);      // always a temporary password
        engine.audit(c, { user: me.username, role: me.role, action: 'user_created', target: r.user.username, detail: r.user.role, ip }); return this._send(res, 200, Object.assign({ ok: true }, r)), true;
      }
      const um = /^users\/([a-z0-9._@-]{3,64})\/(role|reset-password|status|delete)$/.exec(sub);
      if (um && method === 'POST') {
        this._need(sess, 'admin'); const b = JSON.parse(await ctx.readBody() || '{}'), name = um[1], target = this.users.get(c, name);
        if (!target) throw httpErr(404, 'NOT_FOUND');
        const guard = () => { if (name === me.username) throw httpErr(400, 'SELF', 'You cannot do this to your own account.'); if (target.role === 'admin' && target.status === 'active' && this.users.activeAdmins(c) <= 1) throw httpErr(400, 'LAST_ADMIN', 'This is the last administrator.'); };
        let out;
        if (um[2] === 'role') { if (name === me.username && b.role !== 'admin') throw httpErr(400, 'SELF', 'You cannot lower your own role.'); if (target.role === 'admin' && b.role !== 'admin') guard(); out = { user: this.users.setRole(c, name, b.role) }; this.endSessions(c, name); }
        else if (um[2] === 'reset-password') { out = await this.users.resetPassword(c, name); this.endSessions(c, name); }
        else if (um[2] === 'status') { if (b.status === 'disabled') guard(); out = { user: this.users.setStatus(c, name, b.status) }; if (b.status === 'disabled') this.endSessions(c, name); }
        else { guard(); this.users.remove(c, name); this.endSessions(c, name); out = {}; }
        engine.audit(c, { user: me.username, role: me.role, action: 'user_' + um[2].replace('-', '_'), target: name, detail: um[2] === 'role' ? b.role : um[2] === 'status' ? b.status : '', ip });
        return this._send(res, 200, Object.assign({ ok: true }, out)), true;
      }
      if (sub === 'apikey/rotate' && method === 'POST') {
        this._need(sess, 'admin'); if (!this.clients || !this.clients.get(c)) throw httpErr(400, 'NO_API_KEY', 'This client has no API key to rotate.');
        const b = JSON.parse(await ctx.readBody() || '{}'), grace = b.graceHours === undefined ? undefined : Math.max(0, Math.min(168, Number(b.graceHours) || 0)) * 3600000;
        const r = this.clients.rotateKey(c, grace); engine.audit(c, { user: me.username, role: me.role, action: 'api_key_rotated', detail: 'grace ' + (grace === undefined ? 24 : grace / 3600000) + ' h', ip });
        return this._send(res, 200, { ok: true, apiKey: r.apiKey, client: this._clientInfo(c, engine) }), true;
      }
      if (sub === 'audit' && method === 'GET') { this._need(sess, 'admin'); return this._send(res, 200, engine.auditFor(c, url.searchParams.get('limit'))), true; }
      throw httpErr(404, 'NOT_FOUND');
    } catch (e) {
      if (e instanceof SyntaxError) return this._send(res, 400, { ok: false, error: 'BAD_JSON' }), true;
      if (e && e.status) return this._send(res, e.status, { ok: false, error: e.code || 'ERROR', message: e.expose || e.code === 'BAD_USER' || e.code === 'WEAK_PASSWORD' || e.code === 'USER_EXISTS' ? e.message : undefined }), true;
      console.error('back office:', e); return this._send(res, 500, { ok: false, error: 'SERVER_ERROR' }), true;
    }
  }

  _me(r) {
    const s = r.session, u = r.user;
    return { user: this.users.view(u), client: s.client, csrf: s.csrf, role: u.role, idleMinutes: IDLE_MS / 60000 };
  }
  _clientInfo(id, engine) {
    const c = this.clients && this.clients.get(id);
    if (!c) return { id, name: 'Default client', status: 'active', implicit: true };
    const v = this.clients.publicView(c);
    return { id: v.id, name: v.name, status: v.status, currency: v.currency || null, limits: v.limits, currencyLimits: v.currencyLimits, realityCheckMinutes: v.realityCheckMinutes === undefined ? null : v.realityCheckMinutes,
      bigWinMin: v.bigWinMin || null, allowedIps: v.allowedIps, returnUrlHosts: v.returnUrlHosts, wallet: { url: v.wallet.url || null, type: v.wallet.type, keyId: v.wallet.keyId || null }, webhook: v.webhook ? { url: v.webhook.url, events: v.webhook.events } : null, apiKeys: v.apiKeys };
  }
  _csv(head, rows) {
    const cell = (v) => { let s = v == null ? '' : String(v); if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = "'" + s; return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };    // text that starts like a formula is neutralised
    return [head, ...rows].map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
  }
}

module.exports = { BackOffice, IDLE_MS, ABSOLUTE_MS };
