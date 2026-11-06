<?php

namespace App\Games\BingoPinball16;

/** What a play pays: the lit cells, the best pattern and the jackpot numbers that are lit. Pure functions of (balls, jackpot numbers). */
final class Evaluator
{
    /**
     * @param  list<int>  $balls  the slot of each ball (1-16) or 0 for OUT
     * @param  list<int>  $jackpotNumbers  five numbers 1-16
     * @return array{lit:list<int>, pattern:?string, multiple:int, jackpotLit:int, jackpot:bool, lines:list<int>}
     */
    public static function evaluate(array $balls, array $jackpotNumbers): array
    {
        $cells = [];
        foreach ($balls as $b) {
            if ($b > 0) {
                $cells[$b - 1] = true;
            }
        }
        $has = fn (array $set) => ! array_diff_key(array_flip($set), $cells);
        $fullLines = [];
        foreach (Rules::LINES as $i => $line) {
            if ($has($line)) {
                $fullLines[] = $i;
            }
        }
        $pattern = null;
        if (count($fullLines) >= 2) {
            $pattern = 'lines2';
        } elseif ($has(Rules::CORNERS)) {
            $pattern = 'corners';
        } elseif (count($fullLines) === 1) {
            $pattern = 'fullline';
        } else {
            foreach (Rules::SQUARES as $q) {
                if ($has($q)) {
                    $pattern = 'square';
                    break;
                }
            }
            if ($pattern === null) {
                foreach (Rules::LINES as $line) {
                    if (count(array_intersect_key(array_flip($line), $cells)) >= 3) {
                        $pattern = 'three';
                        break;
                    }
                }
            }
        }
        $jackpotLit = 0;
        foreach ($jackpotNumbers as $n) {
            if (isset($cells[$n - 1])) {
                $jackpotLit++;
            }
        }
        $lit = array_map(fn ($c) => $c + 1, array_keys($cells));
        sort($lit);

        return ['lit' => $lit, 'pattern' => $pattern, 'multiple' => $pattern === null ? 0 : Rules::PATTERNS[$pattern][1], 'jackpotLit' => $jackpotLit,
            'jackpot' => $jackpotLit === Rules::JACKPOT_NUMBERS, 'lines' => $fullLines];
    }
}
