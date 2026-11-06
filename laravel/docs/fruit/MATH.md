# Fruit Game - the maths

Paytable id `fr-v90-2`. Everything here is frozen (a hash of the rules is checked by `tests/Unit/FruitMathTest.php`); a change is a new version with a new id.

## The game
A ring of 24 cells. The player puts credits on any of 8 symbols (BAR, 7, STAR, WATERMELON, BELL, LEMON, ORANGE, APPLE). One spin: the server draws a stop cell by weight. There are two **Lucky** cells. They pay nothing themselves: one gives **3 free spins** (a lit cell each), the other **one free spin with 3 lit cells**. Free-spin cells are drawn among the non-Lucky cells by weight, so a free spin never gives more free spins. Every lit cell pays the credits on its symbol on the same bets, so the same symbol twice pays twice. A **x3** cell pays three times its symbol's pay.

Pay for one credit (stake included): BAR 30 (the BAR-x50 cell pays 12), 7 = 10, STAR 7, WATERMELON 5, BELL 5, LEMON 4, ORANGE 2, APPLE 2.

## Return to player
Each symbol is tuned on its own: every single-symbol bet returns 89.96-89.99%, and betting on all eight returns **89.9762%** (PAR sheet: `PAR_SHEET.txt`, exact fractions in `par.json`). No bet is more generous than another, so there is no "best" symbol to play. Lucky stops are 3.817% of spins.

## Double-up (Small / Big)
After a win the player may first move part of it to their balance (the arrows; that part is paid at once and is not risked) and then double the rest: a number 1-14 is drawn, **Small** is 1-7, **Big** is 8-14; right = twice the win, wrong = the win is lost. Exactly 50/50, so a double-up is RTP-neutral. At most **3 in a row**.

## The draw (provably fair)
Same scheme as the other games. `stream = HMAC-SHA256(server seed bytes, label ":" counter)`, 4 bytes (big endian) per number, `int(n)` uniform by rejection sampling.
- spin label `fruit-ring:<clientSeed>:<nonce>`: `r = int(100000)` mapped to a cell by the cumulative weights; on a Lucky stop, three more numbers `int(W_nonLucky)` mapped over the non-Lucky cells (free3: one cell per free spin; light3: the three cells of the one free spin).
- double-up label `fruit-double:<clientSeed>:<nonce>`: `int(14) + 1`.
Every spin and every double-up uses the next nonce of the player's seed pair; the server seed is shown (and checkable against the earlier commit) when the pair rotates.

## Verifying
- `bin/fruit-verify.php` (PHP only) and `docs/fruit/verify_play.py` (Python only) each re-run a spin or double-up from the seeds, with no shared code with the game.
- `docs/fruit/test-vectors.json`: 30 known-answer vectors, checked by the PHP tests.
- The test suite also checks the PHP PAR against the exact Python PAR to 1e-10, chi-square uniformity of the stops and double numbers, and the observed return.
