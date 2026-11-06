<?php

namespace App\Games\FruitRing;

/** What a spin pays: for one credit on each symbol, and for a set of bets. Pure functions of the lit cells. */
final class Evaluator
{
    /**
     * @param  list<int>  $lit  the cells that lit (the same cell twice pays twice)
     * @return array<string,int> credits paid for ONE credit on each symbol
     */
    public static function payouts(array $lit): array
    {
        $out = array_fill_keys(Rules::SYMBOLS, 0);
        foreach ($lit as $cell) {
            $s = Rules::symbolOf($cell);
            if ($s !== 'lucky') {
                $out[$s] += Rules::cellPay($cell);
            }
        }

        return $out;
    }

    /**
     * @param  list<int>  $lit
     * @param  array<string,int>  $bets  credits on each symbol (missing = 0)
     * @return int credits paid in total
     */
    public static function pay(array $lit, array $bets): int
    {
        $p = self::payouts($lit);
        $total = 0;
        foreach (Rules::SYMBOLS as $s) {
            $total += ((int) ($bets[$s] ?? 0)) * $p[$s];
        }

        return $total;
    }

    /** whether a number 1-14 is on the side the player chose ('small' = 1-7, 'big' = 8-14) */
    public static function doubleWins(int $number, string $side): bool
    {
        return $side === 'small' ? $number <= 7 : $number >= 8;
    }
}
