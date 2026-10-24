<?php

namespace App\Game;

/**
 * Race outcome draw (port of server/rng.js, same results for the same seed: tests/Unit/ParityTest.php).
 *
 * The outcome comes from a secret 256-bit seed. Its SHA-256 ("commit") is published before bets are taken and the seed is
 * revealed after the race, so anyone can re-run draw() and check it. A deterministic byte stream HMAC-SHA256(seed, label:counter)
 * feeds the draws; integers use rejection sampling, so there is no modulo bias.
 */
final class Rng
{
    /** @return list<array{int,int}> */
    public static function pairs(): array
    {
        $out = [];
        for ($a = 1; $a <= 6; $a++) {
            for ($b = $a + 1; $b <= 6; $b++) {
                $out[] = [$a, $b];
            }
        }

        return $out;
    }

    public static function newSeed(): string
    {
        return bin2hex(random_bytes(32));
    }

    public static function commitOf(string $seedHex): string
    {
        return hash('sha256', $seedHex);
    }

    /** @param list<int>|null $weights */
    public static function draw(string $seedHex, int $raceNo, ?array $weights = null): array
    {
        $s = new RngStream($seedHex, 'race:'.$raceNo);
        $pairs = self::pairs();
        $pair = self::pickPair($s, $weights, $pairs);
        $s->int(2);        // used to pick which of the two finishes first; drawn and ignored so the rest of the stream is unchanged
        $top = [$pair[0], $pair[1]];
        $rest = array_values(array_filter([1, 2, 3, 4, 5, 6], fn ($n) => $n !== $pair[0] && $n !== $pair[1]));
        for ($i = count($rest) - 1; $i > 0; $i--) {
            $j = $s->int($i + 1);
            [$rest[$i], $rest[$j]] = [$rest[$j], $rest[$i]];
        }

        return ['combo' => $pair[0].'-'.$pair[1], 'order' => array_merge($top, $rest), 'animSeed' => $s->uint32()];
    }

    private static function pickPair(RngStream $s, ?array $weights, array $pairs): array
    {
        if (! $weights) {
            return $pairs[$s->int(count($pairs))];
        }
        $total = array_sum($weights);
        $r = $s->int($total);
        foreach ($weights as $i => $w) {
            if ($r < $w) {
                return $pairs[$i];
            }
            $r -= $w;
        }

        return $pairs[count($pairs) - 1];
    }

    /**
     * The odds of one race: the same 15 odds values shuffled over the 15 pairs, from the round seed with its own label
     * (public from the start of betting, tells nothing about the draw).
     *
     * @param list<int|float> $values
     * @return array<string,int|float>
     */
    public static function oddsLayout(string $seedHex, int $raceNo, array $values): array
    {
        $s = new RngStream($seedHex, 'odds:'.$raceNo);
        $v = array_values($values);
        for ($i = count($v) - 1; $i > 0; $i--) {
            $j = $s->int($i + 1);
            [$v[$i], $v[$j]] = [$v[$j], $v[$i]];
        }
        $out = [];
        foreach (Odds::combos() as $i => $c) {
            $out[$c] = $v[$i];
        }

        return $out;
    }
}
