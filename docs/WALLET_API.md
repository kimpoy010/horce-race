# Wallet / platform API

The game server never holds player money. It asks **your platform** to validate the launch token and to debit and credit
the player's wallet. Set `WALLET=http`, `WALLET_URL=https://platform.example.com/horse-api` and `WALLET_KEY=<secret>`
(at least 16 random characters, for example `openssl rand -hex 32`; optional `WALLET_KEY_ID` to help you rotate keys).
Every request is `POST`, JSON, and **signed** (next section).

## Request signing (HMAC)

The game sends these headers on every call:

| Header | Value |
|---|---|
| `X-Timestamp` | unix time in milliseconds |
| `X-Nonce` | random hex, different for every request |
| `X-Signature` | hex `HMAC-SHA256(WALLET_KEY, timestamp + "\n" + nonce + "\n" + "POST" + "\n" + path + "\n" + sha256hex(rawBody))` |
| `X-Key-Id` | your `WALLET_KEY_ID`, when set |

`path` is the URL path your server receives (for example `/horse-api/wallet/debit`), `rawBody` is the JSON text exactly as received.
Your platform must **reject** a request when the signature does not match, when the timestamp is more than 5 minutes off,
or when the nonce was already used inside that window. A reference implementation is `Verifier` in `server/sign.js`
(about 20 lines, easy to port). Also allow only the game server's IP address on your side and use HTTPS.

```js
const { Verifier } = require('./server/sign.js');          // copy server/sign.js to your service
const verifier = new Verifier(process.env.WALLET_KEY);
// in your handler (lower-case header names, raw body text):
const r = verifier.verify(req.headers, req.method, new URL(req.url, 'http://x').pathname, rawBody);
if (!r.ok) return res.writeHead(401).end(JSON.stringify({ ok: false, error: r.error }));
```

`WALLET_AUTH=bearer` switches back to the old `Authorization: Bearer <WALLET_KEY>` header (not recommended, only for platforms
that cannot verify signatures yet).

All amounts are **integers in minor units** (centavos). A reply is `{ "ok": true, ... }`. For a refusal reply with HTTP 4xx
(or `{"ok": false, "error": "CODE"}`); use the error code `INSUFFICIENT_FUNDS` when the player is short.

## Launch (redirect)

1. The player clicks "Horse Race" in your lobby.
2. Your backend creates a **one-time launch token** (random, short lived, tied to the player) and redirects the browser to
   `https://GAME_HOST/?token=<token>`.
3. The game server calls `POST /session/validate` and then keeps its own session; the token is removed from the browser URL.

## Endpoints you implement

### `POST /session/validate`
Request: `{ "token": "..." }`
Reply: `{ "ok": true, "playerId": "p-123", "currency": "PHP", "balance": 250000, "returnUrl": "https://lobby.example.com" }`
Mark the token as used. An invalid or used token must return `ok:false` (HTTP 401).

### `POST /wallet/balance`
Request: `{ "playerId": "p-123" }` -> Reply: `{ "ok": true, "balance": 250000 }`

### `POST /wallet/debit`  (a bet)
Request: `{ "playerId": "p-123", "amount": 5000, "txId": "bet:42:9f2c...", "meta": { "raceNo": 42, "kind": "bet" } }`
Reply: `{ "ok": true, "balance": 245000 }`. If the balance is too low: HTTP 402 / `{ "ok": false, "error": "INSUFFICIENT_FUNDS" }`.

### `POST /wallet/credit`  (a win or a refund)
Request: `{ "playerId": "p-123", "amount": 1250000, "txId": "win:42:p-123", "meta": { "raceNo": 42, "kind": "win" } }`
Reply: `{ "ok": true, "balance": 312500 }`. `kind` is `win` or `refund`.

### `POST /wallet/rollback`  (cancel a debit whose result is unknown)
Request: `{ "playerId": "p-123", "amount": 5000, "txId": "bet:42:9f2c...", "rollbackTxId": "rollback:bet:42:9f2c...", "meta": { "raceNo": 42, "kind": "rollback" } }`
Reply: `{ "ok": true, "balance": 250000, "status": "rolled_back" | "not_found" | "already_rolled_back" }`.
`txId` is the debit to cancel. If it was applied, reverse it. **Either way, remember the `txId` as cancelled**: a debit with
that `txId` that arrives later (a delayed retry) must be refused (HTTP 409, `TX_ROLLED_BACK`). Must be idempotent.

## Rules your wallet must follow

* **Idempotent on `txId`.** The same `txId` sent twice must be applied once and return the same reply. The game server
  retries after timeouts and after restarts, and relies on this to never double-charge or double-pay.
* A debit that timed out may or may not have been applied. The game retries it once with the same `txId`; if it still
  fails the bet is rejected, logged as `debit_unknown`, and the game calls `/wallet/rollback` for that `txId` (retried with
  back-off until it succeeds, also after a restart; see `pendingRollbacks` in the controller report). If your platform does not
  implement `/wallet/rollback` (HTTP 404/405/501) the game stops retrying and the case stays in `data/ledger.jsonl` for manual
  reconciliation (match on `txId`).
* Credits that fail are retried forever with back-off (`pendingCredits` in the controller report).
* Keep `WALLET_KEY` secret and serve the wallet API over HTTPS only.

## Testing without a platform

`ALLOW_MOCK_WALLET=1 GAME_MODE=live WALLET=mock node server.js` starts the game with an in-memory play-money wallet. In live mode the
mock wallet is refused unless `ALLOW_MOCK_WALLET=1` is set, and refused always when `NODE_ENV=production`.
Open `http://localhost:8080/?token=demo-alice` (any `demo-<name>` works, each starts with 10,000.00).
