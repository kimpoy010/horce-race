# Retro Horse Race (video karera)

An 8-bit style horse race with six numbered horses. Each race has a **winning combination**: the two horses that finish
1st and 2nd, always written low-high (1-2, 1-3 ... 5-6, 15 pairs). The game runs in two modes.

## Live mode: fixed-odds betting (RTP 90%)

```
GAME_MODE=live WALLET=http WALLET_URL=... WALLET_KEY=... CONTROLLER_KEY=... node server.js     # see .env.example
GAME_MODE=live WALLET=mock node server.js                  # local test with play money: http://localhost:8080/?token=demo-alice
```

**Odds and RTP.** The board is the video karera chart (rows 1-5, columns 6-2). A winning bet pays **stake x odds**
(stake included); each pair has its own odds (`server/odds.js`, override with `ODDS='{"1-2":60,...}'` or `ODDS_FILE=`):

| pair | odds | pair | odds | pair | odds |
|---|---|---|---|---|---|
| 1-2 | 60 | 2-3 | 8 | 3-6 | 5 |
| 1-3 | 20 | 2-4 | 500 | 4-5 | 100 |
| 1-4 | 80 | 2-5 | 30 | 4-6 | 4 |
| 1-5 | 175 | 2-6 | 1000 | 5-6 | 250 |
| 1-6 | 3 | 3-4 | 10 | | |
| | | 3-5 | 125 | | |

A pair with odds `o` is drawn with probability proportional to `1/o` (e.g. 1-6 about 29%, 2-6 about 0.09%). Then **every bet
on every pair has the same RTP = 1 / sum(1/odds) = 86.84%** (house edge 13.16%) and no pair is a better bet than another.
For this odds table 86.84% is the highest RTP that all pairs can share: sum(1/odds) is 1.1515, and a 90% RTP would need
1.1111. To reach 90% raise some odds (for example 1:3 to 1:3.5) or accept 86.84%. The server prints the RTP at start-up
and warns if `RTP=` is set and differs. RTP is a long-run average; short runs wander a lot because of the 1000x pair.
`npm test` and `node scripts/simulate-rtp.js` check the draw weights and the payout maths.

**Rules of the draw (do not change for real money).**
* The outcome comes from a secret 256-bit seed made with `crypto.randomBytes`, *before* bets open; its SHA-256 hash
  (the *commit*) is shown to players, and the seed is revealed after the race so anyone can re-run
  `rng.draw(seed, raceNo, weights)` (the weights follow from the published odds).
* The result is drawn when betting closes; no bet can be placed after that.
* The controller **cannot** change, pick or steer results in live mode (`/api/command` is refused). It only shows the
  report: stakes, payouts, actual vs theoretical RTP, wins per pair, recent races.

**Flow.** Your platform redirects the player to `https://GAME_HOST/?token=<launch token>`. The game exchanges the token
(`POST /session/validate` on your platform), keeps a session, removes the token from the URL, and shows the race with the
betting panel (balance, the 15 pairs, chips, rebet, results). Bets debit the wallet immediately; wins are credited at
the end of each race. See **docs/WALLET_API.md** for the four endpoints your platform implements and the idempotency
rules. Round timeline: bets open (`BET_MS`, 25 s) -> draw -> 6 s countdown -> race (52 s) -> results (10 s) -> next round.

**Operations.**
* `data/ledger.jsonl` is the append-only audit log (rounds, seeds, bets, draws, settlements, credits). It contains
  secret seeds: restrict file permissions and back it up. After a crash the game settles a drawn race and refunds bets on
  an undrawn one, and retries unpaid credits.
* Limits: `MIN_BET`, `MAX_BET` (per pair), `MAX_ROUND_STAKE` (per player per race), in minor units.
* Run behind HTTPS (the launch token is in the URL; pages send `Referrer-Policy: no-referrer`).
* This build keeps state in memory plus the ledger file: run **one** server instance. For several instances or high
  volume, move rounds, bets and sessions to a shared database.
* Real-money gaming is regulated. Licensing, independent RNG/RTP certification, age and responsible-gaming controls are
  the operator's responsibility.

## Demo mode (default): controller picks the winners

`node server.js` -> game at `/`, controller at `/controller` (key printed at start or `CONTROLLER_KEY`). The controller
sets the winning pair per race and starts races (or auto-run). Use for demos and promotions only, never for wagering.

## Game

Closed "U" track lying on its side (opens to the left): start top-left, curve on the right, finish bottom-left; a close-up
camera follows the pack, a minimap shows the whole track. Pixel-art horses (traced reference design with generated gallop
legs, angled sprites on the curve). Needs only a browser; no external requests.

`npm test` runs the logic, draw and engine tests.
