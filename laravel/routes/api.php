<?php

use App\Http\Controllers\Bingo16Controller;
use App\Http\Controllers\FruitController;
use App\Http\Controllers\BingoPinballController;
use App\Http\Controllers\ClientAdminController;
use App\Http\Controllers\ClientApiController;
use App\Http\Controllers\GameController;
use Illuminate\Support\Facades\Route;

// the browser game and the operator's controller (same paths as the Node server); the prefix /api comes from bootstrap/app.php
Route::get('/public', [GameController::class, 'publicState']);
Route::post('/auth', [GameController::class, 'auth']);
Route::get('/me', [GameController::class, 'me']);
Route::post('/bet', [GameController::class, 'bet']);
Route::get('/history', [GameController::class, 'history']);
Route::get('/round/{raceNo}', [GameController::class, 'round'])->whereNumber('raceNo');
Route::post('/command', [GameController::class, 'command']);
Route::get('/report', [GameController::class, 'report']);
Route::get('/admin', [GameController::class, 'report']);

// Bingo Pinball (an instant game; reachable only for clients that have it in their games list)
Route::prefix('games/bingo-pinball')->group(function () {
    Route::post('/auth', [BingoPinballController::class, 'auth']);
    Route::get('/state', [BingoPinballController::class, 'state']);
    Route::post('/play', [BingoPinballController::class, 'play']);
    Route::get('/round/{id}', [BingoPinballController::class, 'round'])->whereNumber('id');
    Route::post('/round/{id}/seen', [BingoPinballController::class, 'seen'])->whereNumber('id');
    Route::get('/history', [BingoPinballController::class, 'history']);
    Route::post('/seed/rotate', [BingoPinballController::class, 'rotate']);
    Route::get('/proof/{id}', [BingoPinballController::class, 'proof'])->whereNumber('id');
});

// Bingo Pinball 16 (16 balls, 16 slots, progressive jackpot; an instant game with its own games-list entry)
Route::prefix('games/bingo-pinball-16')->group(function () {
    Route::post('/auth', [Bingo16Controller::class, 'auth']);
    Route::get('/state', [Bingo16Controller::class, 'state']);
    Route::post('/play', [Bingo16Controller::class, 'play']);
    Route::get('/round/{id}', [Bingo16Controller::class, 'round'])->whereNumber('id');
    Route::post('/round/{id}/seen', [Bingo16Controller::class, 'seen'])->whereNumber('id');
    Route::get('/history', [Bingo16Controller::class, 'history']);
    Route::post('/seed/rotate', [Bingo16Controller::class, 'rotate']);
    Route::get('/proof/{id}', [Bingo16Controller::class, 'proof'])->whereNumber('id');
});

// Fruit Game (a ring of 24 cells, 8 symbols, free spins, a Small/Big double-up; an instant game with its own games-list entry)
Route::prefix('games/fruit-ring')->group(function () {
    Route::post('/auth', [FruitController::class, 'auth']);
    Route::get('/state', [FruitController::class, 'state']);
    Route::post('/play', [FruitController::class, 'play']);
    Route::post('/round/{id}/double', [FruitController::class, 'double'])->whereNumber('id');
    Route::post('/round/{id}/collect', [FruitController::class, 'collect'])->whereNumber('id');
    Route::get('/round/{id}', [FruitController::class, 'round'])->whereNumber('id');
    Route::post('/round/{id}/seen', [FruitController::class, 'seen'])->whereNumber('id');
    Route::get('/history', [FruitController::class, 'history']);
    Route::post('/seed/rotate', [FruitController::class, 'rotate']);
    Route::get('/proof/{id}', [FruitController::class, 'proof'])->whereNumber('id');
});

// the client API: a platform with its own API key, limited to its own players (docs/CLIENT_API.md)
Route::prefix('client')->group(function () {
    Route::get('/info', [ClientApiController::class, 'info']);
    Route::get('/games', [BingoPinballController::class, 'clientGames']);
    Route::get('/report', [ClientApiController::class, 'report']);
    Route::get('/history', [ClientApiController::class, 'history']);
    Route::post('/players/block', [ClientApiController::class, 'block']);
    Route::post('/players/unblock', [ClientApiController::class, 'unblock']);
    Route::post('/players/close-sessions', [ClientApiController::class, 'closeSessions']);
});

// the operator's client registry (X-Controller-Key)
Route::get('/admin/history', [ClientAdminController::class, 'history']);
Route::get('/clients', [ClientAdminController::class, 'index']);
Route::post('/clients', [ClientAdminController::class, 'store']);
Route::get('/clients/{id}', [ClientAdminController::class, 'show'])->where('id', '[a-z0-9-]{2,32}');
Route::post('/clients/{id}', [ClientAdminController::class, 'update'])->where('id', '[a-z0-9-]{2,32}');
Route::post('/clients/{id}/rotate-key', [ClientAdminController::class, 'rotateKey'])->where('id', '[a-z0-9-]{2,32}');
Route::post('/clients/{id}/revoke-key', [ClientAdminController::class, 'revokeKey'])->where('id', '[a-z0-9-]{2,32}');
Route::post('/clients/{id}/status', [ClientAdminController::class, 'status'])->where('id', '[a-z0-9-]{2,32}');
Route::post('/clients/{id}/delete', [ClientAdminController::class, 'destroy'])->where('id', '[a-z0-9-]{2,32}');
Route::match(['get', 'post'], '/clients/{id}/users', [ClientAdminController::class, 'users'])->where('id', '[a-z0-9-]{2,32}');
Route::post('/clients/{id}/users/{name}/{what}', [ClientAdminController::class, 'userAction'])->where(['id' => '[a-z0-9-]{2,32}', 'name' => '[a-z0-9._@-]{3,64}', 'what' => 'reset-password|status|delete']);
