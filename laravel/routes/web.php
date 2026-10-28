<?php

use App\Http\Controllers\GameController;
use App\Http\Controllers\PanelController;
use Illuminate\Support\Facades\Route;

// the pages are the very same static files as the Node server's (copied by bin/sync-frontend.sh)
Route::get('/', [PanelController::class, 'game']);
Route::get('/play', [PanelController::class, 'game']);
Route::get('/healthz', [GameController::class, 'healthz']);
Route::get('/metrics', [GameController::class, 'metrics']);

// the operator's panels and the players' account page: must not be framed and may only load their own files
foreach (['/controller' => 'controller.html', '/backoffice' => 'backoffice.html', '/admin' => 'admin.html', '/account' => 'account.html', '/register' => 'account.html', '/login' => 'account.html'] as $path => $file) {
    Route::get($path, [PanelController::class, 'show'])->defaults('file', $file);
}
