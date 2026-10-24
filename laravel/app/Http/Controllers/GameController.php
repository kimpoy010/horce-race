<?php

namespace App\Http\Controllers;

use App\Game\Engine;
use App\Game\GameError;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

/** The game's HTTP API: same paths, bodies and error codes as the Node server (server.js), so public/js/* works unchanged. */
class GameController extends Controller
{
    public function __construct(private Engine $engine) {}

    private function ok(array $data = []): JsonResponse
    {
        return response()->json(['ok' => true] + $data);
    }

    public function publicState(): JsonResponse
    {
        return response()->json($this->engine->publicState());
    }

    public function auth(Request $r): JsonResponse
    {
        $out = $this->engine->auth((string) $r->input('token', ''), $r->filled('client') ? (string) $r->input('client') : null);

        return $this->ok(['rules' => $this->engine->rules()] + $out);
    }

    public function me(Request $r): JsonResponse
    {
        return $this->ok($this->engine->me((string) $r->bearerToken()));
    }

    public function bet(Request $r): JsonResponse
    {
        return $this->ok($this->engine->placeBets((string) $r->bearerToken(), $r->input('bets')));
    }

    public function history(Request $r): JsonResponse
    {
        $s = $this->engine->session((string) $r->bearerToken());
        if (! $s) {
            throw new GameError(401, 'SESSION_EXPIRED');
        }

        return response()->json($this->engine->historyFor($s->player_key, $r->query('limit')));
    }

    public function round(int $raceNo): JsonResponse
    {
        return response()->json($this->engine->proof($raceNo));
    }

    public function healthz(): JsonResponse
    {
        $h = $this->engine->health();

        return response()->json(['ok' => $h['ok'], 'mode' => 'live', 'role' => $h['ok'] ? 'active' : 'down', 'reasons' => $h['reasons']], $h['ok'] ? 200 : 503);
    }

    /* ---------- the operator's controller (X-Controller-Key or Bearer) ---------- */

    private function operator(Request $r): void
    {
        $key = (string) config('horse.controller_key');
        $given = (string) ($r->header('X-Controller-Key') ?: $r->bearerToken());
        if ($key === '' || ! hash_equals($key, $given)) {
            throw new GameError(401, 'UNAUTHORIZED');
        }
    }

    public function command(Request $r): JsonResponse
    {
        $this->operator($r);
        $cmd = $r->input('cmd');
        if ($cmd === 'setRtp') {
            return response()->json($this->engine->setRtp($r->input('rtp'), 'controller'));
        }
        if ($cmd === 'previewRtp') {
            return response()->json($this->engine->previewRtp($r->input('rtp')));
        }
        $pk = fn () => $this->engine->playerKey($r->input('clientId'), $r->input('playerId'));      // clientId is optional (default client)
        if ($cmd === 'closeSessions') {
            return response()->json(['ok' => true, 'closed' => $this->engine->closeSessions($pk())]);          // kick a player
        }
        if ($cmd === 'blockPlayer') {
            return response()->json($this->engine->blockPlayer($pk(), 'controller'));
        }
        if ($cmd === 'unblockPlayer') {
            return response()->json($this->engine->unblockPlayer($pk(), 'controller'));
        }
        throw new GameError(403, 'the controller cannot change results in live mode');
    }

    public function report(Request $r): JsonResponse
    {
        $this->operator($r);

        return response()->json(['serverNow' => $this->engine->now()] + $this->engine->report());
    }
}
