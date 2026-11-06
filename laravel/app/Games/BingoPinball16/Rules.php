<?php

namespace App\Games\BingoPinball16;

/**
 * Bingo Pinball 16: the fixed rules (docs/bingo16/MATH.md). 16 balls are played; every ball ends in one of 16 slots (the slots fill the floor, nothing drains out); a slot with a
 * ball lights its cell on a 4 x 4 card (slot k lights cell k, numbered 1-16 row by row); the number of complete lines pays a multiple of the stake; five random jackpot numbers decide
 * the progressive jackpot (each needs at least two balls).
 * Nothing here is ever changed once a game is certified: a different paytable is a new game version.
 */
final class Rules
{
    public const ID = 'bingo-pinball-16';

    public const PAYTABLE_ID = 'b16-v90-2';

    public const BALLS = 16;

    public const SLOTS = 16;

    /** every ball is one number below TOTAL_WEIGHT: slot k for [625 (k-1), 625 k) */
    public const TOTAL_WEIGHT = 10000;

    public const SLOT_WEIGHT = 625;

    public const JACKPOT_NUMBERS = 5;

    /** a jackpot number is lit when its slot holds at least this many balls */
    public const JACKPOT_MIN_BALLS = 2;

    /** pattern key => [name, multiple of the stake, stake included, the fewest complete lines]; by how many of the 10 lines are complete; the best first: the first one that fits pays; one line pays nothing */
    public const PATTERNS = [
        'lines8' => ['8+ LINES', 125, 8],
        'lines6' => ['6-7 LINES', 20, 6],
        'lines5' => ['5 LINES', 10, 5],
        'lines4' => ['4 LINES', 5, 4],
        'lines3' => ['3 LINES', 2, 3],
        'lines2' => ['2 LINES', 1, 2],
    ];

    /** the 10 lines of the card: 4 rows, 4 columns, 2 diagonals (cell indexes 0-15) */
    public const LINES = [
        [0, 1, 2, 3], [4, 5, 6, 7], [8, 9, 10, 11], [12, 13, 14, 15],
        [0, 4, 8, 12], [1, 5, 9, 13], [2, 6, 10, 14], [3, 7, 11, 15],
        [0, 5, 10, 15], [3, 6, 9, 12],
    ];

    /** the paytable as data (what the page and the proof show) */
    public static function paytable(): array
    {
        $pays = [];
        foreach (self::PATTERNS as $k => [$name, $m, $lines]) {
            $pays[] = ['key' => $k, 'name' => $name, 'multiple' => $m, 'lines' => $lines];
        }

        return ['id' => self::PAYTABLE_ID, 'balls' => self::BALLS, 'slots' => self::SLOTS, 'pays' => $pays, 'jackpotNumbers' => self::JACKPOT_NUMBERS, 'jackpotMinBalls' => self::JACKPOT_MIN_BALLS];
    }

    /** a stable text of everything that decides a result or a payout: its sha256 is frozen in a test, so the rules cannot change by accident */
    public static function canonical(): string
    {
        return json_encode([self::PAYTABLE_ID, self::BALLS, self::SLOTS, self::TOTAL_WEIGHT, self::SLOT_WEIGHT, self::JACKPOT_NUMBERS, self::JACKPOT_MIN_BALLS, self::PATTERNS, self::LINES], JSON_THROW_ON_ERROR);
    }
}
