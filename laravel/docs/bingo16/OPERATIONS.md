# Bingo Pinball 16 - consoles, metrics, alerts and reconciliation (Phase E)

Everything here only **adds**; the horse race's and Bingo Pinball's endpoints, metric names, alerts and report shapes are unchanged (`HorseBaselineTest` ignores only the new `horse_game_*` and `horse_jackpot_*` families). Needs `php artisan migrate` (the pattern column and the jackpot tables); until it has run, the consoles, `/metrics` and the alerts read this game as zero instead of failing.

## Back office (`/backoffice`, one client)

**Games** tab: the game's row (plays, staked, paid, GGR, return, expected, win rate) and a **Bingo Pinball 16** section: pattern return against the PAR sheet, jackpots won against the number the maths expects, jackpot paid, how far the pattern pays are from the maths ("sd"), the **patterns against the PAR sheet** (plays and expected plays for each of the six), the current jackpot pool, and the latest plays. Click a play for the **round viewer**: balls (slot 1-16), slots lit, the five jackpot numbers and how many are lit, the line pattern, the jackpot paid, and - once the player's seed pair has been revealed - the server seed, the commit and the `php bin/bingo16-verify.php ...` command that re-runs the play.

API (viewer and up; a client sees only its own plays): `GET /bo/api/games`, `GET /bo/api/rounds?game=bingo-pinball-16[&player=][&limit=]`, `GET /bo/api/players?game=bingo-pinball-16`, `GET /bo/api/games/bingo-pinball-16/rounds/{id}`, CSV `GET /bo/api/export/bingo16-rounds.csv` (audited; pattern pay and jackpot paid in separate columns).

## Admin console (`/admin`, operator)

**Games** tab: the game in total and per client, and **Bingo Pinball 16: jackpot**: per currency the pool now, its seed, everything contributed, paid out and put in as seed money by the operator, the number of jackpots won, the last win, and whether the **books balance** (pool = seed money + contributions - jackpots paid). `GET /admin/api/games` (also returns `pools`). Switch the game on or off per client in the client's Games panel as for the other games (this game has no paytable to choose).

## Metrics (`/metrics`)

The game appears in the `horse_game_*` family (`game="bingo-pinball-16"`: plays, staked and paid per currency, actual and theoretical return, `horse_game_rtp_zscore` = the pattern pays against the PAR sheet, hit frequency, pending credits and rollbacks). New: `horse_jackpot_pool`, `horse_jackpot_wins_total`, `horse_jackpot_contributed_total`, `horse_jackpot_paid_total`, `horse_jackpot_seeded_total`, `horse_jackpot_balanced` (1 = books balance), all per game and currency, and `horse_jackpot_zscore`.

## Alerts

| Alert | Severity | Fires when |
|---|---|---|
| `rtp_drift:bingo-pinball-16` | warning | after `HORSE_ALERT_BINGO_MIN_PLAYS` plays (1000), the pattern pays are more than `HORSE_ALERT_RTP_Z` (4) standard deviations from the PAR sheet (the standard deviation of one play is 1.994 x the stake) |
| `jackpot_drift:bingo-pinball-16` | warning | once the maths expects at least `HORSE_ALERT_JACKPOT_MIN_EXPECTED` (5) jackpots in the plays made, the number won is more than 4 standard deviations (Poisson) away from expected: too many jackpots is a liability, too few means players are being shortchanged |
| `jackpot_books:bingo-pinball-16:<currency>` | critical | the pool does not equal seed money + contributions - jackpots paid |
| `jackpot_below_seed:bingo-pinball-16:<currency>` | critical | the pool is below its seed |
| `bingo16_credits_stuck` | critical | a win (a jackpot may be among them) is not delivered to the wallet after `HORSE_ALERT_CREDIT_MIN` minutes |
| `bingo16_rollbacks_stuck` | critical | a rollback of a debit is not confirmed after `HORSE_ALERT_ROLLBACK_MIN` minutes |

## Reconciliation

`php artisan games:reconcile` compares each game's database figures with the hash-chained ledger. For this game: settled plays, stakes, payouts (pattern pays and jackpots), wins queued to the wallet, **jackpots paid against the plays and against the ledger (`jackpot.win`), contributions against the ledger (`jackpot.add`), seed money against the ledger (`jackpot.seed`)**, and that every pool balances. Exit code 1 and a `DIFF` line on any difference. Run it on staging after a test session and daily in the first week live.

## Load test

`node bin/bingo-loadtest.cjs --game bingo-pinball-16 --base <staging> --client <test client> --players 300 --duration 600 ...` (same rules and pass criteria as `docs/bingo/GO_LIVE.md`; refuses non-local hosts unless told this is not production). Every play of this game updates the one jackpot-pool row inside its transaction, so a load test is also how to see whether that row limits throughput: watch the p95 of a play as players grow. If it does, the pool counter can be split into shards.
