<?php

namespace App\Games\BingoPinball16;

/**
 * The PAR figures of the paytable by enumerating every set of lit slots (65,536) with its probability (inclusion-exclusion over the sets); the jackpot (each of five numbers holds two balls) by a generating function, through the same Evaluator
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
        $pop = [0];
        for ($s = 1; $s < $size; $s++) {
            $pop[$s] = $pop[$s >> 1] + ($s & 1);
        }
        $g = [];
        for ($s = 0; $s < $size; $s++) {
            $g[$s] = ($pop[$s] / Rules::SLOTS) ** Rules::BALLS;          // P(every ball lands in a slot of the set)
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
        $lit = 0.0;
        for ($s = 0; $s < $size; $s++) {
            $k = $pop[$s];
            $lit += $g[$s] * $k;
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
        $jackpot = self::jackpotProbability();
        $rtp = 0.0;
        $second = 0.0;
        foreach ($patterns as $k => $pr) {
            $m = Rules::PATTERNS[$k][1] / 2;
            $rtp += $pr * $m;
            $second += $pr * $m * $m;
        }

        return ['patterns' => $patterns, 'rtp' => $rtp, 'hit' => array_sum($patterns), 'standardDeviation' => sqrt($second - $rtp * $rtp), 'jackpot' => $jackpot, 'expectedLit' => $lit];
    }

    /** P(five given slots each hold at least two of the 16 balls): 16! x [x^16] (e^x - 1 - x)^5 (e^x)^11 / 16^16 (double precision; the exact fraction is in docs/bingo16/par.json) */
    public static function jackpotProbability(): float
    {
        $n = Rules::BALLS;
        $fact = [1.0];
        for ($i = 1; $i <= $n; $i++) {
            $fact[$i] = $fact[$i - 1] * $i;
        }
        $mul = function (array $a, array $b) use ($n) {
            $r = array_fill(0, $n + 1, 0.0);
            foreach ($a as $i => $x) {
                foreach ($b as $j => $y) {
                    if ($i + $j <= $n) {
                        $r[$i + $j] += $x * $y;
                    }
                }
            }

            return $r;
        };
        $ex = $two = [];
        for ($i = 0; $i <= $n; $i++) {
            $ex[$i] = 1 / $fact[$i];
            $two[$i] = $i >= Rules::JACKPOT_MIN_BALLS ? $ex[$i] : 0.0;
        }
        $p = array_merge([1.0], array_fill(1, $n, 0.0));
        for ($i = 0; $i < Rules::JACKPOT_NUMBERS; $i++) {
            $p = $mul($p, $two);
        }
        for ($i = 0; $i < Rules::SLOTS - Rules::JACKPOT_NUMBERS; $i++) {
            $p = $mul($p, $ex);
        }

        return $p[$n] * $fact[$n] / (Rules::SLOTS ** $n);
    }
}
