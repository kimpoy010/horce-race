<?php

/*
 * Bingo Pinball paytable, version 92. FROZEN: once a version is in use, its file is never edited. A change of pays or card is a new file with a new id
 * (for example v92r2) and an entry in tests/Unit/BingoMathTest.php (FROZEN) made on purpose.
 *
 * pays: stake multiples for the best line (3, 4 or 5 lit cells), the stake included. The card shows one hole number per cell, row by row; the layout is cosmetic.
 * publishedRtp: the exact RTP rounded to 2 decimals as printed on the rules sheet; `php artisan bingo:par` must reproduce it.
 */

return [
    'id' => 'bp-v92-1',
    'version' => 92,
    'pays' => [3 => 2, 4 => 5, 5 => 50],
    'publishedRtp' => '92.02',
    'card' => [
        23, 10, 14, 13, 17,
        11,  6,  9, 18, 15,
         2, 12, 20, 22, 16,
        24,  7,  4, 21,  5,
         3, 25, 19,  1,  8,
    ],
];
