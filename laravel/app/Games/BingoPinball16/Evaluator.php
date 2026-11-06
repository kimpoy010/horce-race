<?php

namespace App\Games\BingoPinball16;

/** What a play pays: the lit cells, the pattern (complete lines) and the jackpot numbers that hold two balls. Pure functions of (balls, jackpot numbers). */
final class Evaluator
{
    /**
     * @param  list<int>  $balls  the slot of each ball (1-16)
     * @param  list<int>  $jackpotNumbers  five numbers 1-16
     * @return array{lit:list<int>, pattern:?string, multiple:int, jackpotLit:int, jackpot:bool, lines:list<int>}
     */
    public static function evaluate(array $balls, array $jackpotNumbers): array
    {
        $cells = [];
        foreach ($balls as $b) {
            $cells[$b - 1] = true;
        }
        $fullLines = [];
        foreach (Rules::LINES as $i => $line) {
            if (! array_diff_key(array_flip($line), $cells)) {
                $fullLines[] = $i;
            }
        }
        $pattern = null;
        foreach (Rules::PATTERNS as $key => [, , $least]) {
            if (count($fullLines) >= $least) {
                $pattern = $key;
                break;
            }
        }
        $counts = array_count_values($balls);
        $jackpotLit = 0;
        foreach ($jackpotNumbers as $n) {
            if (($counts[$n] ?? 0) >= Rules::JACKPOT_MIN_BALLS) {
                $jackpotLit++;
            }
        }
        $lit = array_map(fn ($c) => $c + 1, array_keys($cells));
        sort($lit);

        return ['lit' => $lit, 'pattern' => $pattern, 'multiple' => $pattern === null ? 0 : Rules::PATTERNS[$pattern][1], 'jackpotLit' => $jackpotLit,
            'jackpot' => $jackpotLit === Rules::JACKPOT_NUMBERS, 'lines' => $fullLines];
    }
}
