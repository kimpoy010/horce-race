# Laravel port of the horse race game

This directory is a Laravel 13 application that replaces the Node server (`../server.js`, `../server/`). It lives next to it so both can run
and be compared. The browser side (`public/*.html`, `css`, `js`, `audio`) is the **same code** as `../public`: it talks to the same
URLs, so the game does not change for the player. `bin/sync-frontend.sh` copies it over.

## Status

| Area | State |
|---|---|
| Odds, RTP table (88-99%), provable-fair draw, odds layout | done, identical to Node for the same seed (`tests/Unit/ParityTest.php`, 40 seeds) |
| Hash-chained ledger (same JSON lines, same hashes; PostgreSQL trigger makes it append-only) | done, Node's `scripts/verify-ledger.js --pg` accepts a ledger written by Laravel |
| Rounds, bets, settlement, payouts, sessions, limits (min/max bet, round stake, daily loss), block list | done |
| Wallets: play money (mock) and the platform's HTTP wallet (HMAC signed, bearer) with retry, rollback of unknown debits, queued credits | done |
| API used by the browser: `/api/public`, `/api/auth`, `/api/me`, `/api/bet`, `/api/history`, `/api/round/{n}`, `/healthz` | done |
| Operator controller: `/api/command` (setRtp, previewRtp, blockPlayer, unblockPlayer), `/api/report`, `/api/admin` | done (controller key) |
| Round loop daemon `php artisan game:run` | done |
| Clients registry (many platforms, per-client wallet / webhook / limits / API keys) and the client API `/api/client/*` | **not yet** |
| Webhooks to the platform (`round.settled`, `big.win`) | **not yet** |
| Back office (`/bo/api`, client staff logins, roles, TOTP) and operator admin console (`/admin/api`) | **not yet** (the HTML/JS pages are copied, the APIs are missing) |
| `/metrics`, alerts, ops snapshot | **not yet** |
| Demo mode (controller-driven races without betting) | not planned: the Laravel app is the live game |

Today the app serves the implicit "default" client of the Node server: one wallet, chosen with `HORSE_WALLET=mock|http`.

## How it works

PHP handles one request at a time, so the round is not kept in memory. Everything shared lives in the database
(`rounds`, `bets`, `game_sessions`, `pending_ops`, `ledger`, `settings`), and two kinds of process use it:

* **web workers** (`php artisan serve`, PHP-FPM, Octane): answer the browser. Placing a bet takes a per-player lock, checks the limits,
  debits the wallet, then, in one transaction with the round row locked, records the bets and the ledger line. If betting closed while the
  wallet was busy the debit is refunded.
* **the daemon** (`php artisan game:run`): the only process that moves rounds forward: opens betting, draws at bet close, settles at the
  end of the race, delivers queued wallet credits and rollbacks. Exactly one may run; a second one waits for the lock
  (`Cache::lock`, use the `database` or `redis` cache store in production). It stops cleanly on SIGTERM.

The ledger events are the same as in Node (`open`, `bet`, `draw`, `settled`, `credit_due`, `credit_ok`, `rollback_due`, ...).
After a restart nothing has to be replayed: the state is in the database and the daemon simply carries on.

## Run it locally

    cd laravel
    composer install
    cp .env.example .env && php artisan key:generate
    # database: SQLite works out of the box; for PostgreSQL set DB_CONNECTION=pgsql, DB_HOST, DB_PORT, DB_DATABASE, DB_USERNAME, DB_PASSWORD
    php artisan migrate
    php artisan game:run                          # terminal 1: the round loop
    PHP_CLI_SERVER_WORKERS=4 php artisan serve     # terminal 2: http://localhost:8000/?token=demo-alice

Settings are in `config/horse.php` (environment names `HORSE_*`): wallet, RTP, bet window, limits, controller key. Play money (the mock
wallet) is refused when `APP_ENV=production`; use `HORSE_WALLET=http` with `HORSE_WALLET_URL` and `HORSE_WALLET_KEY`
(the wallet contract is `../docs/WALLET_API.md`). Set `HORSE_CONTROLLER_KEY` to use `/controller` and `/api/command`.

## Tests

    php artisan test

* `tests/Unit/ParityTest.php`: Node and PHP agree on odds, RTP weights, draws, commits, ledger hashes and request signatures.
  The vectors come from the Node code: `node tests/fixtures/make-parity.cjs` regenerates `tests/fixtures/parity.json`.
* `tests/Feature/GameFlowTest.php`: a whole race (bets, draw, settlement, payout, proof, history), limits, a lost debit answer
  (rollback), a credit that has to be retried, blocking, the controller, health, and ledger lines byte-identical to Node's.

## Known differences from the Node server

* The daily loss limit adds up the bets placed today (UTC) and their payouts; Node counts a payout on the day it is settled.
  They differ only for a race that straddles midnight.
* Sessions and the current round are in the database, so any number of web workers can serve players.
* Draw and odds are unchanged; the ledger chain is the same, but only events of the ported features are written so far.
