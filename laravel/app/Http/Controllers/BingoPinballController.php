<?php

namespace App\Http\Controllers;

use App\Game\Clients\ClientRegistry;
use App\Game\GameError;
use App\Games\BingoPinball\BingoPinballService;
use App\Platform\Games\Games;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

/**
 * Bingo Pinball's HTTP API, under /api/games/bingo-pinball. Same conventions as the horse race: JSON, {"ok": true, ...} or {"ok": false, "error": CODE}, the session
 * id as a bearer token. The game is reachable only for clients whose games list has it (and that have a paytable).
 */
class BingoPinballController extends Controller
{
    public function __construct(private BingoPinballService $game) {}

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

    /** GET /api/client/games: the games a platform's client may offer, with where to send a player (the platform adds the launch token) */
    public function clientGames(Request $r, ClientRegistry $clients, Games $games): JsonResponse
    {
        $ip = config('horse.trust_proxy') ? trim(explode(',', (string) $r->header('X-Forwarded-For'))[0]) ?: (string) $r->ip() : (string) $r->ip();
        $client = $clients->authenticate($r->bearerToken(), $ip);
        if (! $client) {
            throw new GameError(401, 'INVALID_API_KEY');
        }
        $base = $r->getSchemeAndHttpHost();
        $list = [];
        foreach ($games->enabledFor($client) as $id) {
            $m = $games->get($id);
            $list[] = ['id' => $id, 'name' => $m->name(), 'kind' => $m->kind(), 'launchUrl' => $base.$m->launchPath().'?client='.rawurlencode($client['id'])];
        }

        return $this->ok(['games' => $list]);
    }
}
