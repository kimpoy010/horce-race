<?php

namespace App\Games\BingoPinball16;

use App\Game\Rng;
use App\Game\RngStream;

/**
 * The outcome of one play: where each of the 16 balls ends (a slot 1-16, or 0 = MISSED: it fell into a basket), the five jackpot numbers and the three baskets and the five jackpot numbers. It depends only on (server seed, client seed, nonce),
 * so anyone who is shown the server seed afterwards can re-run it (bin/bingo16-verify.php and docs/bingo16/verify_play.py do exactly this, on their own).
 *
 *   key    = the 32 bytes of the server seed (64 hex characters)
 *   stream = HMAC-SHA256(key, "bingo-pinball-16:" client seed ":" nonce ":" counter), counter = 0, 1, 2 ...; consumed 4 bytes (big endian) at a time
 *   int(n) = uniform in [0, n) by rejection sampling on the 32-bit value (no modulo bias): reject v >= 2^32 - (2^32 mod n), return v mod n
 *   balls  = for each of the 16 balls in order: r = int(10000); r < 1600: MISSED (0), otherwise slot = floor((r - 1600) / 525) + 1
 *   jackpot numbers = a = [1..16]; for i = 0..4: j = i + int(16 - i); swap(a[i], a[j]); the numbers are a[0] .. a[4] (drawn after the balls, from the same stream)
 *   baskets = b = [1..10]; for i = 0..2: j = i + int(10 - i); swap(b[i], b[j]); the baskets take the places b[0] .. b[2] (drawn after the jackpot numbers; the places only decide where the page draws the baskets)
 */
final class Draw
{
    public const CLIENT_SEED_RE = '/^[A-Za-z0-9_-]{1,64}$/';

    public static function newServerSeed(): string
    {
        return Rng::newSeed();
    }

    public static function commitOf(string $serverSeedHex): string
    {
        return Rng::commitOf($serverSeedHex);
    }

    public static function label(string $clientSeed, int $nonce): string
    {
        if (! preg_match(self::CLIENT_SEED_RE, $clientSeed)) {
            throw new \InvalidArgumentException('the client seed is 1 to 64 letters, digits, "-" or "_"');
        }
        if ($nonce < 1) {
            throw new \InvalidArgumentException('the nonce starts at 1');
        }

        return Rules::ID.':'.$clientSeed.':'.$nonce;
    }

    /** @return array{balls:list<int>, jackpotNumbers:list<int>, baskets:list<int>} */
    public static function play(string $serverSeedHex, string $clientSeed, int $nonce): array
    {
        if (! preg_match('/^[0-9a-f]{64}$/', $serverSeedHex)) {
            throw new \InvalidArgumentException('the server seed is 64 lower-case hex characters');
        }
        $s = new RngStream($serverSeedHex, self::label($clientSeed, $nonce));
        $balls = [];
        for ($i = 0; $i < Rules::BALLS; $i++) {
            $r = $s->int(Rules::TOTAL_WEIGHT);
            $balls[] = $r < Rules::MISS_WEIGHT ? 0 : intdiv($r - Rules::MISS_WEIGHT, Rules::SLOT_WEIGHT) + 1;
        }
        $a = range(1, Rules::SLOTS);
        for ($i = 0; $i < Rules::JACKPOT_NUMBERS; $i++) {
            $j = $i + $s->int(Rules::SLOTS - $i);
            [$a[$i], $a[$j]] = [$a[$j], $a[$i]];
        }

        $b = range(1, Rules::BASKET_SPOTS);
        for ($i = 0; $i < Rules::BASKETS; $i++) {
            $j = $i + $s->int(Rules::BASKET_SPOTS - $i);
            [$b[$i], $b[$j]] = [$b[$j], $b[$i]];
        }

        return ['balls' => $balls, 'jackpotNumbers' => array_slice($a, 0, Rules::JACKPOT_NUMBERS), 'baskets' => array_slice($b, 0, Rules::BASKETS)];
    }
}
