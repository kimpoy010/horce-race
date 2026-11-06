# Bingo Pinball 16 - maths package (version 2, paytable b16-v90-2)

The specification of the rules, the draw, the paytable and the jackpot of Bingo Pinball 16, for the testing lab, the operator and anyone who wants to check a play. It is a different game from Bingo Pinball (5 balls, 25 holes, `docs/bingo/`); both exist side by side. Files: `app/Games/BingoPinball16/` (code), `bin/bingo16-verify.php` (standalone verifier), `docs/bingo16/verify_play.py` (independent Python implementation, also computes the exact PAR), `docs/bingo16/test-vectors.json` (42 known answers), `docs/bingo16/par.json` and `PAR_SHEET.txt` (exact PAR), `tests/Unit/BingoMath16Test.php`.

## 1. The game

* **16 balls** are played, one after another. Every ball ends in one of **16 slots** (numbered 1-16, side by side across the whole floor of the board: nothing drains out). A slot can receive several balls.
* A **4 x 4 card** shows 1-16 row by row. A cell lights when its slot holds at least one ball.
* Five random **jackpot numbers** (JP NUMS) are drawn from 1-16 for every play.
* The **best complete pattern** of twelve pays a multiple of the stake (stake included); patterns never add up. Cells are numbered 1-16 row by row; in order of rank (the first that is complete pays):

| Pattern | Cells | Pays |
|---|---|---|
| FULL CARD | all 16 | 5,000x |
| BIG BOX | the outer ring (1-4, 5, 8, 9, 12, 13-16) | 150x |
| Z SHAPE | top row, bottom row and the anti-diagonal (1-4, 7, 10, 13-16) | 15x |
| EQUAL | top and bottom rows (1-4, 13-16) | 5x |
| NUMBER ELEVEN | first and last columns (1, 5, 9, 13, 4, 8, 12, 16) | 5x |
| LUCKY SEVEN | top row and the anti-diagonal (1-4, 7, 10, 13) | 2x |
| L SHAPE | first column and bottom row (1, 5, 9, 13-16) | 2x |
| 4 CORNERS | 1, 4, 13, 16 | 1x |
| SMALL BOX | the middle 2 x 2 (6, 7, 10, 11) | 1x |
| DIAGONAL | either diagonal (1, 6, 11, 16 or 4, 7, 10, 13) | 1x |
| ACROSS | any one row | 0.5x |
| DOWN | any one column | 0.5x |

  Equal pays (NUMBER ELEVEN / EQUAL, LUCKY SEVEN / L SHAPE, ACROSS / DOWN, ...) are listed in the order above when more than one is complete; which name is shown never changes the pay. The two commonest patterns pay **half the stake** (the payout is the stake x half-stakes / 2, rounded down to a minor unit; the `multiple` column of a round stores half-stakes). Four of the twelve patterns appear in 80% of all plays, which is why they cannot pay a full stake and keep a 90% game.
* The **jackpot** is won when **each of the 5 jackpot numbers holds at least two balls**. It pays the whole pool of the moment (section 4) on top of any line pay.
* The **plunger is decoration**: it never changes any result.

(Version 1, b16-v90-1, let 70.56% of the balls drain OUT between the slots and paid the best of five card patterns. Version 2 closes the gaps; with every ball landing the card fills up (10.3 of 16 cells on average), so the patterns are the twelve shapes above and the jackpot needs two balls on each number.)

## 2. The draw (provably fair)

The result depends only on the **server seed** (32 secret random bytes; its SHA-256, the commit, is shown before the first play), the **client seed** (1-64 letters, digits, "-", "_") and the **nonce** (1, 2, 3 ... per play under the pair).

```
key    = the 32 bytes of the server seed (64 lower-case hex characters)
stream = HMAC-SHA256(key, "bingo-pinball-16:" client_seed ":" nonce ":" counter)   counter = 0, 1, 2 ...; four bytes (big endian) make one 32-bit number
int(n) = uniform in [0, n): take the next 32-bit number v; if v >= 2^32 - (2^32 mod n) throw it away and take the next; the answer is v mod n
balls  = for each of the 16 balls in order: r = int(10000); slot = floor(r / 625) + 1
jackpot numbers = a = [1..16]; for i = 0..4: j = i + int(16 - i); swap a[i] and a[j]; the numbers are a[0] .. a[4]   (drawn after the balls, from the same stream)
```

So every ball lands in each slot with probability 625/10,000 = 6.25%. Rejection sampling removes modulo bias. Check a play: `php bin/bingo16-verify.php --server-seed <64 hex> --client-seed <text> --nonce <n> --stake <minor units> --commit <64 hex>` or `python3 docs/bingo16/verify_play.py --server-seed ... --client-seed ... --nonce ...`; they share no code with the game or with each other.

## 3. The maths (exact, see PAR_SHEET.txt)

The pay depends only on the **set of lit slots**. P(the lit set is exactly S) follows from inclusion-exclusion over f(S) = (|S| / 16)^16; all 65,536 sets are run through the game's own evaluator. The jackpot (five given slots each hold at least two balls) is 16! times the coefficient of x^16 in (e^x - 1 - x)^5 (e^x)^11, divided by 16^16.

| Pattern (best that is complete) | Pays | Probability | 1 in | Share of RTP |
|---|---|---|---|---|
| FULL CARD | 5,000x | 0.000113% | 881,658 | 0.567% |
| BIG BOX | 150x | 0.04999% | 2,000 | 7.499% |
| Z SHAPE | 15x | 0.30382% | 329.1 | 4.557% |
| EQUAL | 5x | 1.01765% | 98.3 | 5.088% |
| NUMBER ELEVEN | 5x | 1.32147% | 75.7 | 6.607% |
| LUCKY SEVEN | 2x | 2.29953% | 43.5 | 4.599% |
| L SHAPE | 2x | 2.08660% | 47.9 | 4.173% |
| 4 CORNERS | 1x | 10.46852% | 9.6 | 10.469% |
| SMALL BOX | 1x | 13.16831% | 7.6 | 13.168% |
| DIAGONAL | 1x | 11.88951% | 8.4 | 11.890% |
| ACROSS | 0.5x | 25.35381% | 3.9 | 12.677% |
| DOWN | 0.5x | 13.30624% | 7.5 | 6.653% |

**Pattern RTP 87.9479%**, win frequency 81.266% (but 38.7% of plays win only half the stake), standard deviation of a play 6.3818 x stake, 10.303 slots lit on average. **Jackpot (all five numbers hold two balls): probability 0.0209%, 1 in 4,791 plays.**

## 4. The jackpot pool

One **progressive pool for the whole server, in PHP** (other currencies play without the jackpot). Parameters (operator settings, `config/games.php`): **contribution** 1.48% of every stake (rounded down to a minor unit) goes into the pool; the pool starts at, and after every win is re-seeded with, the **seed** (default 100.00, paid by the operator, not by players). A jackpot win pays the whole pool.

Long-run return to players of the jackpot = contribution + (probability of a jackpot x seed) / stake. Total RTP by stake with the defaults: **1.00: 91.51%; 5.00: 89.85%; 10.00: 89.64%; 50.00: 89.47%; 100.00: 89.45%** (pattern pays 87.95% + contribution 1.48% + seed cost). At the smallest stakes the seed makes the game pay back more; that is the operator's cost and the reason the seed is a setting. With a jackpot about once in 4,800 plays the pool grows to roughly 70 stakes before it is won.

## 5. Frozen rules

`Rules::canonical()` (slots, weights, pays, jackpot rule, lines) is hashed in `tests/Unit/BingoMath16Test.php`; the rules of a certified game are never edited: a different paytable is a new version with a new id.

## 6. What the tests check

the frozen rules; the evaluator on hand-made plays and against the independent one on 9,363 lit sets; the exact PAR (all 65,536 sets) against the big-integer figures of the Python implementation; the draw against 42 known answers (every pattern and the jackpot) from the Python implementation and the standalone verifier; uniformity of balls and jackpot numbers (chi-square; `BINGO_STAT_DRAWS=... php artisan test --filter=BingoMath16Test` runs more); the observed return of 30,000 plays within 5 standard errors.
