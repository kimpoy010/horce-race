# Fruit Game - HTTP API (Phase B)

Under `/api/games/fruit-ring`, the same conventions as the other games: JSON, `{"ok": true, ...}` or `{"ok": false, "error": CODE}`, the session id from `/auth` as a bearer token. The game is reachable only for clients whose games list has `fruit-ring` (`FRUIT_DEFAULT_ON=true` gives it to every client). The page (`/games/fruit-ring`) comes in Phase D.

| Call | What it does |
|---|---|
| `POST /auth {token, client?}` | exchanges the platform's launch token for a session; answers with the state |
| `GET /state` | balance, `limits` (`minBet`, `maxBet` on the whole stake of a spin, `maxCreditsPerSymbol`, `maxCredits`), `paytable` (id `fr-v90-2`, the 24 cells with pays), the seed commit, `last` round, `open` (a win is held), `unseen`, `unfinished` |
| `POST /play {bets, credit, requestId}` | one spin. `bets` = credits on each symbol (`bar seven star watermelon bell lemon orange apple`), e.g. `{"apple": 2, "bar": 1}`; `credit` = the value of one credit in minor units; stake = credits x credit |
| `POST /round/{id}/double {side, step}` | double the held win: `side` `small` (1-7) or `big` (8-14), `step` = double-ups already seen (0, 1, 2); a repeated step returns the answer that exists |
| `POST /round/{id}/collect` | takes the held win; idempotent |
| `GET /round/{id}`, `GET /history`, `POST /round/{id}/seen` | as in the other games |
| `POST /seed/rotate {clientSeed?}` | reveals the current server seed and starts a new pair; refused (`ROUND_OPEN`, 409) while a win is held |
| `GET /proof/{id}` | after the seed is revealed: the seed, the rounds, the double-ups and the commands that re-run them |

**A round**: `status` `open` (a win is held) / `settled` / `void`; `rounds` (the lit cells of the spin: `[[stop]]`, or `[[stop],[a],[b],[c]]` for 3 free spins, or `[[stop],[a,b,c]]`), `payouts` (credits paid per credit bet on each symbol), `spinWin`, `held` (the win now at stake), `doubles` (`{nonce, side, number, won}`), `canDouble`, `payout` (final, minor units), `stake`, `bets`, `credit`.

**Money**: the wallet is debited the stake when the spin is requested (`fr:<id>:bet`) and credited the final payout once when the round settles (`fr:<id>:win`). A win is held, not paid, while the player decides: it settles when the player collects, loses a double-up, wins the third in a row, starts the next spin, or after `FRUIT_OPEN_AFTER_MS` of silence (the round loop collects it). A double-up needs no wallet call.

**Fairness**: every spin and every double-up takes the next nonce of the player's seed pair for `fruit-ring` (docs/fruit/MATH.md). `php bin/fruit-verify.php` re-runs both.

Errors: `BAD_REQUEST`, `BAD_BET` (unknown symbol, a symbol above the cap, too many credits, a stake outside the limits), `TOO_FAST`, `NOT_OPEN`, `NO_DOUBLE`, `ROUND_OPEN`, `SEED_NOT_REVEALED`, plus the shared ones (`GAME_NOT_ENABLED`, `SESSION_EXPIRED`, `INSUFFICIENT_FUNDS`, `WALLET_UNAVAILABLE`, ...).

## The page (Phase D)

`/games/fruit-ring` (portrait, 390 px wide, scaled to the window; `public/fruit-ring.html`, `css/fruit.css`, `js/fruit/*`). Players signed in on the operator's own site are launched from the account page (**Play Fruit Game**, shown when the game is on) with no token typed; a platform's launch link carries its own token. Tap a fruit to add a credit, hold it to clear it; the credit value, CLEAR, REPEAT, PAYS, FAIR and SND sit under the bets; START spins (and first collects a win still held). After a win the centre of the ring offers SMALL, BIG and COLLECT; a win left alone is restored (and can still be doubled) after a reload. The ◀ button goes back to the lobby. The FAIR sheet checks any settled play in the browser against its revealed seed (`js/fruit/fair.js`, tested against `docs/fruit/test-vectors.json`).
