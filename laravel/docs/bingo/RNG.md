# Bingo Pinball - description of the random number generator and the draw

For the testing lab. The exact algorithm is in [MATH.md](MATH.md) section 3 and in `app/Games/BingoPinball/Draw.php` and `app/Game/RngStream.php`; this document says what it is, what it is made of and what it relies on.

## What decides a result

A result (which five of the 25 holes the balls end in) is a **pure function of three inputs**: the server seed, the client seed and the nonce. There is no other source of randomness in a play, no state, no clock and no input from the player's device besides the stake and a request id. The plunger and the ball animation do not exist as far as the server is concerned: the page draws a stored ball path that ends in the hole the server chose.

* **Server seed:** 32 bytes from the operating system's cryptographically secure generator (`random_bytes`, PHP), one per player and seed pair, written as 64 hex characters. Stored encrypted (AES-256-GCM, key derived from `HORSE_CLIENTS_KEY`); never sent to the player until the pair is retired.
* **Client seed:** chosen by the player (1 to 64 letters, digits, `-`, `_`) or, by default, 8 random bytes from the same generator. The player can change it at any time by starting a new pair.
* **Nonce:** 1, 2, 3, ... one per play under the pair, taken inside the player's lock so two plays never share one.

## The generator

A keyed stream: block *k* is `HMAC-SHA256(key = server seed, message = "bingo-pinball:" client seed ":" nonce ":" k)`; the bytes of the blocks are consumed four at a time as unsigned 32-bit numbers. HMAC-SHA256 is a standard primitive (FIPS 198-1, FIPS 180-4); nothing is invented here. Its output is unpredictable without the server seed, and the server seed is committed to before it is used.

A uniform integer in [0, n) is made by **rejection sampling**: a 32-bit value `v` is thrown away when `v >= 2^32 - (2^32 mod n)` and the next value is taken; the answer is `v mod n`. This has no modulo bias for any n. The five holes come from a **partial Fisher-Yates shuffle** of 1..25 (positions 0 to 4 only), so every ordered choice of five different holes has probability 1/(25*24*23*22*21) and every set of five has probability 1/53,130.

## Fairness protocol (what the player can check)

1. Before the first play the player is shown the **commit**, `sha256(server seed)`, and the client seed.
2. Every play records the nonce and the holes. The server cannot change a result after the stake is taken, because the result is already fixed by the committed seed, the client seed and the nonce.
3. When the player starts a new pair (or after 1,000 plays) the old server seed is **revealed**. The page, a standalone PHP script and an independent Python script re-draw every play under it and compare: the commit, the holes, the best line and the payout.
4. The operator's back office shows the same proof for any play once its seed is revealed.

The ledger (hash chained) records `seed.commit` at the start of a pair and `seed.reveal` with the revealed seed, so a commit cannot be replaced after the fact.

## What is and is not claimed

* The generator is the keyed hash described above on an OS-seeded secret key. It does not use `mt_rand`, `rand` or any generator that can be predicted from earlier outputs.
* Fairness of the *distribution* (every set of five holes equally likely) is proved by construction (section above) and tested: over 1,000,000 draws every hole and every one of the 53,130 sets is equally likely within 4.5 standard deviations, the same test fails a deliberately biased shuffle by more than 180 standard deviations, and the exact enumeration of all outcomes gives the published RTP. `BINGO_STAT_DRAWS=10000000 php artisan test --filter=test_holes_are_uniform` runs more draws.
* Three implementations (game code, `bin/bingo-verify.php`, `docs/bingo/verify_play.py`) plus the browser verifier agree on the 49 known-answer plays of `docs/bingo/test-vectors.json`.
* Not covered by this document: the operator's wallet, the platform's own checks, and the security of the server that holds the encrypted seeds (see `docs/DEPLOYMENT.md`).
