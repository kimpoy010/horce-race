# Retro Horse Race (video karera)

An 8-bit style horse race with six numbered horses. Each race has a **winning combination**: the two horses that finish
1st and 2nd, always written low-high (1-2, 1-3 ... 5-6, 15 pairs). The game runs in two modes.

## Live mode: fixed-odds betting (RTP 90%)

```
GAME_MODE=live WALLET=http WALLET_URL=... WALLET_KEY=... CONTROLLER_KEY=... node server.js     # see .env.example
GAME_MODE=live WALLET=mock node server.js                  # local test with play money: http://localhost:8080/?token=demo-alice
```

**Odds.** The board is the video karera chart (rows 1-5, columns 6-2). A winning bet pays **stake x odds**
(stake included). The 15 odds values are **3, 4, 5, 8, 10, 20, 30, 60, 80, 100, 125, 175, 250, 500, 1000**
(`server/odds.js`, override with `ODDS=` / `ODDS_FILE=`) and they are **shuffled randomly over the 15 pairs before every
race**: the layout is derived from the round seed, shown to the players when betting opens, and fixed for that race.
Set `shuffleOdds: false` in the engine config to keep a fixed layout instead.

**Editable RTP (80% to 99%), odds unchanged.** The RTP is a setting in the controller (or `RTP=90` at start-up). It applies
from the next race (the race in progress keeps its RTP), is saved in `data/settings.json` and recorded in the ledger.
The payout odds never change; the setting changes how often each pair is drawn (and, below 86.84%, adds a fee):

* **86.84% to 99%:** the 12 pairs with the higher odds each return **exactly the setting** (drawn with probability
  `setting / odds`). The probability that is left over is shared by the **three cheapest pairs** (the cells showing
  odds 3, 4 and 5 that race), which return a bit less: 85.4% at a 90% setting, 83.0% at 95%, 81.1% at 99%. No bet
  returns more than the setting, so the real RTP can never exceed it. The three cells are marked in the betting panel.
* **80% to 86.84%:** all pairs are drawn with probability proportional to `1/odds` (86.84% each) and a **fee** is added
  on top of every stake: `fee = 86.84% / setting - 1` (8.55% at 80%, 2.2% at 85%). The player pays stake + fee, the
  payout is still stake x odds, so every bet returns exactly the setting of what the player pays.

86.84% is `1 / sum(1/odds)` for the 15 odds values: the highest RTP all pairs can share without extra payments.
RTP is a long-run average; short runs wander a lot because of the 1000x odds. `npm test` and
`node scripts/simulate-rtp.js [races] [rtp%]` check the weights and the payout maths.

**Rules of the draw (do not change for real money).**
* The outcome comes from a secret 256-bit seed made with `crypto.randomBytes`, *before* bets open; its SHA-256 hash
  (the *commit*) is shown to players, and the seed is revealed after the race so anyone can re-run
  `rng.oddsLayout(seed, raceNo, values)` and `rng.draw(seed, raceNo, weights)` (the weights follow from the odds layout).
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
