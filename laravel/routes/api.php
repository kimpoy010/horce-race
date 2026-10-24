<?php

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
