# Bingo Pinball - HTTP API and integration

For the game's own page (Phase 4) and for platforms. The maths and the draw are in [MATH.md](MATH.md); the shared services are in [../PLATFORM.md](../PLATFORM.md).

## Switching it on for a client

The game ships **switched off**. A client plays it only when an operator adds it to the client's games list **and** chooses its paytable (the RTP version is an operator's decision; there is no default). In the admin console (client settings) or with `POST /admin/api/clients/<id>`:

```json
{ "client": { "games": ["horse-race", "bingo-pinball"],
              "gameSettings": { "bingo-pinball": { "paytable": 96, "limits": { "minBet": 500, "maxBet": 20000 }, "roundWebhooks": false } } } }
```

* `paytable`: 88, 90, 92, 94 or 96 (required).
* `limits`: optional, narrows the server's minimum and maximum bet for this game. The client's other limits (including the daily loss limit) apply as for the horse race.
* `roundWebhooks`: optional (default `false`): also send a `round.settled` webhook for every play. A `big.win` webhook is always sent for a win of at least the client's `bigWinMin`.

Requirements on the server: `HORSE_CLIENTS_KEY` must be set (the players' secret seeds are stored encrypted with it; without it the game refuses to run) and the round loop (`php artisan game:run`) must be running (it delivers queued credits, rollbacks and webhooks and cancels plays that never finished).

## What a platform does

1. `GET /api/client/games` with the client's API key (`Authorization: Bearer hrk_...`) lists the games the client may offer, each with a `launchUrl`.
2. The platform sends the player to `launchUrl` and adds its launch token: `.../games/bingo-pinball?client=<id>&token=<launch token>`. The game page exchanges it with `POST /api/games/bingo-pinball/auth`, exactly like the horse race, so the wallet's `/session/validate` is called once per launch.
3. Wallet calls (the platform's wallet API, `docs/WALLET_API.md`): for every play a **debit** with `txId = bp:<roundId>:bet` and, for a win, a **credit** with `txId = bp:<roundId>:win`. The body names `gameId: "bingo-pinball"` and `roundId: "bp:<roundId>"`. Both are idempotent on `txId`. When the answer to a debit is lost the game asks the wallet to **roll back** `bp:<roundId>:bet`; the wallet must then refuse a late debit with that id, as for the horse race.
4. Webhooks (`docs/WALLET_API.md`): `big.win` for big wins; `round.settled` for every play only if the client turned `roundWebhooks` on. Their `gameId` is `bingo-pinball` and the event id is `bingo-pinball:<client>:<key>`.

## The player's API

Base `/api/games/bingo-pinball`. JSON in and out. Success is `{"ok": true, ...}`, a refusal is `{"ok": false, "error": CODE}`. After `/auth` the session id is sent as `Authorization: Bearer <session>`. A session belongs to this game only (a horse-race session is refused with `WRONG_GAME`, and the other way round).

| Method and path | Purpose |
|---|---|
| `POST /auth` `{token, client}` | exchange the launch token for a session; answers with the state below |
| `GET /state` | balance, limits, the paytable (pays, card, published RTP), the seed commit and the number of plays under it, and the latest round with `unseen` / `unfinished` flags |
| `POST /play` `{stake, requestId}` | take the stake, draw, settle. `stake` is a whole number of minor units; `requestId` is 8 to 64 letters, digits, `-` or `_`, chosen by the page for every new play |
| `GET /round/{id}`, `GET /history?limit=` | the player's own rounds |
| `POST /round/{id}/seen` | the page has shown the result |
| `POST /seed/rotate` `{clientSeed?}` | reveal the current server seed and start a new pair (optionally with the player's own client seed) |
| `GET /proof/{id}` | everything needed to re-run a play, once its seed pair has been revealed |

A successful `/play` answers `{"ok": true, "round": {...}, "balance": n, "repeat": false}`. A round has `id`, `ref` (`bp:<id>`), `status`, `stake`, `holes` (the five holes in the order the balls end in them), `bestLit`, `bestLine`, `bestLineName`, `multiple`, `payout`, `nonce`, `paytable {id, version}`, `creditPending` (the win is still being sent to the platform) and `seen`.

### Rules the server enforces

* The result is drawn **only after** the wallet has confirmed the debit, and it is saved together with its ledger lines and the queued credit: whatever happens to the connection, `/state` and `/round/{id}` show it.
* One money action per player at a time (the horse race's lock): a play that finds the player busy answers `429 TOO_MANY_REQUESTS`.
* At least 3 seconds between two plays of a player: `429 TOO_FAST`.
* A repeated `requestId` returns the round that exists (`"repeat": true`) and never debits twice. If that play was void: `409 ROUND_VOID`; if it is still being processed: `409 ROUND_IN_PROGRESS`.
* The plunger is decoration. Nothing the page sends besides the stake and the request id can influence the result.
* After a play's seed pair has been used for 1,000 plays the pair is replaced automatically and the old server seed is revealed.

### Error codes

| Code | HTTP | Meaning |
|---|---|---|
| `SESSION_EXPIRED` | 401 | no session, expired, blocked, or its client was disabled |
| `WRONG_GAME` | 403 | the session belongs to another game |
| `GAME_NOT_ENABLED` | 403 | the client does not have this game (also: before the launch token is used up) |
| `GAME_NOT_CONFIGURED` | 409 / 503 | the client has no paytable (409), or the server has no `HORSE_CLIENTS_KEY` (503) |
| `PLAYER_BLOCKED` | 403 | the player is blocked |
| `BAD_REQUEST`, `BAD_BET` | 400 | malformed request; stake outside the minimum and maximum |
| `DAILY_LOSS_LIMIT` | 400 | the play would take the player's net loss today (both games) above the limit |
| `INSUFFICIENT_FUNDS` | 402 | the wallet refused for lack of funds; nothing was charged |
| `WALLET_REJECTED` | 502 | the wallet refused the debit; nothing was charged |
| `WALLET_UNAVAILABLE` | 502 | no answer from the wallet: the play is void and the debit is being rolled back |
| `TOO_FAST`, `TOO_MANY_REQUESTS` | 429 | less than 3 s since the last play; the player is busy with another request |
| `ROUND_VOID`, `ROUND_IN_PROGRESS` | 409 | answer to a repeated `requestId` |
| `NOT_FOUND`, `NOT_SETTLED`, `SEED_NOT_REVEALED` | 404 / 409 | a round that is not the player's; a play with no result; a proof asked for while its seed is still secret |
| `BAD_CLIENT_SEED` | 400 | a client seed must be 1 to 64 letters, digits, `-` or `_` |

### What the page must do (Phase 4)

* Send a **new** `requestId` for every new play and the **same** one when it repeats a play it is not sure about (a timeout): the answer is then the same round, never a second debit.
* After a page reload call `/state` first: if `unseen` is true show `last` again (the result is already decided and saved), then `POST /round/{id}/seen`; if `unfinished` is true wait and ask again.
* Treat `WALLET_UNAVAILABLE` as "the play did not happen": the balance is restored by the rollback.

## Ledger and monitoring

Events written to the one hash-chained ledger, each with `"game": "bingo-pinball"`: `seed.commit`, `seed.reveal` (with the revealed server seed), `bp.play`, `bp.settled`, `bp.void`, and the shared `credit_due` / `credit_ok` / `rollback_due` / `rollback_ok` / `debit_unknown`. Plays that were taken but never drawn (the process died in between) are found by the round loop after 30 seconds, rolled back and voided (`bp.void`, `reason: stuck`).

Note for monitoring: queued credits and rollbacks of Bingo Pinball are in the same `pending_ops` queue as the horse race's, so the existing pending counters include them (per-game metrics come in Phase 5).
