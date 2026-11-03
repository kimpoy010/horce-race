<?php

/*
 * The games this server can run. Every game is a module (App\Platform\Games\GameModule). A client plays only the games in its own "games" list;
 * a client that has none plays the games in "default". New games ship switched off: they are listed under "modules" but not under "default".
 */
return [
    // the games every client has unless its own list says otherwise
    'default' => ['horse-race'],

    // game id => the class of its module
    'modules' => [
        'horse-race' => App\Games\HorseRace\HorseRaceModule::class,
        'bingo-pinball' => App\Games\BingoPinball\BingoPinballModule::class,          // ships switched off: not in 'default'
    ],

    // settings of the games themselves
    'settings' => [
        'bingo-pinball' => [
            'min_interval_ms' => (int) env('BINGO_MIN_INTERVAL_MS', 3000),      // at least this long between two plays of a player
            'rotate_every' => (int) env('BINGO_ROTATE_EVERY', 1000),            // the seed pair is replaced (and the old server seed revealed) after this many plays
            'lock_wait_seconds' => 5,                                            // how long a play waits for the player's other action to finish
            'stuck_after_ms' => 30000,                                           // a play still waiting for its debit this long after it started is cancelled
        ],
    ],
];
