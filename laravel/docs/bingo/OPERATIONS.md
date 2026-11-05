# Bingo Pinball - consoles, metrics, alerts and reconciliation (Phase 5)

Everything here only **adds**: the horse race's endpoints, metric names, alerts and report shapes are unchanged (`HorseBaselineTest` proves it; it ignores only the new `horse_game_*` metric family).

## Back office (`/backoffice`, one client)

* **Games** tab: for each game of the client - plays, staked, paid, GGR, actual return, the return the maths predicts for the plays made, win rate. For Bingo Pinball also the winning plays by line (3, 4 or 5 lit) and the latest plays; click a play for the **round viewer**: holes, line, multiple, paytable, nonce and - once the player's seed pair has been revealed - the server seed, commit, player seed and the `php bin/bingo-verify.php ...` command that re-runs the play. Before the reveal the viewer says the seed is still secret.
* API (viewer role and up; a client sees only its own plays): `GET /bo/api/games`, `GET /bo/api/rounds?game=bingo-pinball[&player=][&limit=]`, `GET /bo/api/players?game=bingo-pinball[&query=]`, `GET /bo/api/games/bingo-pinball/rounds/{id}`. Without `game=` the existing horse-race answers are unchanged.
* CSV (audited like the other exports): `GET /bo/api/export/bingo-rounds.csv`, `GET /bo/api/export/games.csv`.

## Admin console (`/admin`, operator)

* **Games** tab: per game in total and per client, with the paytable of each client and how many standard deviations the payouts are from the maths ("vs maths"). `GET /admin/api/games`.
* On every client page, **Games**: switch games on or off, choose Bingo Pinball's paytable (88/90/92/94/96, required, no default), optional stake limits and per-play round webhooks. Saved with the same client update as before (`games`, `gameSettings`).

## Metrics (`/metrics`)

New family, labelled by `game` (`horse-race`, `bingo-pinball`): `horse_game_plays_total`, `horse_game_staked_total{currency}`, `horse_game_paid_total{currency}`, `horse_game_rtp_actual`, `horse_game_rtp_theoretical`, `horse_game_rtp_zscore`, `horse_game_hit_frequency` (Bingo), `horse_game_pending_credits`, `horse_game_pending_rollbacks`, `horse_game_pending_oldest_seconds`. The horse race's own `horse_*` metrics are as before (and include Bingo Pinball's queued credits, as they always read the one `pending_ops` queue).

## Alerts

| Alert | Severity | Fires when |
|---|---|---|
| `rtp_drift:bingo-pinball` | warning | after `HORSE_ALERT_BINGO_MIN_PLAYS` plays (default 1000), the payouts are more than `HORSE_ALERT_RTP_Z` (default 4) standard deviations from what the PAR sheet predicts. Computed per paytable version from the plays' multiples, so mixed paytables and stake sizes are handled |
| `bingo_credits_stuck` | critical | a Bingo Pinball win is still not delivered to the wallet after `HORSE_ALERT_CREDIT_MIN` minutes |
| `bingo_rollbacks_stuck` | critical | a rollback of a Bingo Pinball debit is not confirmed after `HORSE_ALERT_ROLLBACK_MIN` minutes |

The shared `credits_stuck` / `rollbacks_stuck` alerts still see the same rows.

## Reconciliation: reports against the ledger

`php artisan games:reconcile` (add `--json`) compares each game's figures in the database with what the hash-chained ledger recorded as it happened: settled plays, stakes, payouts and, for Bingo Pinball, the wins queued to the wallet. Exit code 1 and a `DIFF` line on any difference. Run it on staging after a test session (the Phase 5 gate) and before certification. It reads the whole ledger, so run it from the command line, not from a web request.
