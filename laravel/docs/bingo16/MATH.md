# Bingo Pinball 16 - maths package (version 2, paytable b16-v90-2)

The specification of the rules, the draw, the paytable and the jackpot of Bingo Pinball 16, for the testing lab, the operator and anyone who wants to check a play. It is a different game from Bingo Pinball (5 balls, 25 holes, `docs/bingo/`); both exist side by side. Files: `app/Games/BingoPinball16/` (code), `bin/bingo16-verify.php` (standalone verifier), `docs/bingo16/verify_play.py` (independent Python implementation, also computes the exact PAR), `docs/bingo16/test-vectors.json` (42 known answers), `docs/bingo16/par.json` and `PAR_SHEET.txt` (exact PAR), `tests/Unit/BingoMath16Test.php`.

## 1. The game

* **16 balls** are played, one after another. Every ball ends in one of **16 slots** (numbered 1-16, side by side across the whole floor of the board: nothing drains out). A slot can receive several balls.
* A **4 x 4 card** shows 1-16 row by row. A cell lights when its slot holds at least one ball.
* Five random **jackpot numbers** (JP NUMS) are drawn from 1-16 for every play.
* The **number of complete lines** (4 rows, 4 columns, 2 diagonals: 10 lines) pays a multiple of the stake (stake included): **2 lines 1x, 3 lines 2x, 4 lines 5x, 5 lines 10x, 6-7 lines 20x, 8 or more lines 125x**. One line pays nothing.
* The **jackpot** is won when **each of the 5 jackpot numbers holds at least two balls**. It pays the whole pool of the moment (section 4) on top of any line pay.
* The **plunger is decoration**: it never changes any result.

(Version 1, b16-v90-1, let 70.56% of the balls drain OUT between the slots and paid the best of five card patterns. Version 2 closes the gaps; with every ball landing the card fills up, so the pays are by lines and the jackpot needs two balls on each number.)

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

| Lines complete | Pays | Probability | 1 in | Share of RTP |
|---|---|---|---|---|
| 8+ | 125x | 0.00692% | 14,453 | 0.865% |
| 6-7 | 20x | 0.23655% | 422.7 | 4.731% |
| 5 | 10x | 0.92084% | 108.6 | 9.208% |
| 4 | 5x | 4.09741% | 24.4 | 20.487% |
| 3 | 2x | 12.50444% | 8.0 | 25.009% |
| 2 | 1x | 27.51357% | 3.6 | 27.514% |

**Line RTP 87.8138%**, win frequency 45.280%, standard deviation of a play 1.9942 x stake, 10.303 slots lit on average. **Jackpot (all five numbers hold two balls): probability 0.0209%, 1 in 4,791 plays.**

## 4. The jackpot pool

One **progressive pool for the whole server, in PHP** (other currencies play without the jackpot). Parameters (operator settings, `config/games.php`): **contribution** 1.48% of every stake (rounded down to a minor unit) goes into the pool; the pool starts at, and after every win is re-seeded with, the **seed** (default 100.00, paid by the operator, not by players). A jackpot win pays the whole pool.

Long-run return to players of the jackpot = contribution + (probability of a jackpot x seed) / stake. Total RTP by stake with the defaults: **1.00: 91.38%; 5.00: 89.71%; 10.00: 89.50%; 50.00: 89.34%; 100.00: 89.31%** (line pays 87.81% + contribution 1.48% + seed cost). At the smallest stakes the seed makes the game pay back more; that is the operator's cost and the reason the seed is a setting. With a jackpot about once in 4,800 plays the pool grows to roughly 70 stakes before it is won.

## 5. Frozen rules

`Rules::canonical()` (slots, weights, pays, jackpot rule, lines) is hashed in `tests/Unit/BingoMath16Test.php`; the rules of a certified game are never edited: a different paytable is a new version with a new id.

## 6. What the tests check

the frozen rules; the evaluator on hand-made plays and against the independent one on 9,363 lit sets; the exact PAR (all 65,536 sets) against the big-integer figures of the Python implementation; the draw against 42 known answers (every pay level and the jackpot) from the Python implementation and the standalone verifier; uniformity of balls and jackpot numbers (chi-square; `BINGO_STAT_DRAWS=... php artisan test --filter=BingoMath16Test` runs more); the observed return of 30,000 plays within 5 standard errors.
