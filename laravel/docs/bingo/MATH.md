# Bingo Pinball - maths package (version 1)

This is the specification of the rules, the draw and the maths of Bingo Pinball, written for the testing lab, for the operator and for anyone who wants to check a play. Everything here is **implemented and tested** (Phase 2). The parts that need the server (per-player seeds, wallet, rounds) come later and are listed at the end.

Files: `app/Games/BingoPinball/` (code), `app/Games/BingoPinball/paytables/` (frozen paytables), `bin/bingo-verify.php` (standalone verifier), `docs/bingo/verify_play.py` (independent Python implementation), `docs/bingo/test-vectors.json` (known answers), `docs/bingo/PAR_SHEETS.md` (the PAR sheets), `tests/Unit/BingoMathTest.php`.

## 1. The game

* 25 holes numbered 1-25. Five balls are played; each ends in a different hole (a ball stays in its hole). The five holes are what the draw decides.
* A fixed 5×5 **card** shows the numbers 1-25, one per cell, row by row. A cell lights when its hole holds a ball.
* 12 **lines**: 5 rows, 5 columns and the 2 diagonals. The **best line** (the one with the most lit cells) pays; lines never add up. If two lines tie, the one with the lowest index is shown (rows 0-4, columns 5-9, diagonals 10-11); the payout is the same.
* **3, 4 or 5 lit cells** on the best line pay a multiple of the stake, the stake included (a 2× pay returns the stake plus one more). One or two lit cells pay nothing.
* The **plunger is decoration**. How hard the player pulls only changes the animation, never the result. The rules screen says so.

## 2. The maths

All 53,130 = C(25,5) sets of five holes are equally likely. For **any** card layout the best line is:

| Best line | Outcomes | Probability |
|---|---|---|
| 5 in line | 12 | 0.0226% |
| 4 in line | 1,200 | 2.2586% |
| 3 in line | 21,144 | 39.7967% |
| 2 in line | 30,706 | 57.7941% |
| 1 in line | 68 | 0.1280% |

(1 or 2 in line, 30,774 outcomes, 57.9221%, is "no win".) The layout of the numbers on the card is cosmetic: every hole sits on exactly one cell, so renaming the cells cannot change any probability. The tests enumerate all 53,130 outcomes for each of the five layouts through the game's own evaluator and get the same table every time.

`RTP = Σ (n_k / 53,130) × pay_k` for k = 3, 4, 5. The five versions:

| Version | 3 in line | 4 in line | 5 in line | Exact RTP | As a fraction | Win frequency | Std dev of one play |
|---|---|---|---|---|---|---|---|
| 88 | 2× | 3× | 75× | 88.06% | 1114/1265 | 42.08% | 1.513× |
| 90 | 2× | 4× | 60× | 89.98% | 7968/8855 | 42.08% | 1.399× |
| 92 | 2× | 5× | 50× | 92.02% | 1164/1265 | 42.08% | 1.369× |
| 94 | 2× | 5× | 150× | 94.27% | 8348/8855 | 42.08% | 2.52× |
| 96 | 2× | 6× | 150× | 96.53% | 8548/8855 | 42.08% | 2.56× |

The RTP of a version is set only by choosing the version. The probabilities of the holes never change. The top prize comes once in 4,428 plays on average, so the observed RTP over a few thousand plays is dominated by luck. How far a result may stray from the exact RTP by chance (one standard error, for the five versions):

| Plays | One standard error of the observed RTP |
|---|---|
| 10,000 | ±1.40 to ±2.56 points |
| 100,000 | ±0.44 to ±0.81 points |
| 1,000,000 | ±0.14 to ±0.26 points |

The full PAR sheets are in [PAR_SHEETS.md](PAR_SHEETS.md). `php artisan bingo:par` prints them again from an exact enumeration, compares them with these published figures, and exits with an error if anything differs.

## 3. The draw (provably fair)

The outcome of a play depends only on three things: the **server seed** (32 random bytes, kept secret until it is revealed; its SHA-256, the **commit**, is shown before the first play), the **client seed** (chosen by the player or by default random; 1-64 letters, digits, "-" or "_") and the **nonce** (1, 2, 3 ... for each play under the same seed pair).

```
key    = the 32 bytes of the server seed (64 lower-case hex characters)
stream = HMAC-SHA256(key, "bingo-pinball:" client_seed ":" nonce ":" counter)    counter = 0, 1, 2 ...
         the stream is these 32-byte blocks one after another; four bytes (big endian) make one 32-bit number
int(n) = a uniform integer in [0, n): take the next 32-bit number v; if v >= 2^32 - (2^32 mod n) throw it away and take the next; the answer is v mod n
holes  = a = [1, 2, ..., 25]
         for i = 0, 1, 2, 3, 4:  j = i + int(25 - i);  swap a[i] and a[j]
         the balls end in a[0], a[1], a[2], a[3], a[4], in this order
```

This is a partial Fisher-Yates shuffle with rejection sampling, so every ordered choice of five different holes is exactly equally likely and there is no modulo bias. The commit is `sha256(server seed as the 64-character text)`.

**Check a play yourself** (needs only PHP 8, or only Python 3):

```
php bin/bingo-verify.php --server-seed <64 hex> --client-seed <text> --nonce <n> --version 96 --stake 1000 --commit <64 hex>
python3 docs/bingo/verify_play.py --server-seed <64 hex> --client-seed <text> --nonce <n> --version 96 --stake 1000
```

Both re-draw the holes, light the card, find the best line, print the payout, and (PHP) check the commit. They share no code with the game or with each other: the Python file was written from this text, and `docs/bingo/test-vectors.json` (49 plays, including a win of 3, 4 and 5 in a line for every version) was made by it. `tests/Unit/BingoMathTest.php` requires the game code, the PHP verifier and the Python file to agree on every vector.

## 4. Card layouts and frozen paytables

Each version has its own layout, made once and frozen in its paytable file. How they were made, so they can be reproduced (`Card::generate`): a Fisher-Yates shuffle of 1-25 from the stream above with key `sha256("bingo-pinball card layout v<version>")` and label `card:<version>`, taking `j = int(i + 1)` for `i = 24` down to `1`.

A paytable file in use is **never edited**. Each carries an id (`bp-v96-1`), and a test compares the SHA-256 of every paytable with a value written into the test. A change of pays or card is a new file (for example `v96r2.php`, id `bp-v96-2`) plus a deliberate new line in that test; the old version stays available for plays already made under it.

## 5. What the tests check

* the five paytables are unchanged (hashes), follow the recipe, and make sense (more lit cells never pay less);
* the evaluator on hand-made cards (every line, ties, strays) and against an independently written recount on thousands of draws;
* the **exact enumeration** of all 53,130 outcomes reproduces the table in section 2 and the exact RTP of every version, for every layout;
* the draw gives five different holes, depends on all three inputs, and refuses bad input;
* known answers from the independent Python implementation, the standalone PHP verifier and the game code agree;
* **uniformity**: over 1,000,000 draws, every hole is equally likely overall and for each ball, and all 53,130 sets of holes are equally likely (chi-square, failing beyond 4.5 standard deviations). The lab can run more: `BINGO_STAT_DRAWS=10000000 php artisan test --filter=test_holes_are_uniform`. The test was also run against a deliberately biased shuffle and a shuffle with an off-by-one error and failed both at more than 180 standard deviations;
* the observed RTP over 200,000 plays is within 5 standard errors of the exact one.

## 6. Still to come

The server side is not built yet (Phases 3 to 5 of the implementation plan): per-player seed storage (server seed encrypted, commit shown before the first play, rotation on request and every 1,000 plays with the old seed revealed), the play request with wallet debit, settlement and credit, the ledger events, limits shared with the horse race, and the screens. They must use `Draw::holes()` and `Paytable::payout()` unchanged, so that everything in this document keeps holding.
