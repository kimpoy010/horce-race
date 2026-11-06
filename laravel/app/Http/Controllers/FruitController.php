<?php

namespace App\Http\Controllers;

use App\Games\FruitRing\FruitService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

/** Fruit Game HTTP API, under /api/games/fruit-ring. Same conventions as the other games: JSON, {"ok": true, ...} or {"ok": false, "error": CODE}, the session id as a bearer token. */
class FruitController extends Controller
{
    public function __construct(private FruitService $game) {}

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
        return $this->ok($this->game->play(self::session($r), $r->input('bets'), $r->input('credit'), $r->input('requestId')));
    }

    public function double(Request $r, int $id): JsonResponse
    {
        return $this->ok($this->game->double(self::session($r), $id, $r->input('side'), $r->input('step'), $r->input('take', 0)));
    }

    public function collect(Request $r, int $id): JsonResponse
    {
        return $this->ok($this->game->collect(self::session($r), $id));
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
