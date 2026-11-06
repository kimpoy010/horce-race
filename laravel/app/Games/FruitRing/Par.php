<?php

namespace App\Games\FruitRing;

/**
 * The PAR figures by enumerating every outcome of a spin (22 direct stops and 2 x 22^3 Lucky outcomes) with its probability, through the same Evaluator the game uses.
 * Double-precision (good to about 1e-12); the EXACT figures, with fractions, come from docs/fruit/verify_play.py and are in docs/fruit/par.json: the test requires them to agree.
 */
final class Par
{
    private static ?array $figures = null;

    /** @return array<string,array{rtp:float,sd:float}> the return and the standard deviation of one credit on each symbol (computed once) */
    public static function symbolFigures(): array
    {
        if (self::$figures === null) {
            self::$figures = [];
            foreach (self::enumerate()['symbols'] as $sym => $f) {
                self::$figures[$sym] = ['rtp' => $f['rtp'], 'sd' => $f['standardDeviation']];
            }
        }

        return self::$figures;
    }

    /** what the maths expects a spin on these bets to win, and an upper bound of the variance (the symbols are treated as perfectly correlated, which can only overstate it), in credits */
    public static function spinFigures(array $bets): array
    {
        $f = self::symbolFigures();
        $exp = 0.0;
        $sd = 0.0;
        foreach ($bets as $sym => $n) {
            $exp += $n * $f[$sym]['rtp'];
            $sd += $n * $f[$sym]['sd'];
        }

        return ['expected' => $exp, 'variance' => $sd * $sd];
    }

    /** @return array{symbols:array<string,array{rtp:float,hit:float,standardDeviation:float,stop:float}>, allEightRtp:float, luckyShare:float} */
    public static function enumerate(): array
    {
        $w = Rules::TOTAL_WEIGHT;
        $lucky = Rules::luckyCells();
        $non = array_values(array_diff(range(0, 23), $lucky));
        $wn = array_sum(array_map(fn ($i) => Rules::RING[$i][2], $non));
        $outcomes = [];
        foreach ($non as $i) {
            $outcomes[] = [Rules::RING[$i][2] / $w, [[$i]]];
        }
        $qL = 0.0;
        foreach ($lucky as $l) {
            $qs = Rules::RING[$l][2] / $w;
            $qL += $qs;
            $free3 = Rules::RING[$l][0] === 'free3';
            foreach ($non as $a) {
                foreach ($non as $b) {
                    foreach ($non as $c) {
                        $outcomes[] = [$qs * (Rules::RING[$a][2] / $wn) * (Rules::RING[$b][2] / $wn) * (Rules::RING[$c][2] / $wn), $free3 ? [[$l], [$a], [$b], [$c]] : [[$l], [$a, $b, $c]]];
                    }
                }
            }
        }
        $cache = array_map(fn ($o) => [$o[0], Evaluator::payouts($o[1])], $outcomes);
        $sym = [];
        $total = 0.0;
        foreach (Rules::SYMBOLS as $s) {
            $ev = $ev2 = $hit = 0.0;
            foreach ($cache as [$p, $pay]) {
                $x = $pay[$s];
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
