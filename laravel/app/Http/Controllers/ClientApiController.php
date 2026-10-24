<?php

namespace App\Http\Controllers;

use App\Game\Clients\ClientRegistry;
use App\Game\Engine;
use App\Game\GameError;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

/**
 * The client API (docs/CLIENT_API.md): a platform with its own API key (Authorization: Bearer hrk_<client>_<secret>), limited to its own players.
 */
class ClientApiController extends Controller
{
    public function __construct(private Engine $engine, private ClientRegistry $clients) {}

    private function client(Request $r): array
    {
        $ip = config('horse.trust_proxy') ? trim(explode(',', (string) $r->header('X-Forwarded-For'))[0]) ?: (string) $r->ip() : (string) $r->ip();
        $c = $this->clients->authenticate($r->bearerToken(), $ip);
        if (! $c) {
            throw new GameError(401, 'INVALID_API_KEY');
        }

        return $c;
    }

    public function info(Request $r): JsonResponse
    {
        return response()->json(['ok' => true, 'client' => $this->clients->publicView($this->client($r))]);
    }

    public function report(Request $r): JsonResponse
    {
        return response()->json($this->engine->clientReport($this->client($r)['id']));
    }

    public function history(Request $r): JsonResponse
    {
        $c = $this->client($r);

        return response()->json($this->engine->historyFor($this->engine->playerKey($c['id'], $r->query('playerId')), $r->query('limit')));
    }

    public function block(Request $r): JsonResponse
    {
        $c = $this->client($r);

        return response()->json($this->engine->blockPlayer($this->engine->playerKey($c['id'], $r->input('playerId')), 'client:'.$c['id']));
    }

    public function unblock(Request $r): JsonResponse
    {
        $c = $this->client($r);

        return response()->json($this->engine->unblockPlayer($this->engine->playerKey($c['id'], $r->input('playerId')), 'client:'.$c['id']));
    }

    public function closeSessions(Request $r): JsonResponse
    {
        $c = $this->client($r);

        return response()->json(['ok' => true, 'closed' => $this->engine->closeSessions($this->engine->playerKey($c['id'], $r->input('playerId')))]);
    }
}
