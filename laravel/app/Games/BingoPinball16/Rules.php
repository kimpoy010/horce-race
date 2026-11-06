<?php

namespace App\Games\BingoPinball16;

/**
 * Bingo Pinball 16: the fixed rules (docs/bingo16/MATH.md). 16 balls are played; every ball ends in one of 16 slots (the slots fill the floor) or falls into one of three baskets among the pegs and is MISSED; a slot with a
 * ball lights its cell on a 4 x 4 card (slot k lights cell k, numbered 1-16 row by row); the best complete pattern (of twelve) pays a multiple of the stake; five random jackpot numbers decide
 * the progressive jackpot (each needs at least two balls).
 * Nothing here is ever changed once a game is certified: a different paytable is a new game version.
 */
final class Rules
{
    public const ID = 'bingo-pinball-16';

    public const PAYTABLE_ID = 'b16-v90-3';

    public const BALLS = 16;

    public const SLOTS = 16;

    /** every ball is one number below TOTAL_WEIGHT: a MISS (it falls into a basket) for [0, 1,600), then slot k for [1,600 + 525 (k-1), 1,600 + 525 k) */
    public const TOTAL_WEIGHT = 10000;

    public const SLOT_WEIGHT = 525;

    /** 16% of the balls miss: they fall into one of the three baskets among the pegs */
    public const MISS_WEIGHT = 1600;

    /** three baskets take the place of three of ten pegs, new ones for every play */
    public const BASKETS = 3;

    public const BASKET_SPOTS = 10;

    public const JACKPOT_NUMBERS = 5;

    /** a jackpot number is lit when its slot holds at least this many balls */
    public const JACKPOT_MIN_BALLS = 2;

    /**
     * The twelve winning patterns, best first: the first one that is complete pays, patterns never add up. key => [name, pay in HALF stakes, the ways to make it (each a list of card cells 0-15, row by row)].
     * A pay of 1 is half the stake, 2 the stake itself, 10 five times the stake; the payout is floor(stake x halves / 2).
     */
    public const PATTERNS = [
        'full' => ['FULL CARD', 10000, [[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]]],
        'bigbox' => ['BIG BOX', 1000, [[0, 1, 2, 3, 4, 7, 8, 11, 12, 13, 14, 15]]],
        'zshape' => ['Z SHAPE', 160, [[0, 1, 2, 3, 6, 9, 12, 13, 14, 15]]],
        'equal' => ['EQUAL', 20, [[0, 1, 2, 3, 12, 13, 14, 15]]],
        'eleven' => ['NUMBER ELEVEN', 20, [[0, 4, 8, 12, 3, 7, 11, 15]]],
        'lucky7' => ['LUCKY SEVEN', 8, [[0, 1, 2, 3, 6, 9, 12]]],
        'lshape' => ['L SHAPE', 8, [[0, 4, 8, 12, 13, 14, 15]]],
        'corners' => ['4 CORNERS', 4, [[0, 3, 12, 15]]],
        'smallbox' => ['SMALL BOX', 4, [[5, 6, 9, 10]]],
        'diagonal' => ['DIAGONAL', 2, [[0, 5, 10, 15], [3, 6, 9, 12]]],
        'across' => ['ACROSS', 1, [[0, 1, 2, 3], [4, 5, 6, 7], [8, 9, 10, 11], [12, 13, 14, 15]]],
        'down' => ['DOWN', 1, [[0, 4, 8, 12], [1, 5, 9, 13], [2, 6, 10, 14], [3, 7, 11, 15]]],
    ];

    /** the 10 lines of the card (4 rows, 4 columns, 2 diagonals), only reported with a result */
    public const LINES = [
        [0, 1, 2, 3], [4, 5, 6, 7], [8, 9, 10, 11], [12, 13, 14, 15],
        [0, 4, 8, 12], [1, 5, 9, 13], [2, 6, 10, 14], [3, 7, 11, 15],
        [0, 5, 10, 15], [3, 6, 9, 12],
    ];

    /** the pay of a pattern as a multiple of the stake */
    public static function multipleOf(string $pattern): float
    {
        return self::PATTERNS[$pattern][1] / 2;
    }

    /** the pattern pay of a stake (minor units, rounded down) */
    public static function pay(string $pattern, int $stake): int
    {
        return intdiv($stake * self::PATTERNS[$pattern][1], 2);
    }

    /** the paytable as data (what the page and the proof show) */
    public static function paytable(): array
    {
        $pays = [];
        foreach (self::PATTERNS as $k => [$name, $halves, $ways]) {
            $pays[] = ['key' => $k, 'name' => $name, 'multiple' => $halves / 2, 'cells' => array_map(fn ($c) => $c + 1, $ways[0])];
        }

        return ['id' => self::PAYTABLE_ID, 'balls' => self::BALLS, 'slots' => self::SLOTS, 'pays' => $pays, 'jackpotNumbers' => self::JACKPOT_NUMBERS, 'jackpotMinBalls' => self::JACKPOT_MIN_BALLS];
    }

    /** a stable text of everything that decides a result or a payout: its sha256 is frozen in a test, so the rules cannot change by accident */
    public static function canonical(): string
    {
        return json_encode([self::PAYTABLE_ID, self::BALLS, self::SLOTS, self::TOTAL_WEIGHT, self::SLOT_WEIGHT, self::MISS_WEIGHT, self::BASKETS, self::BASKET_SPOTS, self::JACKPOT_NUMBERS, self::JACKPOT_MIN_BALLS, self::PATTERNS, self::LINES], JSON_THROW_ON_ERROR);
    }
}
