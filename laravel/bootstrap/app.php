<?php

use Illuminate\Foundation\Application;
use Illuminate\Foundation\Configuration\Exceptions;
use Illuminate\Foundation\Configuration\Middleware;
use App\Game\GameError;
use Illuminate\Http\Request;

return Application::configure(basePath: dirname(__DIR__))
    ->withRouting(
        web: __DIR__.'/../routes/web.php',
        api: __DIR__.'/../routes/api.php',
        commands: __DIR__.'/../routes/console.php',
        health: '/up',
    )
    ->withMiddleware(function (Middleware $middleware): void {
        //
    })
    ->withExceptions(function (Exceptions $exceptions): void {
        $exceptions->shouldRenderJsonWhen(
            fn (Request $request) => $request->is('api/*') || $request->expectsJson(),
        );
        // errors in the shape the browser game and the platforms already know: {"ok": false, "error": "CODE"}
        $exceptions->render(fn (GameError $e) => response()->json(['ok' => false, 'error' => $e->errorCode], $e->status));
        $exceptions->render(function (\Throwable $e, Request $request) {
            if ($request->is('api/*') && $e instanceof \Symfony\Component\HttpKernel\Exception\NotFoundHttpException) {
                return response()->json(['ok' => false, 'error' => 'not found'], 404);
            }
        });
    })->create();
