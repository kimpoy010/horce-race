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
| Clients registry: many platforms, each with its own wallet, webhook, currency, limits, reality check, IP allow list, return-link hosts, API keys (hashed, rotation with a grace time) | done |
| Client API `/api/client/{info,report,history,players/block,players/unblock,players/close-sessions}`; wrong keys block the address after 10 tries | done |
| Operator registry API `/api/clients*` (X-Controller-Key) and `php artisan clients ...`; every change goes to the ledger | done |
| Per-client players (`client:player` keys), wallets, limits, `?client=` launch, a disabled client ends its sessions | done |
| Webhooks to the platform (`round.settled`, `big.win`), signed, at least once with retries | done |
| Taking over the Node server's clients (`php artisan clients import data/clients.json`, same key) | done: secrets and API keys carry over |
| Back office `/backoffice` (`/bo/api`): login with client + user + password (+ authenticator code), roles viewer / support / admin, cookie sessions with CSRF token, Origin check, idle (30 min) and absolute (12 h) timeouts, throttling, players, races, reports, CSV export, user management, API key rotation, audit log | done |
| Operator admin console `/admin` (`/admin/api`): overview (health, game numbers, RTP, clients), RTP setting, clients and their keys / secrets, client users, own staff, audit log | done |
| Staff accounts: `php artisan staff ...` and the operator calls `/api/clients/{id}/users...` | done |
| Wallet call timings per client, payouts-vs-odds z-score, ledger check, queue ages (what the overview shows) | done |
| `/metrics` (Prometheus text format, controller key as `X-Controller-Key` or Bearer): game, queues, ledger, RTP z-score, per-client money, wallet call counters and latency histograms | done |
| Alerts: ledger chain broken, round loop stopped, credits / rollbacks / webhooks stuck, wallet failing or slow (per client), RTP drift, low disk; firing, repeated and resolved, to the log and `HORSE_ALERT_WEBHOOK_URL` (Slack / Teams / Discord style) | done |
| Demo mode (controller-driven races without betting) | not planned: the Laravel app is the live game |

Like the Node server it has the implicit "default" client (`HORSE_WALLET=mock|http`) next to the registry clients; `HORSE_WALLET=none` runs with
registry clients only. Onboarding a client: see `../docs/CLIENT_API.md` (the Laravel commands are `php artisan clients add acme ...`, the calls and the
launch link `/?client=acme&token=...` are the same).

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
* `tests/Feature/BackOfficeTest.php` and `AdminConsoleTest.php`: login, cookie flags, CSRF and Origin, roles, throttling, forced password change, TOTP (RFC 6238
  vectors, a code works once), disabled users and clients, one client never sees another's players, CSV neutralising, user management rules, the admin
  console's clients / keys / RTP / staff, the `staff` command. The whole suite also passes on PostgreSQL:
  `DB_CONNECTION=pgsql DB_HOST=127.0.0.1 DB_DATABASE=horserace_test DB_USERNAME=... php artisan test` (SQLite is the default for speed).
* `tests/Feature/ClientsTest.php`: the registry (validation, keys and rotation, IP allow list, brute-force block, encryption in the Node format, import of a Node `clients.json`),
  two clients side by side with their own wallets, limits, webhooks and return links, the client API and the operator calls.
* `tests/Feature/GameFlowTest.php`: a whole race (bets, draw, settlement, payout, proof, history), limits, a lost debit answer
  (rollback), a credit that has to be retried, blocking, the controller, health, and ledger lines byte-identical to Node's.

## Operations: metrics and alerts

* `GET /metrics` for Prometheus (same metric names as the Node server; the process metrics describe the round loop: `process_uptime_seconds`, `horse_tick_age_seconds`).
  The wallet counters are kept apart from the detailed calls (which are pruned after an hour), so they only ever go up.
* The alert rules run in the round loop every 5 seconds **and** from the scheduler every minute (`alerts:check`), which is what reports a loop that
  is not running at all. Put the scheduler in cron: `* * * * * cd /path/to/laravel && php artisan schedule:run >> /dev/null 2>&1`.
* Thresholds are in `config/horse.php` (`HORSE_ALERT_*`); `HORSE_ALERT_WEBHOOK_URL` receives `{text, status, name, severity, message, since, at, id}`.
  A webhook that does not answer within 3 seconds is skipped, so keep it fast (a chat tool's incoming webhook is fine).
* Health for a load balancer: `GET /healthz` is 200 only while the round loop runs and the ledger chain is intact.

## Staff accounts

    php artisan staff add-operator olga --role=admin          # the first login of the operator's console (/admin); prints a temporary password
    php artisan staff add-user acme ann --role=admin          # the first administrator of a client's back office (/backoffice)

A temporary password must be changed at the first sign-in. Set `HORSE_COOKIE_SECURE=true` behind https (the default is Secure in production).

## Known differences from the Node server

* Staff passwords are argon2id (Node: scrypt). The two formats cannot be converted, so the staff of a Node installation get new temporary passwords
  (`php artisan staff reset-password ...`); clients, API keys and secrets do carry over (`php artisan clients import`).
* Wallet timings for the overview are kept in the database for an hour; `/metrics` uses running counters.
* There is one round loop per database, held with a cache lock (`CACHE_STORE=database` or `redis`); there is no separate standby command, start a second `game:run` and it waits for the lock.
* The daily loss limit adds up the bets placed today (UTC) and their payouts; Node counts a payout on the day it is settled.
  They differ only for a race that straddles midnight.
* Sessions and the current round are in the database, so any number of web workers can serve players.
* Draw and odds are unchanged; the ledger chain is the same, but only events of the ported features are written so far.

## Cutover and deployment

* Moving a live Node installation over: [`docs/CUTOVER.md`](../docs/CUTOVER.md) (`import:node`, `ledger verify|export`, `clients export`, `scripts/compare-servers.js`).
* Running it in production: [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).
* `/api/public` is served from a cached copy (`horse:public-parts`), refreshed when a race opens, is drawn, settles or is voided; use Redis for the cache in production.
