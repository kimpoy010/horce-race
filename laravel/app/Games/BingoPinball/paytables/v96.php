<?php

/*
 * Bingo Pinball paytable, version 96. FROZEN: once a version is in use, its file is never edited. A change of pays or card is a new file with a new id
 * (for example v96r2) and an entry in tests/Unit/BingoMathTest.php (FROZEN) made on purpose.
 *
 * pays: stake multiples for the best line (3, 4 or 5 lit cells), the stake included. The card shows one hole number per cell, row by row; the layout is cosmetic.
 * publishedRtp: the exact RTP rounded to 2 decimals as printed on the rules sheet; `php artisan bingo:par` must reproduce it.
 */

return [
    'id' => 'bp-v96-1',
    'version' => 96,
    'pays' => [3 => 2, 4 => 6, 5 => 150],
    'publishedRtp' => '96.53',
    'card' => [
         4,  8, 21, 19, 20,
         3, 18,  5, 15, 16,
        24,  2, 14, 23, 17,
        25,  6, 11, 12, 10,
         9,  1, 22, 13,  7,
    ],
];
