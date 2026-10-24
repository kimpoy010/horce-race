<?php

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

// the client API: a platform with its own API key, limited to its own players (docs/CLIENT_API.md)
Route::prefix('client')->group(function () {
    Route::get('/info', [ClientApiController::class, 'info']);
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
