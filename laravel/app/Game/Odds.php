<?php

namespace App\Game;

use InvalidArgumentException;

/**
 * Fixed payout odds per winning pair (the video karera board). Port of server/odds.js: the numbers must stay identical,
 * the weights decide the draw and are checked against the Node implementation in tests/Unit/ParityTest.php.
 *
 * A bet pays stake x odds (stake included). A pair with odds o is drawn with probability proportional to 1/o, so every
 * bet on every pair has the same RTP = 1 / sum(1/o) (86.84% for the default table); buildForRtp() lifts that to the
 * editable 88-99% setting.
 */
final class Odds
{
    public const MIN_RTP = 0.88;
    public const MAX_RTP = 0.99;
    public const CHEAP_PAIRS = 3;

    public const DEFAULT_ODDS = [
        '1-2' => 60, '1-3' => 20, '1-4' => 80, '1-5' => 175, '1-6' => 3,
        '2-3' => 8, '2-4' => 500, '2-5' => 30, '2-6' => 1000,
        '3-4' => 10, '3-5' => 125, '3-6' => 5,
        '4-5' => 100, '4-6' => 4,
        '5-6' => 250,
    ];

    /** @return list<string> "1-2" ... "5-6" in the order of the card */
    public static function combos(): array
    {
        $out = [];
        for ($a = 1; $a <= 6; $a++) {
            for ($b = $a + 1; $b <= 6; $b++) {
                $out[] = $a.'-'.$b;
            }
        }

        return $out;
    }

    /** JavaScript's Math.round (halves go up) */
    private static function jsRound(float $x): int
    {
        return (int) floor($x + 0.5);
    }

    /** @param array<string,int|float>|null $odds */
    public static function build(?array $odds = null): array
    {
        $odds ??= self::DEFAULT_ODDS;
        $combos = self::combos();
        foreach ($combos as $c) {
            if (! (($odds[$c] ?? 0) > 1)) {
                throw new InvalidArgumentException("odds missing or <= 1 for pair $c");
            }
        }
        $weights = array_map(fn ($c) => self::jsRound(1e9 / $odds[$c]), $combos);
        $total = array_sum($weights);
        $prob = [];
        $rtpBy = [];
        foreach ($combos as $i => $c) {
            $prob[$c] = $weights[$i] / $total;
            $rtpBy[$c] = $prob[$c] * $odds[$c];
        }
        $inv = 0.0;
        foreach ($combos as $c) {
            $inv += 1 / $odds[$c];
        }

        return ['odds' => $odds, 'weights' => $weights, 'total' => $total, 'prob' => $prob, 'rtpBy' => $rtpBy,
            'rtpMin' => min($rtpBy), 'rtpMax' => max($rtpBy), 'rtp' => 1 / $inv];
    }

    /**
     * Draw weights for an RTP setting between 88% and 99%, odds unchanged: the 12 pairs with the higher odds return exactly
     * $rtp, the three cheapest pairs share what is left (about 85.4% at a 90% setting).
     */
    public static function buildForRtp(?array $odds, float $rtp): array
    {
        $odds ??= self::DEFAULT_ODDS;
        $combos = self::combos();
        if (! ($rtp >= self::MIN_RTP - 1e-9 && $rtp <= self::MAX_RTP + 1e-9)) {
            throw new InvalidArgumentException('RTP must be between 88% and 99%');
        }
        $S = 0.0;
        foreach ($combos as $c) {
            $S += 1 / $odds[$c];
        }
        $uniform = 1 / $S;
        if ($rtp < $uniform - 1e-9) {
            throw new InvalidArgumentException('these odds cannot give an RTP below '.number_format($uniform * 100, 2).'%');
        }
        $order = $combos;
        usort($order, fn ($a, $b) => ($odds[$a] <=> $odds[$b]) ?: strcmp($a, $b));
        $cheap = array_slice($order, 0, self::CHEAP_PAIRS);
        $a = 0.0;
        foreach ($cheap as $c) {
            $a += 1 / $odds[$c];
        }
        $r = (1 - $rtp * ($S - $a)) / $a;
        $prob = [];
        foreach ($combos as $c) {
            $prob[$c] = (in_array($c, $cheap, true) ? $r : $rtp) / $odds[$c];
        }
        $weights = array_map(fn ($c) => self::jsRound($prob[$c] * 1e9), $combos);
        $total = array_sum($weights);
        $rtpBy = [];
        foreach ($combos as $i => $c) {
            $prob[$c] = $weights[$i] / $total;
            $rtpBy[$c] = $prob[$c] * $odds[$c];
        }

        return [
            'odds' => $odds, 'weights' => $weights, 'total' => $total, 'prob' => $prob, 'rtpBy' => $rtpBy, 'setting' => $rtp, 'uniform' => $uniform,
            'cheap' => $cheap, 'cheapRtp' => min(array_map(fn ($c) => $rtpBy[$c], $cheap)), 'bestRtp' => max($rtpBy),
            'evenSpread' => array_sum($rtpBy) / count($rtpBy),
        ];
    }
}
