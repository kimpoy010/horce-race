# Bingo Pinball 16 - maths package (version 3, paytable b16-v90-3)

The specification of the rules, the draw, the paytable and the jackpot of Bingo Pinball 16, for the testing lab, the operator and anyone who wants to check a play. It is a different game from Bingo Pinball (5 balls, 25 holes, `docs/bingo/`); both exist side by side. Files: `app/Games/BingoPinball16/` (code), `bin/bingo16-verify.php` (standalone verifier), `docs/bingo16/verify_play.py` (independent Python implementation, also computes the exact PAR), `docs/bingo16/test-vectors.json` (42 known answers), `docs/bingo16/par.json` and `PAR_SHEET.txt` (exact PAR), `tests/Unit/BingoMath16Test.php`.

## 1. The game

* **16 balls** are played, one after another. A ball is **missed** with probability 16%: it falls into one of **three baskets** standing among the pegs, and counts for nothing. Otherwise it ends in one of **16 slots** (numbered 1-16 along the bottom), each with probability 5.25%. A slot can receive several balls.
* The **three baskets** take the place of three pegs, on three of **ten fixed places**; the places are drawn for every play (new for every game), from the same provably fair draw as the balls. They only decide where the page draws the baskets: whether a ball is missed is decided by the ball's own number (section 2), and a missed ball is shown falling into one of the three baskets.
* A **4 x 4 card** shows 1-16 row by row. A cell lights when its slot holds at least one ball.
* Five random **jackpot numbers** (JP NUMS) are drawn from 1-16 for every play.
* The **best complete pattern** of twelve pays a multiple of the stake (stake included); patterns never add up. Cells are numbered 1-16 row by row; in order of rank (the first that is complete pays):

| Pattern | Cells | Pays |
|---|---|---|
| FULL CARD | all 16 | 5,000x |
| BIG BOX | the outer ring (1-4, 5, 8, 9, 12, 13-16) | 500x |
| Z SHAPE | top row, bottom row and the anti-diagonal (1-4, 7, 10, 13-16) | 80x |
| EQUAL | top and bottom rows (1-4, 13-16) | 10x |
| NUMBER ELEVEN | first and last columns (1, 5, 9, 13, 4, 8, 12, 16) | 10x |
| LUCKY SEVEN | top row and the anti-diagonal (1-4, 7, 10, 13) | 4x |
| L SHAPE | first column and bottom row (1, 5, 9, 13-16) | 4x |
| 4 CORNERS | 1, 4, 13, 16 | 2x |
| SMALL BOX | the middle 2 x 2 (6, 7, 10, 11) | 2x |
| DIAGONAL | either diagonal (1, 6, 11, 16 or 4, 7, 10, 13) | 1x |
| ACROSS | any one row | 0.5x |
| DOWN | any one column | 0.5x |

  Equal pays (NUMBER ELEVEN / EQUAL, LUCKY SEVEN / L SHAPE, ACROSS / DOWN, ...) are listed in the order above when more than one is complete; which name is shown never changes the pay. The two commonest patterns pay **half the stake** (the payout is the stake x half-stakes / 2, rounded down to a minor unit; the `multiple` column of a round stores half-stakes). ACROSS and DOWN are the commonest patterns, which is why they pay half a stake.
* The **jackpot** is won when **each of the 5 jackpot numbers holds at least two balls**. It pays the whole pool of the moment (section 4) on top of any line pay.
* The **plunger is decoration**: it never changes any result.

(Version 1 let 70.56% of the balls drain out between the slots. Version 2 closed the gaps: every ball landed, 10.3 of 16 cells lit on average. Version 3 adds the baskets: 16% of the balls are missed, 9.25 cells light on average, and the pays are higher to keep the game near 90%.)

## 2. The draw (provably fair)

The result depends only on the **server seed** (32 secret random bytes; its SHA-256, the commit, is shown before the first play), the **client seed** (1-64 letters, digits, "-", "_") and the **nonce** (1, 2, 3 ... per play under the pair).

```
key    = the 32 bytes of the server seed (64 lower-case hex characters)
stream = HMAC-SHA256(key, "bingo-pinball-16:" client_seed ":" nonce ":" counter)   counter = 0, 1, 2 ...; four bytes (big endian) make one 32-bit number
int(n) = uniform in [0, n): take the next 32-bit number v; if v >= 2^32 - (2^32 mod n) throw it away and take the next; the answer is v mod n
balls  = for each of the 16 balls in order: r = int(10000); r < 1600: MISSED (0); otherwise slot = floor((r - 1600) / 525) + 1
jackpot numbers = a = [1..16]; for i = 0..4: j = i + int(16 - i); swap a[i] and a[j]; the numbers are a[0] .. a[4]   (drawn after the balls, from the same stream)
baskets = b = [1..10]; for i = 0..2: j = i + int(10 - i); swap b[i] and b[j]; the baskets stand on the places b[0] .. b[2]   (drawn after the jackpot numbers)
```

So every ball is missed with probability 1,600/10,000 = 16% and lands in each slot with probability 525/10,000 = 5.25%. Rejection sampling removes modulo bias. Check a play: `php bin/bingo16-verify.php --server-seed <64 hex> --client-seed <text> --nonce <n> --stake <minor units> --commit <64 hex>` or `python3 docs/bingo16/verify_play.py --server-seed ... --client-seed ... --nonce ...`; they share no code with the game or with each other.

## 3. The maths (exact, see PAR_SHEET.txt)

The pay depends only on the **set of lit slots**. P(the lit set is exactly S) follows from inclusion-exclusion over f(S) = ((1,600 + 525 |S|) / 10,000)^16 (every ball is missed or lands in S); all 65,536 sets are run through the game's own evaluator. The jackpot (five given slots each hold at least two balls) is 16! times the coefficient of x^16 in (e^x - 1 - x)^5 (e^x)^11, divided by 16^16.

| Pattern (best that is complete) | Pays | Probability | 1 in | Share of RTP |
|---|---|---|---|---|
| FULL CARD | 5000x | 0.00001% | 14,349,327.6 | 0.035% |
| BIG BOX | 500x | 0.00871% | 11,486.3 | 4.353% |
| Z SHAPE | 80x | 0.07864% | 1,271.6 | 6.291% |
| EQUAL | 10x | 0.40524% | 246.8 | 4.052% |
| NUMBER ELEVEN | 10x | 0.48388% | 206.7 | 4.839% |
| LUCKY SEVEN | 4x | 1.02283% | 97.8 | 4.091% |
| L SHAPE | 4x | 0.96060% | 104.1 | 3.842% |
| 4 CORNERS | 2x | 7.72028% | 13.0 | 15.441% |
| SMALL BOX | 2x | 8.80735% | 11.4 | 17.615% |
| DIAGONAL | 1x | 9.79606% | 10.2 | 9.796% |
| ACROSS | 0.5x | 21.10633% | 4.7 | 10.553% |
| DOWN | 0.5x | 14.03029% | 7.1 | 7.015% |

  Equal pays (NUMBER ELEVEN / EQUAL, LUCKY SEVEN / L SHAPE, ACROSS / DOWN, ...) are listed in the order above when more than one is complete; which name is shown never changes the pay. The two commonest patterns pay **half the stake** (the payout is the stake x half-stakes / 2, rounded down to a minor unit; the `multiple` column of a round stores half-stakes). ACROSS and DOWN are the commonest patterns, which is why they pay half a stake.
* The **jackpot** is won when **each of the 5 jackpot numbers holds at least two balls**. It pays the whole pool of the moment (section 4) on top of any line pay.
* The **plunger is decoration**: it never changes any result.

(Version 1 let 70.56% of the balls drain out between the slots. Version 2 closed the gaps: every ball landed, 10.3 of 16 cells lit on average. Version 3 adds the baskets: 16% of the balls are missed, 9.25 cells light on average, and the pays are higher to keep the game near 90%.)

## 2. The draw (provably fair)

The result depends only on the **server seed** (32 secret random bytes; its SHA-256, the commit, is shown before the first play), the **client seed** (1-64 letters, digits, "-", "_") and the **nonce** (1, 2, 3 ... per play under the pair).

```
key    = the 32 bytes of the server seed (64 lower-case hex characters)
stream = HMAC-SHA256(key, "bingo-pinball-16:" client_seed ":" nonce ":" counter)   counter = 0, 1, 2 ...; four bytes (big endian) make one 32-bit number
int(n) = uniform in [0, n): take the next 32-bit number v; if v >= 2^32 - (2^32 mod n) throw it away and take the next; the answer is v mod n
balls  = for each of the 16 balls in order: r = int(10000); r < 1600: MISSED (0); otherwise slot = floor((r - 1600) / 525) + 1
jackpot numbers = a = [1..16]; for i = 0..4: j = i + int(16 - i); swap a[i] and a[j]; the numbers are a[0] .. a[4]   (drawn after the balls, from the same stream)
baskets = b = [1..10]; for i = 0..2: j = i + int(10 - i); swap b[i] and b[j]; the baskets stand on the places b[0] .. b[2]   (drawn after the jackpot numbers)
```

So every ball is missed with probability 1,600/10,000 = 16% and lands in each slot with probability 525/10,000 = 5.25%. Rejection sampling removes modulo bias. Check a play: `php bin/bingo16-verify.php --server-seed <64 hex> --client-seed <text> --nonce <n> --stake <minor units> --commit <64 hex>` or `python3 docs/bingo16/verify_play.py --server-seed ... --client-seed ... --nonce ...`; they share no code with the game or with each other.

## 3. The maths (exact, see PAR_SHEET.txt)

The pay depends only on the **set of lit slots**. P(the lit set is exactly S) follows from inclusion-exclusion over f(S) = ((1,600 + 525 |S|) / 10,000)^16 (every ball is missed or lands in S); all 65,536 sets are run through the game's own evaluator. The jackpot (five given slots each hold at least two balls) is 16! times the coefficient of x^16 in (e^x - 1 - x)^5 (e^x)^11, divided by 16^16.

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

**Pattern RTP 87.9235%**, win frequency 64.420% (21% of plays win only half the stake), standard deviation of a play 5.4608 x stake, 9.249 slots lit on average. **Jackpot (all five numbers hold two balls): probability 0.0046%, 1 in 21,586 plays.**

## 4. The jackpot pool

One **progressive pool for the whole server, in PHP** (other currencies play without the jackpot). Parameters (operator settings, `config/games.php`): **contribution** 1.48% of every stake (rounded down to a minor unit) goes into the pool; the pool starts at, and after every win is re-seeded with, the **seed** (default 100.00, paid by the operator, not by players). A jackpot win pays the whole pool.

Long-run return to players of the jackpot = contribution + (probability of a jackpot x seed) / stake. Total RTP by stake with the defaults: **1.00: 89.87%; 5.00: 89.50%; 10.00: 89.45%; 50.00: 89.41%; 100.00: 89.41%** (pattern pays 87.92% + contribution 1.48% + seed cost). At the smallest stakes the seed makes the game pay back more; that is the operator's cost and the reason the seed is a setting. With a jackpot about once in 21,600 plays the pool grows to roughly 320 stakes before it is won.

## 5. Frozen rules

`Rules::canonical()` (slots, weights, pays, jackpot rule, lines) is hashed in `tests/Unit/BingoMath16Test.php`; the rules of a certified game are never edited: a different paytable is a new version with a new id.

## 6. What the tests check

the frozen rules; the evaluator on hand-made plays and against the independent one on 9,363 lit sets; the exact PAR (all 65,536 sets) against the big-integer figures of the Python implementation; the draw against 42 known answers (every pattern and the jackpot) from the Python implementation and the standalone verifier; uniformity of balls and jackpot numbers (chi-square; `BINGO_STAT_DRAWS=... php artisan test --filter=BingoMath16Test` runs more); the observed return of 30,000 plays within 5 standard errors.
