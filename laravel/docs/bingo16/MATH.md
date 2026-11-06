# Bingo Pinball 16 - maths package (version 1, paytable b16-v90-1)

The specification of the rules, the draw, the paytable and the jackpot of Bingo Pinball 16, for the testing lab, the operator and anyone who wants to check a play. It is a different game from Bingo Pinball (5 balls, 25 holes, `docs/bingo/`); both exist side by side. Files: `app/Games/BingoPinball16/` (code), `bin/bingo16-verify.php` (standalone verifier), `docs/bingo16/verify_play.py` (independent Python implementation, also computes the exact PAR), `docs/bingo16/test-vectors.json` (42 known answers), `docs/bingo16/par.json` and `PAR_SHEET.txt` (exact PAR), `tests/Unit/BingoMath16Test.php`.

## 1. The game

* **16 balls** are played, one after another. Every ball ends in one of **16 slots** (numbered 1-16 along the bottom of the board) or **drains OUT** between the slots and counts for nothing. A slot can receive several balls.
* A **4 x 4 card** shows 1-16 row by row. A cell lights when its slot holds at least one ball.
* Five random **jackpot numbers** (JP NUMS) are drawn from 1-16 for every play.
* The **best pattern** pays a multiple of the stake (stake included); patterns never add up. In order of rank: **2+ LINES** (two or more complete lines) 30x, **4 CORNERS** (cells 1, 4, 13, 16) 15x, **FULL LINE** (one complete line) 5x, **2x2 SQUARE** (any 2 x 2 block) 2x, **3 ON LINE** (three lit cells in a line, a line being a row, a column or a diagonal; 10 lines) 2x.
* The **jackpot** is won when **all 5 jackpot numbers are lit**. It pays the whole pool of the moment (section 4) on top of any pattern pay.
* The **plunger is decoration**: it never changes any result.

## 2. The draw (provably fair)

The result depends only on the **server seed** (32 secret random bytes; its SHA-256, the commit, is shown before the first play), the **client seed** (1-64 letters, digits, "-", "_") and the **nonce** (1, 2, 3 ... per play under the pair).

```
key    = the 32 bytes of the server seed (64 lower-case hex characters)
stream = HMAC-SHA256(key, "bingo-pinball-16:" client_seed ":" nonce ":" counter)   counter = 0, 1, 2 ...; four bytes (big endian) make one 32-bit number
int(n) = uniform in [0, n): take the next 32-bit number v; if v >= 2^32 - (2^32 mod n) throw it away and take the next; the answer is v mod n
balls  = for each of the 16 balls in order: r = int(10000); slot = floor(r / 184) + 1 if r < 2944, otherwise OUT (0)
jackpot numbers = a = [1..16]; for i = 0..4: j = i + int(16 - i); swap a[i] and a[j]; the numbers are a[0] .. a[4]   (drawn after the balls, from the same stream)
```

So every ball lands in each slot with probability 184/10,000 = 1.84% and drains OUT with 7,056/10,000 = 70.56%. Rejection sampling removes modulo bias. Check a play: `php bin/bingo16-verify.php --server-seed <64 hex> --client-seed <text> --nonce <n> --stake <minor units> --commit <64 hex>` or `python3 docs/bingo16/verify_play.py --server-seed ... --client-seed ... --nonce ...`; they share no code with the game or with each other.

## 3. The maths (exact, see PAR_SHEET.txt)

The pay depends only on the **set of lit slots**. P(the lit set is exactly S) follows from inclusion-exclusion over f(S) = ((7,056 + 184 |S|) / 10,000)^16; all 65,536 sets are run through the game's own evaluator.

| Pattern | Pays | Probability | 1 in | Share of RTP |
|---|---|---|---|---|
| 2+ LINES | 30x | 0.07403% | 1,351 | 2.221% |
| 4 CORNERS | 15x | 0.31595% | 316.5 | 4.739% |
| FULL LINE | 5x | 3.00229% | 33.3 | 15.011% |
| 2x2 SQUARE | 2x | 2.26468% | 44.2 | 4.529% |
| 3 ON LINE | 2x | 30.68128% | 3.3 | 61.363% |

**Pattern RTP 87.8635%**, win frequency 36.338%, standard deviation of a play 1.6351 x stake, 4.113 slots lit on average. **Jackpot numbers all lit: probability 0.0664%, 1 in 1,506 plays.**

## 4. The jackpot pool

One **progressive pool for the whole server, in PHP** (other currencies play without the jackpot). Parameters (operator settings, `config/games.php`): **contribution** 1.48% of every stake (rounded down to a minor unit) goes into the pool; the pool starts at, and after every win is re-seeded with, the **seed** (default 100.00, paid by the operator, not by players). A jackpot win pays the whole pool.

Long-run return to players of the jackpot = contribution + (probability of a jackpot x seed) / stake. Total RTP by stake with the defaults: **1.00: 95.99%; 5.00: 90.67%; 10.00: 90.01%; 50.00: 89.48%; 100.00: 89.41%** (pattern 87.86% + contribution 1.48% + seed cost). At the smallest stakes the seed makes the game pay back more; that is the operator's cost and the reason the seed is a setting.

## 5. Frozen rules

`Rules::canonical()` (slots, weights, patterns, lines, pays) is hashed in `tests/Unit/BingoMath16Test.php`; the rules of a certified game are never edited: a different paytable is a new version with a new id.

## 6. What the tests check

the frozen rules; the evaluator on hand-made plays and against the independent one on 9,363 lit sets; the exact PAR (all 65,536 sets) against the big-integer figures of the Python implementation; the draw against 42 known answers (every pattern and the jackpot) from the Python implementation and the standalone verifier; uniformity of balls and jackpot numbers (chi-square; `BINGO_STAT_DRAWS=... php artisan test --filter=BingoMath16Test` runs more); the observed return of 30,000 plays within 5 standard errors.
