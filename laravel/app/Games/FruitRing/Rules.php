<?php

namespace App\Games\FruitRing;

/**
 * Fruit Ring: the fixed rules (docs/fruit/MATH.md). A ring of 24 cells; the player puts credits on any of 8 symbols; a light stops on one cell, drawn by the server by weight;
 * a Lucky stop gives free spins (3 of them, or one with 3 lit cells); every lit cell pays the bets on its symbol; a x3 cell pays three times. After a win the player may double it (Small 1-7 / Big 8-14, a fair
 * 50/50), up to three times in a row. Nothing here is ever changed once the game is certified: other pays or weights are a new version with a new id.
 */
final class Rules
{
    public const ID = 'fruit-ring';

    public const PAYTABLE_ID = 'fr-v90-2';

    public const TOTAL_WEIGHT = 100000;

    /** the eight bets, in the order of the bets array */
    public const SYMBOLS = ['bar', 'seven', 'star', 'watermelon', 'bell', 'lemon', 'orange', 'apple'];

    /** credits paid for one credit on the symbol when its cell lights (stake included) */
    public const PAYS = ['bar' => 30, 'seven' => 10, 'star' => 7, 'watermelon' => 5, 'bell' => 5, 'lemon' => 4, 'orange' => 2, 'apple' => 2];

    /** the BAR x50 cell pays this for a credit on BAR (the BAR BAR BAR cell pays PAYS['bar']) */
    public const BAR50 = 12;

    public const DOUBLE_MAX = 3;

    public const DOUBLE_NUMBERS = 14;

    /** the 24 cells clockwise from the top left: [symbol, multiplier, weight]. The two Lucky cells pay nothing themselves: 'free3' gives 3 free spins (one lit cell each), 'light3' one free spin with 3 lit
     *  cells; 'bar3' and 'bar50' are the two BAR cells */
    public const RING = [
        ['orange', 1, 8041], ['bell', 1, 3216], ['bar50', 1, 1914], ['bar3', 1, 1914], ['apple', 1, 5744], ['apple', 3, 5744], ['lemon', 1, 4020],
        ['watermelon', 1, 4020], ['watermelon', 3, 4020], ['free3', 1, 1908], ['apple', 1, 5744], ['orange', 3, 8041],
        ['orange', 1, 8041], ['bell', 1, 3216], ['seven', 3, 2010], ['seven', 1, 2010], ['apple', 1, 5744], ['lemon', 3, 4020], ['lemon', 1, 4020],
        ['star', 3, 2872], ['star', 1, 2872], ['light3', 1, 1909], ['apple', 1, 5744], ['bell', 3, 3216],
    ];

    /** @return list<int> the cells that are Lucky */
    public static function luckyCells(): array
    {
        return array_keys(array_filter(self::RING, fn ($c) => in_array($c[0], ['free3', 'light3'], true)));
    }

    /** the symbol (one of SYMBOLS) a cell belongs to, or 'lucky' */
    public static function symbolOf(int $cell): string
    {
        $c = self::RING[$cell][0];

        return in_array($c, ['bar3', 'bar50'], true) ? 'bar' : (in_array($c, ['free3', 'light3'], true) ? 'lucky' : $c);
    }

    /** credits paid for one credit on the cell's symbol when this cell lights */
    public static function cellPay(int $cell): int
    {
        [$c, $m] = self::RING[$cell];

        return match ($c) {
            'bar3' => self::PAYS['bar'],
            'bar50' => self::BAR50,
            'free3', 'light3' => 0,
            default => self::PAYS[$c] * $m,
        };
    }

    public static function paytable(): array
    {
        $ring = [];
        foreach (self::RING as $i => [$c, $m]) {
            $ring[] = ['cell' => $i, 'symbol' => self::symbolOf($i), 'kind' => $c, 'multiplier' => $m, 'pay' => self::cellPay($i)];
        }

        return ['id' => self::PAYTABLE_ID, 'symbols' => self::SYMBOLS, 'pays' => self::PAYS, 'bar50' => self::BAR50, 'ring' => $ring, 'doubleMax' => self::DOUBLE_MAX, 'doubleNumbers' => self::DOUBLE_NUMBERS];
    }

    /** a stable text of everything that decides a result or a payout: its sha256 is frozen in a test */
    public static function canonical(): string
    {
        return json_encode([self::PAYTABLE_ID, self::TOTAL_WEIGHT, self::SYMBOLS, self::PAYS, self::BAR50, self::DOUBLE_MAX, self::DOUBLE_NUMBERS, self::RING], JSON_THROW_ON_ERROR);
    }
}
