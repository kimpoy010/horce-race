'use strict';
/*
 * Back-office users: a login per person, per client, with a role.
 *   viewer   reads the reports, rounds and players
 *   support  also blocks / unblocks players and ends their sessions
 *   admin    also manages the users of the client, rotates its API key and reads the audit log
 * Passwords are stored as scrypt hashes; the optional second factor is a standard time-based one-time password (TOTP, RFC 6238),
 * compatible with Google Authenticator, Microsoft Authenticator, 1Password and similar apps.
 * data/users.json is owner-only; TOTP secrets inside are encrypted with CLIENTS_KEY when it is set.
 */
const fs = require('fs');
const crypto = require('crypto');
const { encrypt, decrypt } = require('./clients.js');

const ROLES = { viewer: 1, support: 2, admin: 3 };
const USER_RE = /^[a-z0-9][a-z0-9._@-]{2,63}$/;
const scrypt = (pw, salt, N) => new Promise((ok, bad) => crypto.scrypt(pw, salt, 64, { N, r: 8, p: 1, maxmem: 128 * N * 8 * 2 }, (e, k) => (e ? bad(e) : ok(k))));

async function hashPassword(pw) {
  const N = 16384, salt = crypto.randomBytes(16), key = await scrypt(pw, salt, N);
  return ['scrypt', N, salt.toString('base64'), key.toString('base64')].join('$');
}
async function checkPassword(pw, stored) {
  const [alg, N, salt, key] = String(stored || '').split('$');
  if (alg !== 'scrypt') return false;
  const want = Buffer.from(key, 'base64'), got = await scrypt(pw, Buffer.from(salt, 'base64'), +N);
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}
function passwordProblem(pw, username) {
  pw = String(pw || '');
  if (pw.length < 12) return 'The password must be at least 12 characters.';
  if (pw.length > 128) return 'The password is too long (128 characters at most).';
  if (new Set(pw).size < 5) return 'The password is too simple.';
  if (username && pw.toLowerCase().includes(String(username).toLowerCase())) return 'The password must not contain the username.';
  return null;
}
function tempPassword() {          // 4 groups of 4 letters / digits without look-alikes: easy to read out, 80 bits
  const al = 'abcdefghjkmnpqrstuvwxyz23456789', pick = () => al[crypto.randomInt(al.length)];
  return [0, 1, 2, 3].map(() => pick() + pick() + pick() + pick()).join('-');
}

/* ---------- TOTP ---------- */
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function b32encode(buf) { let bits = '', out = ''; for (const b of buf) bits += b.toString(2).padStart(8, '0'); for (let i = 0; i < bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)]; return out; }
function b32decode(s) { let bits = ''; for (const c of String(s).replace(/=+$/, '').toUpperCase()) { const i = B32.indexOf(c); if (i < 0) throw new Error('bad base32'); bits += i.toString(2).padStart(5, '0'); } const out = []; for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2)); return Buffer.from(out); }
function totpAt(secret, step) {
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(step));
  const h = crypto.createHmac('sha1', b32decode(secret)).update(msg).digest(), o = h[h.length - 1] & 15;
  return String(((h[o] & 0x7f) << 24 | h[o + 1] << 16 | h[o + 2] << 8 | h[o + 3]) % 1000000).padStart(6, '0');
}
// returns the matching time step (so a code cannot be used twice) or null
function totpCheck(secret, code, nowMs, lastStep) {
  if (!/^\d{6}$/.test(String(code || '').replace(/\s/g, ''))) return null;
  const c = String(code).replace(/\s/g, ''), step = Math.floor(nowMs / 30000);
  for (const d of [0, -1, 1]) { const s = step + d; if (s > (lastStep || 0) && totpAt(secret, s) === c) return s; }
  return null;
}

class UserStore {
  constructor(opts) {
    opts = opts || {};
    this.file = opts.file || null; this.secret = opts.secret || ''; this.now = opts.now || Date.now;
    this.users = new Map(); this.mtime = ''; this.loadError = null; this.reload(true);
  }
  _k(client, username) { return client + '\u0000' + username; }
  reload(force) {
    if (!this.file) return false;
    let st; try { st = fs.statSync(this.file); } catch (e) { return false; }
    const sig = st.mtimeMs + ':' + st.size; if (!force && sig === this.mtime) return false;
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')), map = new Map();
      for (const u of raw.users || []) { const c = JSON.parse(JSON.stringify(u)); if (c.totp && c.totp.secret) c.totp.secret = decrypt(c.totp.secret, this.secret); map.set(this._k(c.client, c.username), c); }
      this.users = map; this.mtime = sig; this.loadError = null; return true;
    } catch (e) { this.loadError = e.message; return false; }
  }
  save() {
    if (!this.file) return;
    const users = [...this.users.values()].map((u) => { const c = JSON.parse(JSON.stringify(u)); if (c.totp && c.totp.secret) c.totp.secret = encrypt(c.totp.secret, this.secret); return c; });
    const tmp = this.file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify({ version: 1, users }, null, 2), { mode: 0o600 }); fs.renameSync(tmp, this.file);
    const st = fs.statSync(this.file); this.mtime = st.mtimeMs + ':' + st.size;
  }
  get(client, username) { return this.users.get(this._k(client, String(username || '').toLowerCase())) || null; }
  view(u) { return { username: u.username, role: u.role, status: u.status, mustChange: !!u.mustChange, totp: !!(u.totp && u.totp.enabled), createdAt: u.createdAt, lastLoginAt: u.lastLoginAt || null, createdBy: u.createdBy || null }; }
  list(client) { return [...this.users.values()].filter((u) => u.client === client).map((u) => this.view(u)).sort((a, b) => a.username.localeCompare(b.username)); }
  count(client) { return this.list(client).length; }
  activeAdmins(client) { return [...this.users.values()].filter((u) => u.client === client && u.role === 'admin' && u.status === 'active').length; }
  // creates a user; without a password a temporary one is generated (returned once) and must be changed at the first login
  async create(client, input, by) {
    const username = String(input.username || '').toLowerCase();
    if (!USER_RE.test(username)) throw Object.assign(new Error('The username needs 3 to 64 characters: letters, digits and . _ @ -'), { status: 400, code: 'BAD_USER' });
    if (!ROLES[input.role]) throw Object.assign(new Error('The role must be viewer, support or admin.'), { status: 400, code: 'BAD_USER' });
    if (this.get(client, username)) throw Object.assign(new Error('This username is taken.'), { status: 409, code: 'USER_EXISTS' });
    let pw = input.password, temp = null;
    if (pw) { const p = passwordProblem(pw, username); if (p) throw Object.assign(new Error(p), { status: 400, code: 'WEAK_PASSWORD' }); } else { pw = temp = tempPassword(); }
    const u = { client, username, role: input.role, status: 'active', pass: await hashPassword(pw), mustChange: !input.password, createdAt: this.now(), createdBy: by || null };
    this.users.set(this._k(client, username), u); this.save();
    return { user: this.view(u), tempPassword: temp };
  }
  setRole(client, username, role) { const u = this._need(client, username); if (!ROLES[role]) throw Object.assign(new Error('bad role'), { status: 400, code: 'BAD_USER' }); u.role = role; this.save(); return this.view(u); }
  setStatus(client, username, status) { const u = this._need(client, username); u.status = status === 'disabled' ? 'disabled' : 'active'; this.save(); return this.view(u); }
  async resetPassword(client, username) { const u = this._need(client, username), pw = tempPassword(); u.pass = await hashPassword(pw); u.mustChange = true; this.save(); return { user: this.view(u), tempPassword: pw }; }
  async changePassword(client, username, next) {
    const u = this._need(client, username), p = passwordProblem(next, username); if (p) throw Object.assign(new Error(p), { status: 400, code: 'WEAK_PASSWORD' });
    u.pass = await hashPassword(next); u.mustChange = false; this.save();
  }
  remove(client, username) { this._need(client, username); this.users.delete(this._k(client, username)); this.save(); }
  recordLogin(client, username) { const u = this.get(client, username); if (u) { u.lastLoginAt = this.now(); this.save(); } }
  _need(client, username) { const u = this.get(client, username); if (!u) throw Object.assign(new Error('unknown user'), { status: 404, code: 'NOT_FOUND' }); return u; }

  // second factor
  totpStart(client, username) { const u = this._need(client, username), secret = b32encode(crypto.randomBytes(20)); u.totp = { secret, enabled: false, lastStep: 0 }; this.save(); return secret; }
  totpEnable(client, username, code) {
    const u = this._need(client, username); if (!u.totp || !u.totp.secret) return false;
    const step = totpCheck(u.totp.secret, code, this.now(), 0); if (!step) return false;
    u.totp.enabled = true; u.totp.lastStep = step; this.save(); return true;
  }
  totpVerify(client, username, code) { const u = this._need(client, username), step = totpCheck(u.totp.secret, code, this.now(), u.totp.lastStep); if (!step) return false; u.totp.lastStep = step; this.save(); return true; }
  totpDisable(client, username) { const u = this._need(client, username); u.totp = null; this.save(); }
}

module.exports = { UserStore, ROLES, USER_RE, hashPassword, checkPassword, passwordProblem, tempPassword, totpAt, totpCheck, b32encode, b32decode };
