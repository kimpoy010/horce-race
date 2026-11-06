<?php

namespace App\Http\Controllers;

use App\Games\BingoPinball16\Bingo16Service;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

/**
 * Bingo Pinball 16 HTTP API, under /api/games/bingo-pinball-16. Same conventions as the horse race: JSON, {"ok": true, ...} or {"ok": false, "error": CODE}, the session
 * id as a bearer token. The game is reachable only for clients whose games list has it (and that have a paytable).
 */
class Bingo16Controller extends Controller
{
    public function __construct(private Bingo16Service $game) {}

    private function ok(array $data = []): JsonResponse
    {
        return response()->json(['ok' => true] + $data)->header('Cache-Control', 'no-store');
    }

    private static function session(Request $r): string
    {
        return (string) $r->bearerToken();
    }

    public function auth(Request $r): JsonResponse
    {
        return $this->ok($this->game->auth((string) $r->input('token', ''), $r->filled('client') ? (string) $r->input('client') : null));
    }

    public function state(Request $r): JsonResponse
    {
        return $this->ok($this->game->state(self::session($r)));
    }

    public function play(Request $r): JsonResponse
    {
        return $this->ok($this->game->play(self::session($r), $r->input('stake'), $r->input('requestId')));
    }

    public function round(Request $r, int $id): JsonResponse
    {
        return $this->ok($this->game->round(self::session($r), $id));
    }

    public function history(Request $r): JsonResponse
    {
        return $this->ok($this->game->history(self::session($r), $r->query('limit')));
    }

    public function seen(Request $r, int $id): JsonResponse
    {
        return $this->ok($this->game->markSeen(self::session($r), $id));
    }

    public function rotate(Request $r): JsonResponse
    {
        return $this->ok($this->game->rotateSeed(self::session($r), $r->input('clientSeed')));
    }

    public function proof(Request $r, int $id): JsonResponse
    {
        return $this->ok($this->game->proof(self::session($r), $id));
    }
}
