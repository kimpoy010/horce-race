# Fruit Game - operations (Phase E)

Everything here only **adds**: the horse race's, Bingo Pinball's and Bingo Pinball 16's endpoints, metric names, alerts and report shapes are unchanged (`HorseBaselineTest` ignores only the new `horse_game_*`, `horse_jackpot_*` and `horse_fruit_*` families). Needs `php artisan migrate` (five nullable columns on `instant_rounds`: `spin_win`, `exp_win`, `var_win`, `doubles`, `doubles_won`). Code deployed before the migration keeps working: the game plays, the consoles, `/metrics` and the alerts read the extra figures as zero until the migration has run.

**Switching on**: `FRUIT_DEFAULT_ON=true` (every client) or add `fruit-ring` to a client's games list in the admin console. Settings: `FRUIT_MIN_INTERVAL_MS` (1500), `FRUIT_OPEN_AFTER_MS` (120000), `FRUIT_ROTATE_EVERY` (1000 nonces per seed pair). Per client: `gameSettings["fruit-ring"]` `{limits: {minBet, maxBet}, roundWebhooks}`.

## Back office (a client sees only its own plays)
**Games** tab: the game's row (plays, staked, paid, GGR, return, expected, win rate) and a **Fruit Game** section: return against the maths, the spins against the maths ("sd"), the double-ups right against 50%, the wins held now, and the latest plays (a held win shows as `held`). Click a play for the viewer: bets, credits, the lit cells of every round (free spins), the spin win, each double-up (side, number, right or wrong), what was paid, and, once the player's seed pair has been revealed, the server seed, the commit and the `php bin/fruit-verify.php ...` commands that re-run the spin and every double-up. API (viewer and up): `GET /bo/api/games`, `GET /bo/api/rounds?game=fruit-ring[&player=][&limit=]`, `GET /bo/api/players?game=fruit-ring`, `GET /bo/api/games/fruit-ring/rounds/{id}`, CSV `GET /bo/api/export/fruit-rounds.csv` (audited).

## Admin console
**Games** tab: Fruit Game in the table of games and per client, and a section for the double-ups and held wins.

## What is compared with the maths
* **Spins**: the win of each spin *before any double-up* (`spin_win`) against what its bets are expected to win (`exp_win`, from the exact per-symbol figures of `PAR_SHEET.txt`). The variance used is an upper bound (the symbols are treated as perfectly correlated), so the z-score can only understate a drift, never invent one.
* **Double-ups**: an even chance, judged on their own: right answers against 50% (z-score).
* The paid total includes the double-ups, which are neutral in the long run.

## `/metrics`
In the `horse_game_*` family (`game="fruit-ring"`): plays, staked and paid per currency, actual and theoretical return, `horse_game_rtp_zscore` (the spins), hit frequency, pending credits and rollbacks. New: `horse_fruit_doubles_total`, `horse_fruit_doubles_won_total`, `horse_fruit_double_zscore`, `horse_fruit_open_rounds`, `horse_fruit_open_oldest_seconds`.

## Alerts
| Alert | Severity | When |
|---|---|---|
| `rtp_drift:fruit-ring` | warning | after `HORSE_ALERT_BINGO_MIN_PLAYS` plays (1000), the spin wins are more than `HORSE_ALERT_RTP_Z` (4) standard deviations from the maths |
| `double_drift:fruit-ring` | warning | after `HORSE_ALERT_FRUIT_DOUBLE_MIN` double-ups (400), the share right is more than 4 standard deviations from 50% |
| `fruit_open_stuck` | warning | a held win is older than `FRUIT_OPEN_AFTER_MS` + 10 minutes: the round loop (`php artisan game:run`) should have collected it |
| `fruit_credits_stuck` | critical | a win credit has not reached the wallet for `HORSE_ALERT_CREDIT_MINUTES` |
| `fruit_rollbacks_stuck` | critical | a stake rollback is not confirmed by the wallet |

## Reconciliation
`php artisan games:reconcile` compares the database with the hash-chained ledger. For Fruit Game: settled plays, stakes, payouts (after double-ups), wins queued to the wallet (`credit_due`), **wins held (open rounds) against spins that have a stake line but no settlement**, **double-ups against the ledger (`fr.double`)**, and plays settled without a stake line. Exit code 1 and a `DIFF` line on any difference.
