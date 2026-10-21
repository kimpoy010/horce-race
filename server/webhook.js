'use strict';
/*
 * Server-to-server events to the platform (at least once, signed like the wallet calls, see docs/WALLET_API.md).
 *
 *   POST WEBHOOK_URL   { id, type, createdAt, gameId, data }       (id is unique and stable: de-duplicate on it)
 *   types: round.settled  (every race: result, odds, draw proof, totals)
 *          big.win        (a player's payout in one race >= BIG_WIN_MIN minor units)
 * Any 2xx reply means "received"; anything else is retried with back-off.
 */
const sign = require('./sign.js');

class Webhook {
  constructor(opts) {
    this.url = opts.url; this.key = opts.key; this.keyId = opts.keyId || ''; this.timeout = opts.timeout || 8000;
    this.events = new Set((opts.events || 'round.settled,big.win').split(',').map((x) => x.trim()).filter(Boolean));
  }
  wants(type) { return this.events.has(type); }
  async send(ev) {
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), this.timeout), text = JSON.stringify(ev);
    const headers = Object.assign({ 'content-type': 'application/json' }, sign.signedHeaders(this.key, this.keyId, 'POST', new URL(this.url).pathname, text));
    try {
      const res = await fetch(this.url, { method: 'POST', headers, body: text, signal: ctl.signal });
      if (!res.ok) throw new Error('HTTP_' + res.status);
    } finally { clearTimeout(timer); }
  }
}

function create(env) {
  if (!env.WEBHOOK_URL) return null;
  const key = env.WEBHOOK_KEY || env.WALLET_KEY;
  if (!key || key.length < 16) throw new Error('WEBHOOK_URL needs WEBHOOK_KEY (or WALLET_KEY), at least 16 characters');
  return new Webhook({ url: env.WEBHOOK_URL, key, keyId: env.WEBHOOK_KEY_ID || env.WALLET_KEY_ID, events: env.WEBHOOK_EVENTS, timeout: +env.WEBHOOK_TIMEOUT_MS || 8000 });
}

module.exports = { Webhook, create };
