# Wallet / platform API

The game server never holds player money. It asks **your platform** to validate the launch token and to debit and credit
the player's wallet. Set `WALLET=http`, `WALLET_URL=https://platform.example.com/horse-api` and `WALLET_KEY=<secret>`.
Every request is `POST`, JSON, with the header `Authorization: Bearer <WALLET_KEY>`.

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
Request: `{ "playerId": "p-123", "amount": 5000, "txId": "bet:42:9f2c...", "meta": { "raceNo": 42, "kind": "bet", "stake": 5000, "fee": 0 } }`
`amount` is stake + fee (the fee is only used when the RTP setting is below 86.84%).
Reply: `{ "ok": true, "balance": 245000 }`. If the balance is too low: HTTP 402 / `{ "ok": false, "error": "INSUFFICIENT_FUNDS" }`.

### `POST /wallet/credit`  (a win or a refund)
Request: `{ "playerId": "p-123", "amount": 1250000, "txId": "win:42:p-123", "meta": { "raceNo": 42, "kind": "win" } }`
Reply: `{ "ok": true, "balance": 312500 }`. `kind` is `win` or `refund`.

## Rules your wallet must follow

* **Idempotent on `txId`.** The same `txId` sent twice must be applied once and return the same reply. The game server
  retries after timeouts and after restarts, and relies on this to never double-charge or double-pay.
* A debit that timed out may or may not have been applied. The game retries it once with the same `txId`; if it still
  fails the bet is rejected and logged as `debit_unknown` in `data/ledger.jsonl` for reconciliation (match on `txId`).
* Credits that fail are retried forever with back-off (`pendingCredits` in the controller report).
* Keep `WALLET_KEY` secret and serve the wallet API over HTTPS only.

## Testing without a platform

`GAME_MODE=live WALLET=mock node server.js` starts the game with an in-memory play-money wallet.
Open `http://localhost:8080/?token=demo-alice` (any `demo-<name>` works, each starts with 10,000.00).
