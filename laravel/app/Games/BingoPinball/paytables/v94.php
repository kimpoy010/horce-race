<?php

/*
 * Bingo Pinball paytable, version 94. FROZEN: once a version is in use, its file is never edited. A change of pays or card is a new file with a new id
 * (for example v94r2) and an entry in tests/Unit/BingoMathTest.php (FROZEN) made on purpose.
 *
 * pays: stake multiples for the best line (3, 4 or 5 lit cells), the stake included. The card shows one hole number per cell, row by row; the layout is cosmetic.
 * publishedRtp: the exact RTP rounded to 2 decimals as printed on the rules sheet; `php artisan bingo:par` must reproduce it.
 */

return [
    'id' => 'bp-v94-1',
    'version' => 94,
    'pays' => [3 => 2, 4 => 5, 5 => 150],
    'publishedRtp' => '94.27',
    'card' => [
        20, 10,  6, 24, 21,
        13, 11, 16,  1,  5,
         7,  4, 25, 17,  3,
         2, 18, 15,  9, 12,
        14, 23, 19,  8, 22,
    ],
];
