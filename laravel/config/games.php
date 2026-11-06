<?php

/*
 * The games this server can run. Every game is a module (App\Platform\Games\GameModule). A client plays only the games in its own "games" list;
 * a client that has none plays the games in "default". Bingo Pinball is in the defaults (BINGO_DEFAULT_ON=false takes it out again) and plays the paytable of
 * "default_paytable" unless the client has its own; an operator can still give a client its own games list and paytable.
 */
return [
    // the games every client has unless its own list says otherwise
    'default' => array_values(array_filter(['horse-race', filter_var(env('BINGO_DEFAULT_ON', true), FILTER_VALIDATE_BOOLEAN) ? 'bingo-pinball' : null])),

    // game id => the class of its module
    'modules' => [
        'horse-race' => App\Games\HorseRace\HorseRaceModule::class,
        'bingo-pinball' => App\Games\BingoPinball\BingoPinballModule::class,
    ],

    // settings of the games themselves
    'settings' => [
        'bingo-pinball' => [
            'default_paytable' => (int) env('BINGO_DEFAULT_PAYTABLE', 90),      // the RTP version (88, 90, 92, 94 or 96) of a client that has no paytable of its own
            'min_interval_ms' => (int) env('BINGO_MIN_INTERVAL_MS', 3000),      // at least this long between two plays of a player
            'rotate_every' => (int) env('BINGO_ROTATE_EVERY', 1000),            // the seed pair is replaced (and the old server seed revealed) after this many plays
            'lock_wait_seconds' => 5,                                            // how long a play waits for the player's other action to finish
            'stuck_after_ms' => 30000,                                           // a play still waiting for its debit this long after it started is cancelled
        ],
    ],
];
