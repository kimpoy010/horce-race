<?php

/*
 * Settings of the horse race game (the Laravel port of the Node server). Every value can be set in .env;
 * the names follow the Node server's environment variables (see docs/ and ../README).
 * Money is integer minor units (centavos).
 */
return [
    // the implicit "default" client: its wallet. mock = play money (never in production), http = the platform's wallet API
    'wallet' => env('HORSE_WALLET', 'mock'),
    'wallet_url' => env('HORSE_WALLET_URL'),
    'wallet_key' => env('HORSE_WALLET_KEY'),
    'wallet_key_id' => env('HORSE_WALLET_KEY_ID', ''),
    'wallet_auth' => env('HORSE_WALLET_AUTH', 'hmac'),          // hmac | bearer
    'wallet_timeout_ms' => (int) env('HORSE_WALLET_TIMEOUT_MS', 8000),
    'mock_start_balance' => (int) env('HORSE_MOCK_START_BALANCE', 1000000),

    'game_id' => 'horse-race',
    'currency' => env('HORSE_CURRENCY', 'PHP'),
    'rtp' => (float) env('HORSE_RTP', 0.9),                      // 0.88 .. 0.99 (the controller can change it while running)
    'odds' => null,                                              // null = the default card; or an array '1-2' => 60, ...
    'shuffle_odds' => true,                                      // the 15 odds values are shuffled over the pairs every race

    // timings (ms). The race and results timings must match public/js/core.js
    'bet_ms' => (int) env('HORSE_BET_MS', 25000),
    'countdown_ms' => 6000,
    'race_ms' => 30000,
    'results_ms' => 10000,

    'min_bet' => (int) env('HORSE_MIN_BET', 100),
    'max_bet' => (int) env('HORSE_MAX_BET', 100000),
    'max_round_stake' => (int) env('HORSE_MAX_ROUND_STAKE', 500000),
    'daily_loss_limit' => (int) env('HORSE_DAILY_LOSS_LIMIT', 0),
    'reality_check_minutes' => (int) env('HORSE_REALITY_CHECK_MIN', 0),
    'session_ttl_ms' => 12 * 3600 * 1000,
    'currency_limits' => [],

    // the operator's controller key (X-Controller-Key header) for /api/command and /api/report
    'controller_key' => env('HORSE_CONTROLLER_KEY'),

    // the daemon (php artisan game:run)
    'tick_ms' => 250,
    'lock_ttl_seconds' => 10,
];
