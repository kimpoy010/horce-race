# Bingo Pinball - from staging to go-live (Phase 6)

This is the runbook for certifying and switching on Bingo Pinball. The build is finished; **everything below that touches staging, the testing lab, a deploy or production is done by a person** (Kim, the operator, the client). Nothing in the code deploys or enables the game by itself: it ships **switched off for every client** (`config/games.php` default is `["horse-race"]`) and a client plays it only after an operator adds it to the client's games and chooses its paytable.

Read together with [../DEPLOY_CHECKLIST.md](../DEPLOY_CHECKLIST.md) (backup, deploy, restore, roll back) and [../STAGING.md](../STAGING.md).

| Step | Who | Tool in this repo | Done when |
|---|---|---|---|
| 1. Load test on staging | engineer | `bin/bingo-loadtest.cjs`, `games:reconcile` | section 1 passes |
| 2. Certification pack | engineer, then the lab | `php artisan bingo:cert-pack` | the lab's report names the commit |
| 3. Deploy, switched off | Kim | DEPLOY_CHECKLIST.md | section 3 passes |
| 4. Test accounts | Kim and the client | admin console | section 4 passes |
| 5. Go live and watch | Kim | consoles, `/metrics`, alerts | section 5 passes |

## 1. Load test on staging

Staging must follow [../STAGING.md](../STAGING.md): its own database and keys, play-money wallets or the platform's **test** wallet. Never run the load test against production: every play moves money and fills the ledger for good.

1. On staging, give a test client the game: `games: ["horse-race","bingo-pinball"]`, `gameSettings: {"bingo-pinball": {"paytable": 96}}` (admin console, client page, Games). Make sure the round loop (`php artisan game:run`) runs.
2. Run the tool from any machine that can reach staging (it refuses non-local hosts unless told this is not production):

   ```
   node bin/bingo-loadtest.cjs --base https://staging.example --client <test client> --players 300 --duration 600 --ramp 60 --yes-this-is-not-production
   ```

   A player plays once every 3 seconds at most (the server enforces it), so 300 players make about 100 plays a second. Use `--tokens file` (one launch token per line) for the client's test wallet; without it the tool uses the mock wallet (`demo-<name>`). `--repeat-rate` (default 5%) repeats a request id to prove no play is made twice.
3. Run it again at the load the client expects at peak, then once at twice that, then a 24-hour soak at the expected average.
4. Afterwards, on the staging server: `php artisan games:reconcile` must print `every game matches the ledger`, and the totals the tool printed (plays, staked, paid) must equal the Games tab of the back office and `horse_game_*` in `/metrics`.

**Proposed pass criteria** (agree them with the client before the test; they are proposals, not measured facts): no server error (5xx) and no timeout; no repeated request id that plays twice (the tool exits 1 if it finds one); p95 of a play under 500 ms and p99 under 1.5 s at expected peak; wallet failure rate under 1% (admin overview); pending credits and rollbacks drain to zero within a minute after the test; `games:reconcile` clean; the horse race keeps opening, running and settling races on time during the test (watch `horse_tick_age_seconds`); no alert left firing.

A smoke run on a developer machine (SQLite, PHP's built-in server, 30 players, 20 s) made 170 plays with no error and matched the ledger exactly. It says the tool and the accounting work, **not** how staging will perform: that is what step 1 is for.

## 2. Certification pack

1. On a clean checkout of the exact commit or tag you will deploy: `php artisan bingo:cert-pack --out=/path/to/pack`. It prints a warning if the working tree is not clean; do not certify such a pack.
2. Send the folder to the lab. It holds the rules sheet, the PAR sheets for all five versions (exact enumeration of the 53,130 outcomes), the description of the generator and the fairness protocol, the standalone verifiers (PHP and Python) with 49 known-answer plays, the source that decides results, and `MANIFEST.json` / `SHA256SUMS` with the SHA-256 of every file, of the browser build and of every paytable, plus the commit.
3. Which versions are certified is a decision: certify every RTP version a client may be given, and give a client only a certified version.
4. After the lab approves, keep its report with the pack. **Any change to the certified source, paytables or browser build needs the lab's view again.** On any server, `php artisan bingo:cert-pack --verify=/path/to/pack` proves that the installed source and browser build are the certified ones (exit code 1 and a list of differences otherwise). Run it on staging and on production after every deploy.
5. The operator must publish the RTP of the version each client plays (the game shows it on the rules screen; the PAR sheet is the source).

Things the pack does not decide for you: the licence or the regulator's own forms, the platform's integration tests, and the legal text around the game.

## 3. Deploy, switched off

Follow [../DEPLOY_CHECKLIST.md](../DEPLOY_CHECKLIST.md) exactly (backup, restore check, migrations first, watch for 24 hours). The Bingo migrations only add tables and columns, so the old code keeps working with the new database.

* Before: `HORSE_CLIENTS_KEY` is set (the game refuses to run without it) and backed up. The round loop runs.
* After: `/healthz` is ok; `php artisan games:reconcile` is clean; `php artisan bingo:cert-pack --verify=<pack>` says OK; the admin console's **Games** tab shows Bingo Pinball **off** for every client; the horse race plays as before (a bet and a win on a test account).
* Rolling back is a normal redeploy of the previous tag.

## 4. Enable for the client's test accounts

There is **no per-player switch**: the game is enabled per client. To let only test accounts play, create a **separate test client** (own id, the platform's **test** wallet and test brand, own API key) and give the game to that client only. Do not use the live client for this. (If you want per-account enablement on one client instead, that is new work; decide before this step.)

1. Admin console, client page, Games: switch Bingo Pinball on, choose the paytable (certified version), set stake limits if wanted, save.
2. The platform's test environment launches `/games/bingo-pinball?client=<id>&token=<launch token>`. Play on a phone held upright and in landscape, on desktop, and with the sound on.
3. Check against the platform's test wallet: each play shows a debit `bp:<id>:bet` and, for a win, a credit `bp:<id>:win` (both idempotent on `txId`); a lost answer to a debit is rolled back; a refused debit charges nothing; the balance in the game equals the platform's.
4. Check webhooks (`big.win`, and `round.settled` if the client turned them on) arrive signed with `gameId: "bingo-pinball"`.
5. Check responsible-gaming limits across both games (daily loss limit, reality check, block) and that a blocked player cannot play.
6. In the back office open a play, start a new seed on the player's page, then open the same play again: the proof appears and `bin/bingo-verify.php` reproduces it.
7. `php artisan games:reconcile` clean; no alert.

## 5. Go live and watch

1. Switch the game on for the live client (admin console). No deploy is needed.
2. For the first 24 hours watch: `/healthz`; wallet failure rate and p95 per client; pending credits and rollbacks (the alerts `bingo_credits_stuck` and `bingo_rollbacks_stuck` fire after `HORSE_ALERT_CREDIT_MIN` / `HORSE_ALERT_ROLLBACK_MIN` minutes); `horse_tick_age_seconds`; the Games tab.
3. For the first weeks watch **per-game RTP**: the Games tab ("vs maths") and `horse_game_rtp_zscore{game="bingo-pinball"}`. The alert `rtp_drift:bingo-pinball` fires beyond 4 standard deviations after 1,000 plays. A single play has a standard deviation of 1.4x to 2.6x the stake depending on the version (see MATH.md), so a few hundred plays say little; do not react to a gap that is inside two standard deviations. A drift alert is a reason to run `games:reconcile`, check `bingo:cert-pack --verify` and look at the plays, not to change the paytable.
4. Run `games:reconcile` daily for the first week, then weekly.

**Switching the game off** (any problem with the game itself): admin console, client page, uncheck Bingo Pinball, save. New plays are refused within seconds (`GAME_NOT_ENABLED`; every call re-checks, the client list is cached briefly). Plays already made stay settled, and queued credits and rollbacks keep being delivered by the round loop (it does not depend on the game being enabled). The horse race is not affected.
