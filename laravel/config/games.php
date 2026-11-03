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
    ],
];
