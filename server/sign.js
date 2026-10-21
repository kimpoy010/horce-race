'use strict';
/*
 * Request signing between the game server and the platform wallet (HMAC-SHA256).
 *
 * The game sends, on every wallet call:
 *   X-Key-Id      optional id of the shared secret (lets the platform rotate keys)
 *   X-Timestamp   unix time in milliseconds
 *   X-Nonce       random hex, unique per request
 *   X-Signature   hex HMAC-SHA256(secret, timestamp + "\n" + nonce + "\n" + METHOD + "\n" + path + "\n" + sha256hex(body))
 * `path` is the URL path the platform receives (for example /horse-api/wallet/debit), `body` the raw JSON text.
 *
 * The platform checks the signature, that the timestamp is within a few minutes, and that the nonce was not seen before
 * (use Verifier below as a reference, or port it: it is about 20 lines).
 */
const crypto = require('crypto');

function canonical(ts, nonce, method, path, body) {
  return ts + '\n' + nonce + '\n' + String(method).toUpperCase() + '\n' + path + '\n' + crypto.createHash('sha256').update(body || '').digest('hex');
}
function signature(secret, ts, nonce, method, path, body) {
  return crypto.createHmac('sha256', secret).update(canonical(ts, nonce, method, path, body)).digest('hex');
}
function signedHeaders(secret, keyId, method, path, body, now) {
  const ts = String(now === undefined ? Date.now() : now), nonce = crypto.randomBytes(16).toString('hex');
  const h = { 'x-timestamp': ts, 'x-nonce': nonce, 'x-signature': signature(secret, ts, nonce, method, path, body) };
  if (keyId) h['x-key-id'] = keyId;
  return h;
}

class Verifier {
  constructor(secret, opts) {
    opts = opts || {};
    this.secret = secret; this.skewMs = opts.skewMs || 5 * 60 * 1000; this.now = opts.now || Date.now; this.seen = new Map();
  }
  // headers: lower-case header object, returns { ok: true } or { ok: false, error }
  verify(headers, method, path, body) {
    const ts = String(headers['x-timestamp'] || ''), nonce = String(headers['x-nonce'] || ''), sig = String(headers['x-signature'] || '');
    if (!ts || !nonce || !sig) return { ok: false, error: 'MISSING_SIGNATURE' };
    if (!(Math.abs(this.now() - Number(ts)) <= this.skewMs)) return { ok: false, error: 'STALE_TIMESTAMP' };
    const want = Buffer.from(signature(this.secret, ts, nonce, method, path, body)), got = Buffer.from(sig);
    if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return { ok: false, error: 'BAD_SIGNATURE' };
    for (const [n, t] of this.seen) if (this.now() - t > this.skewMs) this.seen.delete(n);     // forget nonces older than the window
    if (this.seen.has(nonce)) return { ok: false, error: 'REPLAYED_NONCE' };
    this.seen.set(nonce, this.now());
    return { ok: true };
  }
}

module.exports = { canonical, signature, signedHeaders, Verifier };
