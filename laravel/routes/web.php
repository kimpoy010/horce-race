<?php

use App\Http\Controllers\GameController;
use Illuminate\Support\Facades\Route;

// the pages are the very same static files as the Node server's (copied by bin/sync-frontend.sh)
Route::get('/', fn () => response()->file(public_path('index.html')));
Route::get('/play', fn () => response()->file(public_path('index.html')));
Route::get('/healthz', [GameController::class, 'healthz']);

// the operator's panels must not be framed and may only load their own files
$panel = fn (string $file) => fn () => response()->file(public_path($file), [
    'X-Frame-Options' => 'DENY', 'Referrer-Policy' => 'no-referrer', 'X-Content-Type-Options' => 'nosniff', 'Cache-Control' => 'no-cache',
    'Content-Security-Policy' => "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; form-action 'self'",
]);
Route::get('/controller', $panel('controller.html'));
Route::get('/backoffice', $panel('backoffice.html'));
Route::get('/admin', $panel('admin.html'));
