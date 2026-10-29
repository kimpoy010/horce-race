<?php

namespace App\Games\BingoPinball;

use App\Game\Rng;
use App\Game\RngStream;

/**
 * The outcome of one play: which five of the 25 holes the balls end in. It depends only on (server seed, client seed, nonce), so anyone who is shown the
 * server seed afterwards can re-run it (bin/bingo-verify.php does exactly this, on its own).
 *
 *   key    = the 32 bytes of the server seed (64 hex characters)
 *   stream = HMAC-SHA256(key, "bingo-pinball:" client seed ":" nonce ":" counter), counter = 0, 1, 2 ...; consumed 4 bytes (big endian) at a time
 *   int(n) = uniform in [0, n) by rejection sampling on the 32-bit value (no modulo bias): reject v >= 2^32 - (2^32 mod n), return v mod n
 *   holes  = a = [1..25]; for i = 0..4: j = i + int(25 - i); swap(a[i], a[j]); the balls end in a[0], a[1], a[2], a[3], a[4], in this order
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

        return 'bingo-pinball:'.$clientSeed.':'.$nonce;
    }

    /** @return list<int> five distinct holes in the order the balls end in them */
    public static function holes(string $serverSeedHex, string $clientSeed, int $nonce): array
    {
        if (! preg_match('/^[0-9a-f]{64}$/', $serverSeedHex)) {
            throw new \InvalidArgumentException('the server seed is 64 lower-case hex characters');
        }
        $s = new RngStream($serverSeedHex, self::label($clientSeed, $nonce));
        $a = range(1, Card::SIZE);
        for ($i = 0; $i < Card::BALLS; $i++) {
            $j = $i + $s->int(Card::SIZE - $i);
            [$a[$i], $a[$j]] = [$a[$j], $a[$i]];
        }

        return array_slice($a, 0, Card::BALLS);
    }
}
