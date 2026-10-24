<?php

use App\Http\Controllers\GameController;
use Illuminate\Support\Facades\Route;

// the pages are the very same static files as the Node server's (copied by bin/sync-frontend.sh)
Route::get('/', fn () => response()->file(public_path('index.html')));
Route::get('/play', fn () => response()->file(public_path('index.html')));
Route::get('/controller', fn () => response()->file(public_path('controller.html')));
Route::get('/healthz', [GameController::class, 'healthz']);
