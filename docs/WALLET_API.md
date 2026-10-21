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

## Several platforms (clients)

One game server can serve many platforms. Each one is registered as a **client** with its own wallet URL, signing secret, API key and webhook; see `CLIENT_API.md`.
The launch link then carries the client id: `https://GAME_HOST/?client=acme&token=<token>`. Everything below applies to each client's wallet separately; the `WALLET_*`
settings describe the implicit `default` client used when no registry entry exists.

## Launch (redirect)

1. The player clicks "Horse Race" in your lobby.
2. Your backend creates a **one-time launch token** (random, short lived, tied to the player) and redirects the browser to
   `https://GAME_HOST/?client=<your client id>&token=<token>` (`client` can be left out when the game serves a single platform).
3. The game server calls `POST /session/validate` and then keeps its own session; the token is removed from the browser URL.

## Endpoints you implement

### `POST /session/validate`
Request: `{ "token": "..." }`
Reply: `{ "ok": true, "playerId": "p-123", "currency": "PHP", "balance": 250000, "returnUrl": "https://lobby.example.com" }`
Mark the token as used. An invalid or used token must return `ok:false` (HTTP 401).

Optional fields in the same reply, to run several brands and currencies from one game server and to apply your own rules per player:

| Field | Meaning |
|---|---|
| `brandId` | your brand / operator id; copied to every wallet call, the ledger, history and webhooks |
| `currency`, `decimals` | per player currency and its decimals (2 for PHP/USD, 0 for JPY); the board and the amounts follow it |
| `limits` | `{ minBet, maxBet, maxRoundStake, dailyLossLimit }` in minor units, overriding the server defaults for this player (`dailyLossLimit` = most the player may lose in a UTC day: stakes minus wins, `0` = none) |
| `realityCheckMinutes` | show a reality check every N minutes (time played and result so far, with a leave button) |
| `blocked` | `true` refuses the launch (`PLAYER_BLOCKED`), for self-excluded players |

Server defaults: `DAILY_LOSS_LIMIT`, `REALITY_CHECK_MIN`, and `CURRENCY_LIMITS='{"JPY":{"minBet":100,"maxBet":50000,"maxRoundStake":1000000,"decimals":0}}'`
(a per-currency table; what your reply sends wins over the table, the table wins over the global defaults).

### Fields on every debit, credit and rollback

Besides `playerId`, `amount` and `txId`, each call carries (also repeated inside `meta`):

| Field | Meaning |
|---|---|
| `gameId` | `horse-race` |
| `transactionType` | `bet`, `win`, `refund` or `rollback` |
| `roundId` | the race number as text, the same id used by the history API and the webhooks |
| `betId` / `betIds` | the bet batch id of a debit; for a win the winning bet ids (`<betId>:<pair>`) |
| `refTxId` | the debit a refund or rollback belongs to |
| `currency`, `brandId` | of the player's session |

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

## Player history and draw proof

* `GET /api/history?limit=15` with `Authorization: Bearer <game session>`: the player's last races with every bet
  (`betId`, pair, stake, odds, `status` open / won / lost / refunded, payout, currency, brand).
* `GET /api/admin/history?playerId=p-123&limit=50` with `X-Controller-Key`: the same for your support team or back office.
* `GET /api/round/42`: the draw proof of a finished race (public, the seed is revealed once the race is over):
  `{ commit, seed, odds, rtp, combo, order }`. To verify: `sha256(seed) == commit`; the odds layout is `oddsLayout(seed, raceNo, values)`
  and the result is `draw(seed, raceNo, weights)` with the weights from `buildForRtp(odds, rtp)` (functions in `server/rng.js` and `server/odds.js`).
  The winning pair always finishes in the order it is written (`1-2`: horse 1 first, horse 2 second). Races run before this rule picked the order of the two at random;
  the pair, and so every payout, is the same either way, and the order of the other four horses is unchanged.

## Operator commands (header `X-Controller-Key`, `POST /api/command`)

| Command | Effect |
|---|---|
| `{ "cmd": "closeSessions", "playerId": "p-123" }` | ends all game sessions of the player |
| `{ "cmd": "blockPlayer", "playerId": "p-123" }` | ends the sessions and refuses new ones (kept in `data/blocked.json`, survives restarts) |
| `{ "cmd": "unblockPlayer", "playerId": "p-123" }` | lifts the block |
| `{ "cmd": "setRtp", "rtp": 0.93 }` | RTP setting, 88% to 99%, from the next race |

## Webhooks (game -> platform)

Set `WEBHOOK_URL=https://platform.example.com/horse-events` (signed like the wallet calls with `WEBHOOK_KEY`, default `WALLET_KEY`;
`WEBHOOK_EVENTS=round.settled,big.win` chooses the events; `BIG_WIN_MIN` is the payout, in minor units, that counts as a big win,
default 1,000,000). Request: `POST` JSON `{ "id": "horse-race:round:42", "type": "round.settled", "createdAt": 1700000000000, "gameId": "horse-race", "data": {...} }`.

| Type | When | `data` |
|---|---|---|
| `round.settled` | every race, after settlement | `roundId`, `combo`, `order`, `odds`, `oddsOfWinner`, `rtp`, `commit`, `seed`, `bets`, `staked`, `paid` |
| `big.win` | a player's payout in one race >= `BIG_WIN_MIN` | `roundId`, `playerId`, `brandId`, `currency`, `stake`, `payout`, `odds`, `betIds` |

Reply any 2xx for "received". Anything else is retried with back-off until it is accepted (also after a restart, from the ledger), so
an event can arrive more than once: **de-duplicate on `id`** (it is stable). Verify the signature and the timestamp like the wallet calls.
