<?php

namespace App\Games\FruitRing;

use App\Game\Rng;
use App\Game\RngStream;

/**
 * The outcome of a spin and of a double-up. Both depend only on (server seed, client seed, nonce), so anyone shown the server seed afterwards can re-run them
 * (docs/fruit/verify_play.py does exactly this, on its own).
 *
 *   key    = the 32 bytes of the server seed (64 hex characters)
 *   stream = HMAC-SHA256(key, label ":" counter), counter = 0, 1, 2 ...; four bytes (big endian) make one 32-bit number
 *            label of a spin "fruit-ring:" client seed ":" nonce; label of a double-up "fruit-double:" client seed ":" nonce
 *   int(n) = uniform in [0, n) by rejection sampling (reject v >= 2^32 - (2^32 mod n), the answer is v mod n)
 *   spin   = r = int(100000), mapped to a cell by the cumulative weights of the 24 cells in ring order. A Lucky stop lights two more cells: each is int(Wn) mapped over the non-Lucky
 *            cells in ring order (Wn = their total weight), drawn from the same stream after the first
 *   double = int(14) + 1: Small is 1-7, Big is 8-14
 * Every spin and every double-up takes the next nonce of the player's seed pair.
 */
final class Draw
{
    public static function newServerSeed(): string
    {
        return Rng::newSeed();
    }

    public static function commitOf(string $serverSeedHex): string
    {
        return Rng::commitOf($serverSeedHex);
    }

    private static function stream(string $kind, string $serverSeedHex, string $clientSeed, int $nonce): RngStream
    {
        if (! preg_match('/^[0-9a-f]{64}$/', $serverSeedHex)) {
            throw new \InvalidArgumentException('the server seed is 64 lower-case hex characters');
        }
        if (! preg_match('/^[A-Za-z0-9_-]{1,64}$/', $clientSeed)) {
            throw new \InvalidArgumentException('the client seed is 1 to 64 letters, digits, "-" or "_"');
        }
        if ($nonce < 1) {
            throw new \InvalidArgumentException('the nonce starts at 1');
        }

        return new RngStream($serverSeedHex, $kind.':'.$clientSeed.':'.$nonce);
    }

    /** @param list<int> $cells */
    private static function pick(int $r, array $cells): int
    {
        foreach ($cells as $i) {
            if ($r < Rules::RING[$i][2]) {
                return $i;
            }
            $r -= Rules::RING[$i][2];
        }
        throw new \LogicException('weights do not add up');
    }

    /** @return list<int> the cells that light, in order: [stop], or [Lucky stop, extra 1, extra 2] */
    public static function spin(string $serverSeedHex, string $clientSeed, int $nonce): array
    {
        $s = self::stream('fruit-ring', $serverSeedHex, $clientSeed, $nonce);
        $stop = self::pick($s->int(Rules::TOTAL_WEIGHT), range(0, 23));
        if (Rules::symbolOf($stop) !== 'lucky') {
            return [$stop];
        }
        $non = array_values(array_diff(range(0, 23), Rules::luckyCells()));
        $wn = array_sum(array_map(fn ($i) => Rules::RING[$i][2], $non));

        return [$stop, self::pick($s->int($wn), $non), self::pick($s->int($wn), $non)];
    }

    /** the number 1..14 of a double-up */
    public static function doubleNumber(string $serverSeedHex, string $clientSeed, int $nonce): int
    {
        return self::stream('fruit-double', $serverSeedHex, $clientSeed, $nonce)->int(Rules::DOUBLE_NUMBERS) + 1;
    }
}
