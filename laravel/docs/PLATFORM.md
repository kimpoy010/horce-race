# The platform and its games

The server runs more than one game on one set of shared services. This page says what is shared, what belongs to a game, and how a new game is added. (Phase 1 of the Bingo Pinball plan; nothing about the horse race changed: `tests/Feature/HorseBaselineTest.php` compares it byte for byte with what it did before.)

## What is shared (`app/Platform/`)

| Service | Class | What it does |
|---|---|---|
| Clients | `Clients\ClientDirectory` | which client (platform) a player belongs to, its wallet, its webhook, whether it is active; resolves a launch to a client; the player key `client:player` (`PlayerKey`) |
| Sessions | `Sessions\Sessions` | launch token → game session (the platform's wallet validates the token), session lookup and expiry, blocking a player, ending sessions; a session belongs to one game (`game_sessions.game_id`) |
| Limits | `Limits\Limits` | minimum / maximum bet, maximum stake per round, daily loss limit, and what a player has staked and lost today |
| Wallet | `Wallet\WalletGateway` | every call to a platform's wallet, timed and counted; the debit (two tries, then a rollback of a debit whose outcome is unknown); the queue of credits and rollbacks still owed to the platform (`pending_ops`) and its retry with back-off |
| Ledger | `Ledger\Journal` | writes the events of every game into the one hash-chained ledger |
| Webhooks | `Webhooks\WebhookQueue` | events to the platform (queued, delivered at least once, back-off, dropped when the client has no webhook any more) |
| Games | `Games\Games`, `Games\GameModule` | the registry of games (`config/games.php`) and which games a client plays |

The horse race's own logic (rounds, odds, draw, settlement) is still `App\Game\Engine`; it uses these services. Its public methods did not change.

Rows that belong to a game carry its id: `game_sessions.game_id`, `bets.game_id`, `pending_ops.game_id` (default `horse-race`), and `pending_ops.round_ref` for a game with no race number. The ledger events of the horse race are as they always were; an event of another game has a `game` field right after its name.

## The games

| Game | Kind | Where |
|---|---|---|
| Horse Race | shared rounds, moved by the round loop | `App\Game\Engine` (the module `App\Games\HorseRace\HorseRaceModule` only describes it) |
| Bingo Pinball | instant: one round per play, settled inside the player's request | `app/Games/BingoPinball/` (`BingoPinballService`, `SeedService`, the maths package), API in [bingo/API.md](bingo/API.md) |

An instant game's flow (see `BingoPinballService`): take the player's lock, check limits, debit through the gateway, draw, and save the result with its ledger lines and the queued credit in one transaction. The round loop (`php artisan game:run`) delivers queued credits, rollbacks and webhooks for every game and cancels instant plays that never finished.

## Which games a client plays

`config/games.php` lists the games the server has (`modules`) and the ones every client plays unless told otherwise (`default`, now only the horse race). A client can have its own `games` list (admin console → client settings, or `POST /admin/api/clients/<id>` with `{"games": ["horse-race", "<other game>"]}`). A client without a list plays the defaults, and nothing is stored for it. A list is checked when it is written, never when it is read, so a client that names a game this server no longer has keeps working: that game is just skipped.

A client's settings for a game (`gameSettings`, for example the paytable of Bingo Pinball) are checked by the game's module when they are written, and never when they are read.

**A new game ships switched off**: add it to `modules` but not to `default`, and no client plays it until an operator adds it to the client's list. `Sessions::auth(..., $gameId)` refuses a game that is not enabled for the client (`403 GAME_NOT_ENABLED`) before the launch token is used up. The horse race is not switched off by a list yet.

## Adding a game

1. A class implementing `App\Platform\Games\GameModule` (id, kind `shared` or `instant`, name, launch path, rules, per-client settings) under `app/Games/<Game>/`, and an entry in `config/games.php` `modules`.
2. Its tables, additive only (never change an existing column or migration). Rows that belong to it carry its `game_id`.
3. Money only through the gateway: `WalletGateway::debit()` with the game's own transaction id and `meta.gameId` / `meta.roundRef`, and `queueCredit()` / `queueRollback()` for what the platform still has to be told. The wallet is told the game (`gameId`) and the round (`roundId`) of every call.
4. Players only through `Sessions` and limits only through `Limits`; events through `Journal::log($event, $gameId)` and `WebhookQueue::emit(..., $gameId)`.
5. Results never depend on anything an operator, a staff role or an API call can set.
6. A test for every failure path, and the horse-race baseline still identical.

## Rules for changes to the horse race

* Its URLs, answers, wallet transaction ids (`bet:<race>:<batch>`), ledger lines, webhook bodies and metric names are what operators reconcile against; `HorseBaselineTest` must stay green without being regenerated.
* Migrations only add. Existing `HORSE_*` settings keep working.
* Before a deploy: [DEPLOY_CHECKLIST.md](DEPLOY_CHECKLIST.md). Migrations run first; the new code tolerates a database that has not been migrated yet (the queue code reads the new columns defensively), so a failed migration cannot break live betting.
