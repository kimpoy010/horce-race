# Bingo Pinball 16 - HTTP API and integration

Same conventions as Bingo Pinball ([../bingo/API.md](../bingo/API.md)); the rules and the draw are in [MATH.md](MATH.md). Base `/api/games/bingo-pinball-16`; the page (Phase D) is `/games/bingo-pinball-16`.

## Switching it on

The game ships **switched off**. A client plays it when it is in the client's games list (admin console, client, Games, or `POST /admin/api/clients/<id>` with `"games": ["horse-race", "bingo-pinball-16"]`), or for every client with `BINGO16_DEFAULT_ON=true`. There is no paytable to choose (one version, `b16-v90-1`). `gameSettings["bingo-pinball-16"]` takes `limits` and `roundWebhooks` like Bingo Pinball. Requirements: `HORSE_CLIENTS_KEY` set, the round loop running (`php artisan game:run`), `php artisan migrate` run.

## Player API

`POST /auth {token, client}`, `GET /state`, `POST /play {stake, requestId}`, `GET /round/{id}`, `GET /history`, `POST /round/{id}/seen`, `POST /seed/rotate`, `GET /proof/{id}`; errors as in Bingo Pinball.

`/state`: balance, limits, `paytable` (`id b16-v90-1`, 16 balls, 16 slots, the five patterns and their multiples), `jackpot` (`{amount, currency, wins, contributionBp}`, null when the player's currency has no jackpot), the seed commit, and the latest round with `unseen` / `unfinished`.

A play answers `{"ok": true, "round": {...}, "balance": n, "repeat": false}`. A round has `id`, `ref` (`b16:<id>`), `status`, `stake`, `balls` (16 numbers: the slot 1-16 each ball ended in, 0 = drained OUT), `jackpotNumbers` (5), `lit` (the lit cells), `pattern` / `patternName`, `multiple`, `jackpotLit` (0-5), `jackpot` (true when all five are lit), `patternPay`, `jackpotPaid`, `payout` (patternPay + jackpotPaid), `nonce`, `creditPending`, `seen`.

## Money

Wallet calls: debit `b16:<id>:bet` (rolled back when its answer is lost) and one credit `b16:<id>:win` for the pattern pay and the jackpot together; both idempotent on `txId`, with `gameId: "bingo-pinball-16"`. Webhooks: `big.win` for a jackpot and for any win of at least the client's `bigWinMin`; `round.settled` for every play only if the client turned `roundWebhooks` on.

## The jackpot pool

One pool per currency for the whole server (this release: PHP; `BINGO16_JACKPOT_CURRENCIES`). Table `jackpot_pools`. Each play locks the pool row inside its own transaction, adds `floor(stake x 148 / 10,000)` and, when all five jackpot numbers are lit, pays the whole pool and restarts it from the seed (`BINGO16_JACKPOT_SEED`, default 100.00, paid by the operator). Invariant, always: `amount = seeded + contributed - paid`. Ledger events (hash-chained, `"game": "bingo-pinball-16"`): `seed.commit`, `seed.reveal`, `b16.play`, `b16.settled`, `b16.void`, `jackpot.seed`, `jackpot.add`, `jackpot.win`, and the shared `credit_due` / `credit_ok` / `rollback_due` / `rollback_ok`.

Because the pool is shared, a client's players are paid jackpots funded partly by other clients' players; settle that with the platforms as the operator's agreement requires.
