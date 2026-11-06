<?php

namespace App\Games\BingoPinball16;

/**
 * Bingo Pinball 16: the fixed rules (docs/bingo16/MATH.md). 16 balls are played; every ball drains OUT or ends in one of 16 slots; a slot with a ball lights its cell on a
 * 4 x 4 card (slot k lights cell k, numbered 1-16 row by row); the best pattern pays a multiple of the stake; five random jackpot numbers decide the progressive jackpot.
 * Nothing here is ever changed once a game is certified: a different paytable is a new game version.
 */
final class Rules
{
    public const ID = 'bingo-pinball-16';

    public const PAYTABLE_ID = 'b16-v90-1';

    public const BALLS = 16;

    public const SLOTS = 16;

    /** every ball is one number below TOTAL_WEIGHT: slot k for [184 (k-1), 184 k), drained OUT from 16 x 184 = 2,944 up */
    public const TOTAL_WEIGHT = 10000;

    public const SLOT_WEIGHT = 184;

    public const JACKPOT_NUMBERS = 5;

    /** pattern key => [name, multiple of the stake, stake included]; the best pattern first: the first one that is lit pays, patterns never add up */
    public const PATTERNS = [
        'lines2' => ['2+ LINES', 30],
        'corners' => ['4 CORNERS', 15],
        'fullline' => ['FULL LINE', 5],
        'square' => ['2x2 SQUARE', 2],
        'three' => ['3 ON LINE', 2],
    ];

    /** the 10 lines of the card: 4 rows, 4 columns, 2 diagonals (cell indexes 0-15) */
    public const LINES = [
        [0, 1, 2, 3], [4, 5, 6, 7], [8, 9, 10, 11], [12, 13, 14, 15],
        [0, 4, 8, 12], [1, 5, 9, 13], [2, 6, 10, 14], [3, 7, 11, 15],
        [0, 5, 10, 15], [3, 6, 9, 12],
    ];

    public const CORNERS = [0, 3, 12, 15];

    /** the 9 blocks of 2 x 2 cells */
    public const SQUARES = [
        [0, 1, 4, 5], [1, 2, 5, 6], [2, 3, 6, 7],
        [4, 5, 8, 9], [5, 6, 9, 10], [6, 7, 10, 11],
        [8, 9, 12, 13], [9, 10, 13, 14], [10, 11, 14, 15],
    ];

    /** the paytable as data (what the page and the proof show) */
    public static function paytable(): array
    {
        $pays = [];
        foreach (self::PATTERNS as $k => [$name, $m]) {
            $pays[] = ['key' => $k, 'name' => $name, 'multiple' => $m];
        }

        return ['id' => self::PAYTABLE_ID, 'balls' => self::BALLS, 'slots' => self::SLOTS, 'pays' => $pays, 'jackpotNumbers' => self::JACKPOT_NUMBERS];
    }

    /** a stable text of everything that decides a result or a payout: its sha256 is frozen in a test, so the rules cannot change by accident */
    public static function canonical(): string
    {
        return json_encode([self::PAYTABLE_ID, self::BALLS, self::SLOTS, self::TOTAL_WEIGHT, self::SLOT_WEIGHT, self::JACKPOT_NUMBERS, self::PATTERNS, self::LINES, self::CORNERS, self::SQUARES], JSON_THROW_ON_ERROR);
    }
}
