<?php

namespace App\Http\Controllers;

use App\Game\Clients\ClientRegistry;
use App\Game\Engine;
use App\Game\GameError;
use App\Game\Staff\UserStore;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

/** The operator's client registry calls (header X-Controller-Key): list, create, change, rotate keys, disable, delete. Every change is written to the ledger. */
class ClientAdminController extends Controller
{
    public function __construct(private Engine $engine, private ClientRegistry $clients, private UserStore $users) {}

    private function operator(Request $r): void
    {
        $key = (string) config('horse.controller_key');
        $given = (string) ($r->header('X-Controller-Key') ?: $r->bearerToken());
        if ($key === '' || ! hash_equals($key, $given)) {
            throw new GameError(401, 'UNAUTHORIZED');
        }
    }

    private function audit(string $action, string $id): void
    {
        $this->engine->log(['e' => 'client_admin', 'action' => $action, 'clientId' => $id, 'who' => 'controller']);
    }

    public function index(Request $r): JsonResponse
    {
        $this->operator($r);
        $list = array_map(fn ($c) => $c + ['stats' => $this->engine->clientReport($c['id']), 'users' => 0], $this->clients->list());

        return response()->json(['ok' => true, 'clients' => $list, 'defaultClient' => config('horse.wallet') !== 'none']);
    }

    public function store(Request $r): JsonResponse
    {
        $this->operator($r);
        $body = $r->json()->all();
        $out = $this->clients->create($body['client'] ?? $body);
        $this->audit('created', $out['client']['id']);

        return response()->json(['ok' => true] + $out);
    }

    public function show(Request $r, string $id): JsonResponse
    {
        $this->operator($r);
        $c = $this->clients->get($id);
        if (! $c) {
            throw new GameError(404, 'NOT_FOUND');
        }

        return response()->json(['ok' => true, 'client' => $this->clients->publicView($c), 'report' => $this->engine->clientReport($id)]);
    }

    public function update(Request $r, string $id): JsonResponse
    {
        $this->operator($r);
        $body = $r->json()->all();
        $c = $this->clients->update($id, $body['client'] ?? $body);
        $this->audit('updated', $id);

        return response()->json(['ok' => true, 'client' => $c]);
    }

    public function rotateKey(Request $r, string $id): JsonResponse
    {
        $this->operator($r);
        $grace = $r->input('graceHours');
        $out = $this->clients->rotateKey($id, $grace === null ? null : (int) round((float) $grace * 3600000));
        $this->audit('key_rotated', $id);

        return response()->json(['ok' => true] + $out);
    }

    public function revokeKey(Request $r, string $id): JsonResponse
    {
        $this->operator($r);
        $c = $this->clients->revokeKey($id, (string) $r->input('keyId', ''));
        $this->audit('key_revoked', $id);

        return response()->json(['ok' => true, 'client' => $c]);
    }

    public function status(Request $r, string $id): JsonResponse
    {
        $this->operator($r);
        $c = $this->clients->setStatus($id, $r->input('status') === 'disabled' ? 'disabled' : 'active');
        $this->audit($c['status'] === 'disabled' ? 'disabled' : 'enabled', $id);

        return response()->json(['ok' => true, 'client' => $c]);
    }

    public function destroy(Request $r, string $id): JsonResponse
    {
        $this->operator($r);
        if ($r->input('confirm') !== $id) {
            throw new GameError(400, 'CONFIRM_REQUIRED', 'send {"confirm":"<client id>"} to delete');
        }
        $this->clients->remove($id);
        $this->audit('deleted', $id);

        return response()->json(['ok' => true]);
    }

    public function history(Request $r): JsonResponse
    {
        $this->operator($r);

        return response()->json($this->engine->historyFor($this->engine->playerKey($r->query('client'), $r->query('playerId')), $r->query('limit')));
    }

    /* ---------- the back-office logins of a client, managed by the operator (the first administrator is created here) ---------- */

    private function knownClient(string $id): void
    {
        if (! $this->clients->get($id) && ! ($id === 'default' && config('horse.wallet') !== 'none')) {
            throw new GameError(404, 'NOT_FOUND');
        }
    }

    public function users(Request $r, string $id): JsonResponse
    {
        $this->operator($r);
        $this->knownClient($id);
        if ($r->isMethod('GET')) {
            return response()->json(['ok' => true, 'users' => $this->users->list($id)]);
        }
        $b = $r->json()->all();
        $out = $this->users->create($id, ['username' => $b['username'] ?? null, 'role' => $b['role'] ?? null, 'password' => $b['password'] ?? null], 'operator');
        $this->audit('user_created:'.$out['user']['username'], $id);

        return response()->json(['ok' => true] + $out);
    }

    public function userAction(Request $r, string $id, string $name, string $what): JsonResponse
    {
        $this->operator($r);
        $this->knownClient($id);
        $b = $r->json()->all();
        $out = [];
        if ($what === 'reset-password') {
            $out = $this->users->resetPassword($id, $name);
        } elseif ($what === 'status') {
            $out = ['user' => $this->users->setStatus($id, $name, (string) ($b['status'] ?? ''))];
        } else {
            $this->users->remove($id, $name);
        }
        app('horse.backoffice')->endSessions($id, $name);
        $this->audit('user_'.str_replace('-', '_', $what).':'.$name, $id);

        return response()->json(['ok' => true] + $out);
    }
}
