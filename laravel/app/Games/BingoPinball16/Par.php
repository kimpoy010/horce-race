<?php

namespace App\Games\BingoPinball16;

/**
 * The PAR figures of the paytable by enumerating every set of lit slots (65,536) with its exact probability (inclusion-exclusion over the sets), through the same Evaluator
 * the game uses. PHP has no big integers here, so this is double-precision arithmetic (good to about 1e-10); the EXACT figures, with big integers, come from
 * docs/bingo16/verify_play.py and are in docs/bingo16/par.json: the test requires the two to agree.
 */
final class Par
{
    /** @return array{patterns:array<string,float>, rtp:float, hit:float, standardDeviation:float, jackpot:float, expectedLit:float} */
    public static function enumerate(): array
    {
        $n = Rules::SLOTS;
        $size = 1 << $n;
        $out = (Rules::TOTAL_WEIGHT - Rules::SLOT_WEIGHT * Rules::SLOTS) / Rules::TOTAL_WEIGHT;
        $p = Rules::SLOT_WEIGHT / Rules::TOTAL_WEIGHT;
        $pop = [0];
        for ($s = 1; $s < $size; $s++) {
            $pop[$s] = $pop[$s >> 1] + ($s & 1);
        }
        $g = [];
        for ($s = 0; $s < $size; $s++) {
            $g[$s] = ($out + $p * $pop[$s]) ** Rules::BALLS;          // P(every ball is OUT or lands in a slot of the set)
        }
        for ($i = 0; $i < $n; $i++) {                                  // inclusion-exclusion: P(the lit set is exactly S)
            $b = 1 << $i;
            for ($s = 0; $s < $size; $s++) {
                if ($s & $b) {
                    $g[$s] -= $g[$s ^ $b];
                }
            }
        }
        $patterns = array_fill_keys(array_keys(Rules::PATTERNS), 0.0);
        $jackpot = 0.0;
        $lit = 0.0;
        $c5 = self::choose(Rules::SLOTS, Rules::JACKPOT_NUMBERS);
        for ($s = 0; $s < $size; $s++) {
            $k = $pop[$s];
            $lit += $g[$s] * $k;
            $jackpot += $g[$s] * self::choose($k, Rules::JACKPOT_NUMBERS) / $c5;
            $balls = [];
            for ($c = 0; $c < $n; $c++) {
                if ($s >> $c & 1) {
                    $balls[] = $c + 1;
                }
            }
            $e = Evaluator::evaluate($balls, [1, 2, 3, 4, 5]);
            if ($e['pattern'] !== null) {
                $patterns[$e['pattern']] += $g[$s];
            }
        }
        $rtp = 0.0;
        $second = 0.0;
        foreach ($patterns as $k => $pr) {
            $m = Rules::PATTERNS[$k][1];
            $rtp += $pr * $m;
            $second += $pr * $m * $m;
        }

        return ['patterns' => $patterns, 'rtp' => $rtp, 'hit' => array_sum($patterns), 'standardDeviation' => sqrt($second - $rtp * $rtp), 'jackpot' => $jackpot, 'expectedLit' => $lit];
    }

    private static function choose(int $n, int $k): int
    {
        if ($k > $n) {
            return 0;
        }
        $r = 1;
        for ($i = 1; $i <= $k; $i++) {
            $r = intdiv($r * ($n - $k + $i), $i);
        }

        return $r;
    }
}
