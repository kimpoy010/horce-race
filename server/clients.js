'use strict';
/*
 * Client registry: the platforms (operators) that offer the game. One game server, many clients. Per client:
 *   - how the game reaches its wallet (URL + signing secret) and where its webhooks go,
 *   - its own API key(s) for calling the game's client API (stored hashed, shown once),
 *   - its currency, limits, reality check, big-win threshold, allowed IP addresses.
 * Stored in data/clients.json (owner-only file). Wallet and webhook secrets are encrypted with CLIENTS_KEY when it is set.
 * The file is re-read when it changes, so `node scripts/clients.js ...` takes effect on a running server.
 */
const fs = require('fs');
const crypto = require('crypto');
const { HttpWallet, MockWallet } = require('./wallet.js');
const { Webhook } = require('./webhook.js');

const ID_RE = /^[a-z0-9][a-z0-9-]{1,31}$/;
const DEFAULT_ID = 'default';
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

/* ---------- secrets at rest ---------- */
function cipherKey(secret) { return crypto.createHash('sha256').update(String(secret)).digest(); }
function encrypt(plain, secret) {
  if (!secret || plain == null) return plain;
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', cipherKey(secret), iv);
  const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return 'enc:v1:' + [iv, c.getAuthTag(), ct].map((b) => b.toString('base64')).join(':');
}
function decrypt(text, secret) {
  if (typeof text !== 'string' || !text.startsWith('enc:v1:')) return text;
  if (!secret) throw new Error('CLIENTS_KEY is needed to read the client secrets');
  const [iv, tag, ct] = text.slice(7).split(':').map((x) => Buffer.from(x, 'base64'));
  const d = crypto.createDecipheriv('aes-256-gcm', cipherKey(secret), iv); d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
}

/* ---------- ip allow list (IPv4 exact or CIDR, IPv6 exact) ---------- */
function v4(ip) { const m = /^(?:::ffff:)?(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/i.exec(String(ip || '')); return m ? ((+m[1] << 24) >>> 0) + (+m[2] << 16) + (+m[3] << 8) + +m[4] : null; }
function ipAllowed(list, ip) {
  if (!list || !list.length) return true;
  const n = v4(ip);
  return list.some((e) => {
    if (e === ip) return true;
    const [base, bits] = String(e).split('/'), b = v4(base);
    if (b == null || n == null) return false;
    const len = bits === undefined ? 32 : +bits, mask = len === 0 ? 0 : (0xffffffff << (32 - len)) >>> 0;
    return (n & mask) >>> 0 === (b & mask) >>> 0;
  });
}
function validIpEntry(e) { const [base, bits] = String(e).split('/'); return (v4(base) != null && (bits === undefined || (+bits >= 0 && +bits <= 32 && /^\d+$/.test(bits)))) || /^[0-9a-f:]+$/i.test(base) && bits === undefined; }

/* ---------- validation ---------- */
function fail(msg) { const e = new Error(msg); e.status = 400; e.code = 'BAD_CLIENT'; return e; }
const posInt = (v) => Number.isInteger(v) && v > 0;
function cleanLimits(l, label) {
  if (l == null) return null; if (typeof l !== 'object') throw fail(label + ' must be an object');
  const out = {};
  ['minBet', 'maxBet', 'maxRoundStake'].forEach((k) => { if (l[k] !== undefined) { if (!posInt(l[k])) throw fail(label + '.' + k + ' must be a positive whole number (minor units)'); out[k] = l[k]; } });
  if (l.dailyLossLimit !== undefined) { if (!Number.isInteger(l.dailyLossLimit) || l.dailyLossLimit < 0) throw fail(label + '.dailyLossLimit must be a whole number, 0 = none'); out.dailyLossLimit = l.dailyLossLimit; }
  if (l.decimals !== undefined) { if (!Number.isInteger(l.decimals) || l.decimals < 0 || l.decimals > 4) throw fail(label + '.decimals must be 0 to 4'); out.decimals = l.decimals; }
  if (out.minBet && out.maxBet && out.maxBet < out.minBet) throw fail(label + '.maxBet is below minBet');
  return out;
}

// returns the normalised client (secrets still in plain text). allowMock: wallet type "mock" for tests / local play money.
function normalize(input, opts) {
  opts = opts || {};
  const c = input || {};
  if (!ID_RE.test(String(c.id || ''))) throw fail('id must be 2 to 32 characters: lower-case letters, digits and "-", starting with a letter or digit');
  const out = { id: c.id, name: String(c.name || c.id).slice(0, 80), status: c.status === 'disabled' ? 'disabled' : 'active' };
  const w = c.wallet || {};
  if (w.type === 'mock') {
    if (!opts.allowMock) throw fail('wallet.type "mock" is only allowed with ALLOW_MOCK_WALLET=1 and never in production');
    out.wallet = { type: 'mock' };
  } else {
    let u; try { u = new URL(w.url); } catch (e) { throw fail('wallet.url must be a full URL'); }
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && (opts.allowHttp || /^(localhost|127\.|\[::1\])/.test(u.hostname)))) throw fail('wallet.url must be https (http only for localhost)');
    if (typeof w.secret !== 'string' || w.secret.length < 16) throw fail('wallet.secret must be at least 16 characters (openssl rand -hex 32)');
    out.wallet = { type: 'http', url: String(w.url).replace(/\/$/, ''), secret: w.secret, keyId: w.keyId ? String(w.keyId).slice(0, 40) : '', auth: w.auth === 'bearer' ? 'bearer' : 'hmac', timeoutMs: posInt(w.timeoutMs) ? w.timeoutMs : 8000 };
  }
  if (c.webhook && c.webhook.url) {
    let u; try { u = new URL(c.webhook.url); } catch (e) { throw fail('webhook.url must be a full URL'); }
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && (opts.allowHttp || /^(localhost|127\.|\[::1\])/.test(u.hostname)))) throw fail('webhook.url must be https');
    const secret = c.webhook.secret || (out.wallet.type === 'http' ? out.wallet.secret : '');
    if (typeof secret !== 'string' || secret.length < 16) throw fail('webhook.secret must be at least 16 characters (it defaults to the wallet secret)');
    out.webhook = { url: String(c.webhook.url), secret, keyId: c.webhook.keyId ? String(c.webhook.keyId) : '', events: c.webhook.events || 'round.settled,big.win' };
  }
  if (c.currency !== undefined && !/^[A-Z]{3,5}$/.test(c.currency)) throw fail('currency must be an upper-case code such as PHP');
  if (c.currency) out.currency = c.currency;
  out.limits = cleanLimits(c.limits, 'limits') || {};
  out.currencyLimits = {};
  Object.keys(c.currencyLimits || {}).forEach((k) => { out.currencyLimits[k] = cleanLimits(c.currencyLimits[k], 'currencyLimits.' + k); });
  if (c.realityCheckMinutes !== undefined) { if (!(Number(c.realityCheckMinutes) >= 0)) throw fail('realityCheckMinutes must be 0 or more'); out.realityCheckMinutes = Number(c.realityCheckMinutes); }
  if (c.bigWinMin !== undefined) { if (!posInt(c.bigWinMin)) throw fail('bigWinMin must be a positive whole number'); out.bigWinMin = c.bigWinMin; }
  out.allowedIps = [];
  (c.allowedIps || []).forEach((e) => { if (!validIpEntry(e)) throw fail('allowedIps: "' + e + '" is not an IP address or CIDR range'); out.allowedIps.push(String(e)); });
  out.returnUrlHosts = (c.returnUrlHosts || []).map((h) => String(h).toLowerCase());      // when set, the return link of a player must point to one of these hosts
  out.apiKeys = Array.isArray(c.apiKeys) ? c.apiKeys.map((k) => ({ id: String(k.id), hash: String(k.hash), createdAt: k.createdAt || 0, expiresAt: k.expiresAt || null, lastUsedAt: k.lastUsedAt || null })) : [];
  out.createdAt = c.createdAt || 0; out.updatedAt = c.updatedAt || 0;
  return out;
}

/* ---------- registry ---------- */
class ClientRegistry {
  // file: path or null (memory only); secret: CLIENTS_KEY; defaults: { allowMock, allowHttp }
  constructor(opts) {
    opts = opts || {};
    this.file = opts.file || null; this.secret = opts.secret || ''; this.now = opts.now || Date.now;
    this.allowMock = !!opts.allowMock; this.allowHttp = !!opts.allowHttp;
    this.clients = new Map(); this.wallets = new Map(); this.hooks = new Map(); this.mtime = 0; this.loadError = null;
    this.failed = new Map();            // ip -> { n, until }: failed API key attempts
    this.reload(true);
  }
  _opts() { return { allowMock: this.allowMock, allowHttp: this.allowHttp }; }

  reload(force) {
    if (!this.file) return false;
    let st; try { st = fs.statSync(this.file); } catch (e) { if (force) this.clients = new Map(); return false; }
    const sig = st.mtimeMs + ':' + st.size;
    if (!force && sig === this.mtime) return false;
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')), map = new Map();
      for (const c of raw.clients || []) {
        const copy = JSON.parse(JSON.stringify(c));
        if (copy.wallet && copy.wallet.secret) copy.wallet.secret = decrypt(copy.wallet.secret, this.secret);
        if (copy.webhook && copy.webhook.secret) copy.webhook.secret = decrypt(copy.webhook.secret, this.secret);
        map.set(c.id, normalize(copy, this._opts()));
      }
      this.clients = map; this.mtime = sig; this.loadError = null; this.wallets.clear(); this.hooks.clear();
      return true;
    } catch (e) { this.loadError = e.message; return false; }             // keep serving with the last good registry
  }
  save() {
    if (!this.file) return;
    const out = { version: 1, clients: [...this.clients.values()].map((c) => {
      const copy = JSON.parse(JSON.stringify(c));
      if (copy.wallet && copy.wallet.secret) copy.wallet.secret = encrypt(copy.wallet.secret, this.secret);
      if (copy.webhook && copy.webhook.secret) copy.webhook.secret = encrypt(copy.webhook.secret, this.secret);
      return copy;
    }) };
    const tmp = this.file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(out, null, 2), { mode: 0o600 }); fs.renameSync(tmp, this.file);
    const st = fs.statSync(this.file); this.mtime = st.mtimeMs + ':' + st.size;
  }

  get(id) { return this.clients.get(id) || null; }
  isActive(id) { const c = this.clients.get(id); return !!c && c.status === 'active'; }
  count() { return this.clients.size; }
  list() { return [...this.clients.values()].map((c) => this.publicView(c)); }
  // what an operator or the client itself may see: no secrets, no key hashes
  publicView(c) {
    const v = JSON.parse(JSON.stringify(c));
    if (v.wallet && v.wallet.secret) v.wallet.secret = '***' + String(c.wallet.secret).slice(-4);
    if (v.webhook && v.webhook.secret) v.webhook.secret = '***' + String(c.webhook.secret).slice(-4);
    v.apiKeys = (c.apiKeys || []).map((k) => ({ id: k.id, createdAt: k.createdAt, expiresAt: k.expiresAt, lastUsedAt: k.lastUsedAt }));
    return v;
  }

  newKey(c, graceMs) {                                      // returns the key text; only its hash is kept
    const key = 'hrk_' + c.id + '_' + crypto.randomBytes(24).toString('hex'), t = this.now();
    if (graceMs !== undefined) c.apiKeys.forEach((k) => { if (!k.expiresAt || k.expiresAt > t + graceMs) k.expiresAt = t + graceMs; });
    c.apiKeys.push({ id: 'k' + (Math.max(0, ...c.apiKeys.map((k) => +String(k.id).slice(1) || 0)) + 1), hash: sha(key), createdAt: t, expiresAt: null, lastUsedAt: null });
    return key;
  }
  // creates a client and its first API key (returned once)
  // the wallet secret (what the client's platform uses to verify our signed calls) is generated when not given and returned once
  create(input) {
    input = JSON.parse(JSON.stringify(input || {}));
    if (this.clients.has(input.id)) throw Object.assign(fail('a client with this id exists'), { status: 409, code: 'CLIENT_EXISTS' });
    let walletSecret;
    if (input.wallet && input.wallet.type !== 'mock' && !input.wallet.secret) { walletSecret = crypto.randomBytes(32).toString('hex'); input.wallet.secret = walletSecret; }
    const c = normalize(Object.assign({}, input, { apiKeys: [] }), this._opts()); c.createdAt = c.updatedAt = this.now();
    const apiKey = this.newKey(c); this.clients.set(c.id, c); this.save(); this.wallets.delete(c.id); this.hooks.delete(c.id);
    const out = { client: this.publicView(c), apiKey }; if (walletSecret) out.walletSecret = walletSecret;
    return out;
  }
  update(id, patch) {
    const cur = this.clients.get(id); if (!cur) throw Object.assign(fail('unknown client'), { status: 404, code: 'NOT_FOUND' });
    const merged = JSON.parse(JSON.stringify(cur));
    ['name', 'status', 'currency', 'realityCheckMinutes', 'bigWinMin', 'allowedIps', 'returnUrlHosts', 'limits', 'currencyLimits', 'webhook'].forEach((k) => { if (patch[k] !== undefined) merged[k] = patch[k]; });
    if (patch.wallet) merged.wallet = Object.assign({}, merged.wallet, patch.wallet);
    if (patch.webhook === null) delete merged.webhook;
    const c = normalize(merged, this._opts()); c.createdAt = cur.createdAt; c.updatedAt = this.now();
    this.clients.set(id, c); this.save(); this.wallets.delete(id); this.hooks.delete(id);
    return this.publicView(c);
  }
  setStatus(id, status) { return this.update(id, { status }); }
  // a new key; the old keys keep working for graceMs (default 24 h, 0 = revoke now) so the client can switch over
  rotateKey(id, graceMs) {
    const c = this.clients.get(id); if (!c) throw Object.assign(fail('unknown client'), { status: 404, code: 'NOT_FOUND' });
    const apiKey = this.newKey(c, graceMs === undefined ? 24 * 3600 * 1000 : graceMs); c.updatedAt = this.now(); this.save();
    return { client: this.publicView(c), apiKey };
  }
  revokeKey(id, keyId) {
    const c = this.clients.get(id); if (!c) throw Object.assign(fail('unknown client'), { status: 404, code: 'NOT_FOUND' });
    c.apiKeys = c.apiKeys.filter((k) => k.id !== keyId); c.updatedAt = this.now(); this.save(); return this.publicView(c);
  }
  // new signing secrets (returned once). The client's platform has to switch to the new secret at the same time.
  rotateWalletSecret(id) {
    const c = this.clients.get(id); if (!c) throw Object.assign(fail('unknown client'), { status: 404, code: 'NOT_FOUND' });
    if (c.wallet.type !== 'http') throw fail('this client uses the mock wallet: there is no secret');
    const secret = crypto.randomBytes(32).toString('hex'); c.wallet.secret = secret; c.updatedAt = this.now(); this.wallets.delete(id); this.save();
    return { client: this.publicView(c), walletSecret: secret };
  }
  rotateWebhookSecret(id) {
    const c = this.clients.get(id); if (!c) throw Object.assign(fail('unknown client'), { status: 404, code: 'NOT_FOUND' });
    if (!c.webhook) throw fail('this client has no webhook');
    const secret = crypto.randomBytes(32).toString('hex'); c.webhook.secret = secret; c.updatedAt = this.now(); this.hooks.delete(id); this.save();
    return { client: this.publicView(c), webhookSecret: secret };
  }
  remove(id) { if (!this.clients.delete(id)) throw Object.assign(fail('unknown client'), { status: 404, code: 'NOT_FOUND' }); this.wallets.delete(id); this.hooks.delete(id); this.save(); }

  // Bearer key -> the client, or null. Failed attempts are counted per address (10 in 5 minutes block the address for 5 minutes).
  authenticate(key, ip) {
    const t = this.now(); let f = this.failed.get(ip);
    if (f && f.until > t) return null;
    if (f && t - f.first > 300000) f = undefined;                    // count failures inside a 5 minute window
    const m = /^hrk_([a-z0-9][a-z0-9-]{1,31})_[0-9a-f]{48}$/.exec(String(key || ''));
    let hit = null;
    if (m) {
      const c = this.clients.get(m[1]);
      if (c && c.status === 'active' && ipAllowed(c.allowedIps, ip)) {
        const h = Buffer.from(sha(key));
        for (const k of c.apiKeys) {
          const kb = Buffer.from(k.hash);
          if (kb.length === h.length && crypto.timingSafeEqual(kb, h) && (!k.expiresAt || k.expiresAt > t)) { k.lastUsedAt = t; hit = c; break; }
        }
      }
    }
    if (!hit) {
      const n = (f ? f.n : 0) + 1;
      this.failed.set(ip, { n, first: f ? f.first : t, until: n >= 10 ? t + 300000 : 0 });
      if (this.failed.size > 5000) this.failed.clear();
    } else this.failed.delete(ip);
    return hit;
  }

  walletFor(id) {                                          // the wallet adapter of a client (cached until its config changes)
    const c = this.clients.get(id); if (!c) return null;
    let w = this.wallets.get(id);
    if (!w) {
      w = c.wallet.type === 'mock' ? new MockWallet({ currency: c.currency }) : new HttpWallet({ url: c.wallet.url, key: c.wallet.secret, keyId: c.wallet.keyId, auth: c.wallet.auth, timeout: c.wallet.timeoutMs, currency: c.currency });
      this.wallets.set(id, w);
    }
    return w;
  }
  webhookFor(id) {
    const c = this.clients.get(id); if (!c || !c.webhook) return null;
    let h = this.hooks.get(id);
    if (!h) { h = new Webhook({ url: c.webhook.url, key: c.webhook.secret, keyId: c.webhook.keyId, events: c.webhook.events }); this.hooks.set(id, h); }
    return h;
  }
}

module.exports = { ClientRegistry, normalize, ipAllowed, encrypt, decrypt, ID_RE, DEFAULT_ID };
