<?php

use Illuminate\Foundation\Application;
use Illuminate\Foundation\Configuration\Exceptions;
use Illuminate\Foundation\Configuration\Middleware;
use App\Game\GameError;
use App\Http\Controllers\BackOfficeController;
use App\Http\Controllers\PlayerController;
use Illuminate\Support\Facades\Route;
use Illuminate\Http\Request;

return Application::configure(basePath: dirname(__DIR__))
    ->withRouting(
        web: __DIR__.'/../routes/web.php',
        api: __DIR__.'/../routes/api.php',
        commands: __DIR__.'/../routes/console.php',
        health: '/up',
        then: function () {          // the staff APIs: cookie sessions with their own CSRF token, so no Laravel web middleware
            Route::prefix('bo/api')->group(fn () => Route::any('{sub}', [BackOfficeController::class, 'bo'])->where('sub', '.*'));
            Route::prefix('player/api')->group(fn () => Route::any('{sub}', [PlayerController::class, 'handle'])->where('sub', '.*'));
            Route::prefix('admin/api')->group(fn () => Route::any('{sub}', [BackOfficeController::class, 'admin'])->where('sub', '.*'));
        },
    )
    ->withMiddleware(function (Middleware $middleware): void {
        //
    })
    ->withExceptions(function (Exceptions $exceptions): void {
        $exceptions->shouldRenderJsonWhen(
            fn (Request $request) => $request->is('api/*') || $request->expectsJson(),
        );
        $exceptions->dontReport(GameError::class);          // a refused bet or a wrong password is an answer, not a server error
        // errors in the shape the browser game and the platforms already know: {"ok": false, "error": "CODE"}
        $exceptions->render(fn (GameError $e) => response()->json(['ok' => false, 'error' => $e->errorCode] + ($e->errorCode === 'BAD_CLIENT' || $e->errorCode === 'CONFIRM_REQUIRED' ? ['message' => $e->getMessage()] : []), $e->status));
        $exceptions->render(function (\Throwable $e, Request $request) {
            if ($request->is('api/*') && $e instanceof \Symfony\Component\HttpKernel\Exception\NotFoundHttpException) {
                return response()->json(['ok' => false, 'error' => 'not found'], 404);
            }
        });
    })->create();
