<?php

/*
 * Bingo Pinball paytable, version 90. FROZEN: once a version is in use, its file is never edited. A change of pays or card is a new file with a new id
 * (for example v90r2) and an entry in tests/Unit/BingoMathTest.php (FROZEN) made on purpose.
 *
 * pays: stake multiples for the best line (3, 4 or 5 lit cells), the stake included. The card shows one hole number per cell, row by row; the layout is cosmetic.
 * publishedRtp: the exact RTP rounded to 2 decimals as printed on the rules sheet; `php artisan bingo:par` must reproduce it.
 */

return [
    'id' => 'bp-v90-1',
    'version' => 90,
    'pays' => [3 => 2, 4 => 4, 5 => 60],
    'publishedRtp' => '89.98',
    'card' => [
        12,  1,  3, 23,  4,
        18, 19, 21, 13, 20,
        16,  9,  5,  7,  2,
        25, 15, 17, 24, 14,
        22, 11,  6,  8, 10,
    ],
];
