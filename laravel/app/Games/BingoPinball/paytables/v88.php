<?php

/*
 * Bingo Pinball paytable, version 88. FROZEN: once a version is in use, its file is never edited. A change of pays or card is a new file with a new id
 * (for example v88r2) and an entry in tests/Unit/BingoMathTest.php (FROZEN) made on purpose.
 *
 * pays: stake multiples for the best line (3, 4 or 5 lit cells), the stake included. The card shows one hole number per cell, row by row; the layout is cosmetic.
 * publishedRtp: the exact RTP rounded to 2 decimals as printed on the rules sheet; `php artisan bingo:par` must reproduce it.
 */

return [
    'id' => 'bp-v88-1',
    'version' => 88,
    'pays' => [3 => 2, 4 => 3, 5 => 75],
    'publishedRtp' => '88.06',
    'card' => [
        12,  1,  7,  4, 21,
        22, 15,  3, 25,  9,
         6,  2, 24, 16, 14,
        13,  8, 11, 23, 17,
        20, 19, 10,  5, 18,
    ],
];
