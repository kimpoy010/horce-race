<?php

namespace App\Games\BingoPinball;

use App\Game\RngStream;

/**
 * The 5x5 bingo card and its 12 lines. A card is a list of 25 hole numbers, row by row: cell index = row * 5 + column, and cell i shows the number
 * card[i]. The layout is cosmetic: every hole is on exactly one cell, so the chance of any outcome is the same for every layout
 * (tests/Unit/BingoMathTest.php checks this for all of them).
 */
final class Card
{
    public const SIZE = 25;

    public const BALLS = 5;

    public const LINES = [
        [0, 1, 2, 3, 4], [5, 6, 7, 8, 9], [10, 11, 12, 13, 14], [15, 16, 17, 18, 19], [20, 21, 22, 23, 24],     // rows 0-4
        [0, 5, 10, 15, 20], [1, 6, 11, 16, 21], [2, 7, 12, 17, 22], [3, 8, 13, 18, 23], [4, 9, 14, 19, 24],     // columns 5-9
        [0, 6, 12, 18, 24], [4, 8, 12, 16, 20],                                                                 // diagonals 10 (top left to bottom right) and 11
    ];

    /** @param list<int> $layout 25 hole numbers, a permutation of 1..25 */
    public static function check(array $layout): void
    {
        $sorted = $layout;
        sort($sorted);
        if (count($layout) !== self::SIZE || $sorted !== range(1, self::SIZE)) {
            throw new \InvalidArgumentException('a card layout is a permutation of 1..25');
        }
    }

    /**
     * How the frozen layouts were made (so anyone can reproduce them): Fisher-Yates over 1..25 from the stream HMAC-SHA256(key = sha256("bingo-pinball card layout v<version>"),
     * label "card:<version>"), taking j = RngStream::int(i + 1) for i = 24 down to 1.
     *
     * @return list<int>
     */
    public static function generate(int $version): array
    {
        $s = new RngStream(hash('sha256', 'bingo-pinball card layout v'.$version), 'card:'.$version);
        $a = range(1, self::SIZE);
        for ($i = self::SIZE - 1; $i > 0; $i--) {
            $j = $s->int($i + 1);
            [$a[$i], $a[$j]] = [$a[$j], $a[$i]];
        }

        return $a;
    }

    /** the name of a line for the screen and the proof: row 1-5, column 1-5, diagonal 1-2 */
    public static function lineName(int $line): string
    {
        return $line < 5 ? 'row '.($line + 1) : ($line < 10 ? 'column '.($line - 4) : 'diagonal '.($line - 9));
    }
}
