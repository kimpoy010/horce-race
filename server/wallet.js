'use strict';
/*
 * Wallet adapters. All amounts are integers in minor units (e.g. centavos).
 * A wallet must be idempotent on txId: sending the same debit/credit twice must apply it once.
 *
 *   validateToken(token) -> { playerId, currency, balance, returnUrl? }   (throws on an invalid token)
 *   debit(playerId, amount, txId, meta)  -> { balance }                     (throws Error('INSUFFICIENT_FUNDS') if short)
 *   credit(playerId, amount, txId, meta) -> { balance }
 *   balance(playerId) -> balance
 *   rollback(playerId, txId, meta) -> { balance }   (optional) cancel a debit whose outcome is unknown; the wallet must also refuse
 *                                                     a debit with that txId that arrives later
 */

const sign = require('./sign.js');

class MockWallet {
  constructor(opts) {
    opts = opts || {};
    this.accounts = new Map(); this.tx = new Map(); this.cancelled = new Set();
    this.startBalance = opts.startBalance || 1000000; this.currency = opts.currency || 'PHP';
  }
  _acct(id) { if (!this.accounts.has(id)) this.accounts.set(id, this.startBalance); return id; }
  async validateToken(token) {
    const m = /^demo-([a-z0-9_]{1,32})$/i.exec(String(token || ''));
    if (!m) throw new Error('INVALID_TOKEN');
    const id = m[1].toLowerCase(); this._acct(id);
    return { playerId: id, currency: this.currency, balance: this.accounts.get(id) };
  }
  async balance(id) { return this.accounts.get(this._acct(id)); }
  async debit(id, amount, txId) {
    if (this.cancelled.has(txId)) throw Object.assign(new Error('TX_ROLLED_BACK'), { definitive: true });
    if (this.tx.has(txId)) return { balance: this.accounts.get(id) };
    const bal = this.accounts.get(this._acct(id));
    if (bal < amount) throw new Error('INSUFFICIENT_FUNDS');
    this.accounts.set(id, bal - amount); this.tx.set(txId, -amount);
    return { balance: bal - amount };
  }
  async rollback(id, amount, txId) {
    if (this.cancelled.has(txId)) return { balance: this.accounts.get(this._acct(id)), status: 'already_rolled_back' };
    this.cancelled.add(txId);
    const was = this.tx.get(txId);
    if (was === undefined) return { balance: this.accounts.get(this._acct(id)), status: 'not_found' };
    this.accounts.set(id, this.accounts.get(this._acct(id)) - was); this.tx.delete(txId);
    return { balance: this.accounts.get(id), status: 'rolled_back' };
  }
  async credit(id, amount, txId) {
    if (this.tx.has(txId)) return { balance: this.accounts.get(id) };
    const bal = this.accounts.get(this._acct(id));
    this.accounts.set(id, bal + amount); this.tx.set(txId, amount);
    return { balance: bal + amount };
  }
}

// Talks to the operator's platform over HTTPS/JSON, see docs/WALLET_API.md
// auth 'hmac' (default): every request is signed (server/sign.js); 'bearer': the shared secret is sent as a Bearer token
class HttpWallet {
  constructor(opts) {
    this.url = opts.url.replace(/\/$/, ''); this.key = opts.key; this.keyId = opts.keyId || ''; this.auth = opts.auth || 'hmac';
    this.timeout = opts.timeout || 8000; this.currency = opts.currency;
  }
  async _post(path, body) {
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), this.timeout);
    const text = JSON.stringify(body), headers = { 'content-type': 'application/json' };
    if (this.auth === 'bearer') headers.authorization = 'Bearer ' + this.key;
    else Object.assign(headers, sign.signedHeaders(this.key, this.keyId, 'POST', new URL(this.url + path).pathname, text));
    try {
      const res = await fetch(this.url + path, { method: 'POST', signal: ctl.signal, headers, body: text });
      let data = {};
      try { data = await res.json(); } catch (e) { /* not json */ }
      if (!res.ok || data.ok === false) {
        const err = new Error(data.error || ('HTTP_' + res.status)); err.status = res.status; err.definitive = res.status >= 400 && res.status < 500;
        err.unsupported = res.status === 404 || res.status === 405 || res.status === 501; throw err;
      }
      return data;
    } finally { clearTimeout(timer); }
  }
  async validateToken(token) {
    const d = await this._post('/session/validate', { token });
    return { playerId: String(d.playerId), currency: d.currency || this.currency || 'PHP', balance: d.balance, returnUrl: d.returnUrl };
  }
  async balance(playerId) { return (await this._post('/wallet/balance', { playerId })).balance; }
  async debit(playerId, amount, txId, meta) { return this._post('/wallet/debit', { playerId, amount, txId, meta }); }
  async credit(playerId, amount, txId, meta) { return this._post('/wallet/credit', { playerId, amount, txId, meta }); }
  async rollback(playerId, amount, txId, meta) { return this._post('/wallet/rollback', { playerId, amount, txId, rollbackTxId: 'rollback:' + txId, meta }); }
}

function create(env) {
  if ((env.WALLET || 'mock') === 'http') {
    if (!env.WALLET_URL || !env.WALLET_KEY) throw new Error('WALLET=http needs WALLET_URL and WALLET_KEY');
    const auth = env.WALLET_AUTH || 'hmac';
    if (auth !== 'hmac' && auth !== 'bearer') throw new Error('WALLET_AUTH must be hmac or bearer');
    if (env.WALLET_KEY.length < 16) throw new Error('WALLET_KEY is too short: use at least 16 random characters (openssl rand -hex 32)');
    return new HttpWallet({ url: env.WALLET_URL, key: env.WALLET_KEY, keyId: env.WALLET_KEY_ID, auth, timeout: +env.WALLET_TIMEOUT_MS || 8000, currency: env.CURRENCY });
  }
  // the mock wallet gives free play money to anyone who opens ?token=demo-<name>: never in production
  if (env.GAME_MODE === 'live') {
    if (env.NODE_ENV === 'production') throw new Error('The mock wallet is not allowed when NODE_ENV=production. Set WALLET=http.');
    if (env.ALLOW_MOCK_WALLET !== '1') throw new Error('GAME_MODE=live needs WALLET=http. For local testing with play money set ALLOW_MOCK_WALLET=1 (never in production).');
  }
  return new MockWallet({ currency: env.CURRENCY });
}

module.exports = { MockWallet, HttpWallet, create };
