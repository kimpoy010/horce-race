<?php

namespace App\Games\FruitRing;

/**
 * The PAR figures by enumerating every outcome of a spin (22 direct stops and 2 x 22 x 22 Lucky outcomes) with its probability, through the same Evaluator the game uses.
 * Double-precision (good to about 1e-12); the EXACT figures, with fractions, come from docs/fruit/verify_play.py and are in docs/fruit/par.json: the test requires them to agree.
 */
final class Par
{
    /** @return array{symbols:array<string,array{rtp:float,hit:float,standardDeviation:float,stop:float}>, allEightRtp:float, luckyShare:float} */
    public static function enumerate(): array
    {
        $w = Rules::TOTAL_WEIGHT;
        $lucky = Rules::luckyCells();
        $non = array_values(array_diff(range(0, 23), $lucky));
        $wn = array_sum(array_map(fn ($i) => Rules::RING[$i][2], $non));
        $outcomes = [];
        foreach ($non as $i) {
            $outcomes[] = [Rules::RING[$i][2] / $w, [$i]];
        }
        $qL = 0.0;
        foreach ($lucky as $l) {
            $qs = Rules::RING[$l][2] / $w;
            $qL += $qs;
            foreach ($non as $a) {
                foreach ($non as $b) {
                    $outcomes[] = [$qs * (Rules::RING[$a][2] / $wn) * (Rules::RING[$b][2] / $wn), [$l, $a, $b]];
                }
            }
        }
        $sym = [];
        $total = 0.0;
        foreach (Rules::SYMBOLS as $s) {
            $ev = $ev2 = $hit = 0.0;
            foreach ($outcomes as [$p, $lit]) {
                $x = Evaluator::payouts($lit)[$s];
                $ev += $p * $x;
                $ev2 += $p * $x * $x;
                $hit += $x > 0 ? $p : 0.0;
            }
            $stop = 0.0;
            for ($i = 0; $i < 24; $i++) {
                $stop += Rules::symbolOf($i) === $s ? Rules::RING[$i][2] / $w : 0.0;
            }
            $sym[$s] = ['rtp' => $ev, 'hit' => $hit, 'standardDeviation' => sqrt($ev2 - $ev * $ev), 'stop' => $stop];
            $total += $ev;
        }

        return ['symbols' => $sym, 'allEightRtp' => $total / 8, 'luckyShare' => $qL];
    }
}
