'use strict';
/*
 * Wallet adapters. All amounts are integers in minor units (e.g. centavos).
 * A wallet must be idempotent on txId: sending the same debit/credit twice must apply it once.
 *
 *   validateToken(token) -> { playerId, currency, balance, returnUrl? }   (throws on an invalid token)
 *   debit(playerId, amount, txId, meta)  -> { balance }                     (throws Error('INSUFFICIENT_FUNDS') if short)
 *   credit(playerId, amount, txId, meta) -> { balance }
 *   balance(playerId) -> balance
 */

class MockWallet {
  constructor(opts) {
    opts = opts || {};
    this.accounts = new Map(); this.tx = new Map();
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
    if (this.tx.has(txId)) return { balance: this.accounts.get(id) };
    const bal = this.accounts.get(this._acct(id));
    if (bal < amount) throw new Error('INSUFFICIENT_FUNDS');
    this.accounts.set(id, bal - amount); this.tx.set(txId, -amount);
    return { balance: bal - amount };
  }
  async credit(id, amount, txId) {
    if (this.tx.has(txId)) return { balance: this.accounts.get(id) };
    const bal = this.accounts.get(this._acct(id));
    this.accounts.set(id, bal + amount); this.tx.set(txId, amount);
    return { balance: bal + amount };
  }
}

// Talks to the operator's platform over HTTPS/JSON, see docs/WALLET_API.md
class HttpWallet {
  constructor(opts) { this.url = opts.url.replace(/\/$/, ''); this.key = opts.key; this.timeout = opts.timeout || 8000; this.currency = opts.currency; }
  async _post(path, body) {
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), this.timeout);
    try {
      const res = await fetch(this.url + path, {
        method: 'POST', signal: ctl.signal,
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + this.key },
        body: JSON.stringify(body)
      });
      let data = {};
      try { data = await res.json(); } catch (e) { /* not json */ }
      if (!res.ok || data.ok === false) { const err = new Error(data.error || ('HTTP_' + res.status)); err.status = res.status; err.definitive = res.status >= 400 && res.status < 500; throw err; }
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
}

function create(env) {
  if ((env.WALLET || 'mock') === 'http') {
    if (!env.WALLET_URL || !env.WALLET_KEY) throw new Error('WALLET=http needs WALLET_URL and WALLET_KEY');
    return new HttpWallet({ url: env.WALLET_URL, key: env.WALLET_KEY, timeout: +env.WALLET_TIMEOUT_MS || 8000, currency: env.CURRENCY });
  }
  return new MockWallet({ currency: env.CURRENCY });
}

module.exports = { MockWallet, HttpWallet, create };
