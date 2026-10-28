<?php

namespace App\Game\Staff;

use App\Game\Clients\ClientRegistry;
use App\Game\Engine;
use App\Game\GameError;
use Closure;
use Symfony\Component\HttpFoundation\Response;

/**
 * Operator admin console (/admin): the endpoints behind it (port of server/admin.js). The operator's staff sign in with their own accounts
 * (roles: viewer = read only, support = also suspend / re-enable a client and handle its back-office users, admin = everything including clients,
 * keys, RTP and staff). Login, sessions, passwords, two-step sign-in, staff management and the audit log are the same engine as the clients' back
 * office (BackOffice); this adds what only the operator can do.
 */
final class AdminRoutes
{
    private const SECRETS_ONCE = 'Shown once. Pass it on over a safe channel; it cannot be displayed again.';

    private static function pick(array $o, array $keys): array
    {
        $r = [];
        foreach ($keys as $k) {
            if (array_key_exists($k, $o)) {
                $r[$k] = $o[$k];
            }
        }

        return $r;
    }

    private static function walletHost(array $c): string
    {
        return $c['wallet']['type'] === 'internal' ? 'built-in wallet' : ($c['wallet']['type'] === 'mock' ? 'mock wallet' : (parse_url($c['wallet']['url'] ?? '', PHP_URL_HOST) ?: '-'));
    }

    private static function lastApi(array $c): ?int
    {
        $m = 0;
        foreach ($c['apiKeys'] as $k) {
            $m = max($m, (int) ($k['lastUsedAt'] ?? 0));
        }

        return $m ?: null;
    }

    /** @param Closure(): BackOffice $clientBackOffice the clients' back office (to end the sessions of a client user) */
    public static function make(ClientRegistry $clients, UserStore $clientUsers, Closure $clientBackOffice, ?\App\Game\House\House $house = null): Closure
    {
        return function (array $x) use ($clients, $clientUsers, $clientBackOffice, $house): ?Response {
            /** @var Engine $engine */
            $engine = $x['engine'];
            $sub = $x['sub'];
            $method = $x['method'];
            $send = $x['send'];
            $audit = $x['audit'];
            $need = $x['need'];
            $me = $x['me'];
            $body = $x['body'];
            $req = $x['request'];

            /* ---- the operator's own site: players and the cashier ---- */
            if ($house && ($r = \App\Game\House\HouseAdmin::route($x, $house))) {
                return $r;
            }

            /* ---- overview: health, game numbers, RTP, clients ---- */
            if ($sub === 'overview' && $method === 'GET') {
                $rep = $engine->report();
                $o = $engine->ops();
                $default = config('horse.wallet') !== 'none';

                return $send(200, [
                    'ok' => true, 'role' => $o['role'], 'health' => $o['health'], 'alerts' => $o['alerts'], 'recentAlerts' => $o['recentAlerts'], 'uptime' => $o['uptime'], 'lease' => $o['lease'],
                    'diskFreeMb' => $o['diskFreeMb'], 'tickAge' => $o['tickAge'], 'wallet' => $o['wallet'],
                    'game' => ['rounds' => $rep['rounds'], 'bets' => $rep['bets'], 'staked' => $rep['staked'], 'paid' => $rep['paid'], 'ggr' => $rep['staked'] - $rep['paid'], 'rtpActual' => $rep['actualRtp'],
                        'rtpSetting' => $rep['rtpSetting'], 'rtpOfCurrentRace' => $rep['rtpOfCurrentRace'], 'currentRound' => $rep['currentRound'], 'sessions' => $rep['activeSessions'], 'byCurrency' => $rep['byCurrency'],
                        'pending' => $o['snapshot']['pending'], 'rtpZ' => $o['snapshot']['rtpZ'], 'ledger' => $o['snapshot']['ledger'], 'commit' => $rep['commit']],
                    'rtp' => $engine->previewRtp($engine->rtp()),
                    'defaultClient' => $default, 'defaultStats' => $default ? $engine->clientReport('default') : null,
                    'clients' => array_map(fn ($c) => ['id' => $c['id'], 'name' => $c['name'], 'status' => $c['status'], 'currency' => $c['currency'] ?? null, 'wallet' => self::walletHost($c), 'webhook' => ! empty($c['webhook']),
                        'users' => $clientUsers->count($c['id']), 'lastApiUse' => self::lastApi($c), 'stats' => $engine->clientReport($c['id']), 'walletHealth' => $engine->walletWindow(300000, $c['id'])], $clients->list()),
                ]);
            }
            if ($sub === 'rtp/preview' && $method === 'GET') {
                try {
                    return $send(200, $engine->previewRtp($req->query('value')));
                } catch (GameError $e) {
                    return $send(400, ['ok' => false, 'error' => $e->errorCode]);
                }
            }
            if ($sub === 'rtp' && $method === 'POST') {
                $need('admin');
                try {
                    $r = $engine->setRtp($body['rtp'] ?? null, 'admin:'.$me->username);
                } catch (GameError $e) {
                    return $send(400, ['ok' => false, 'error' => $e->errorCode, 'message' => 'The RTP must be between 88% and 99%.']);
                }
                $audit(['action' => 'rtp_set', 'detail' => (string) $r['rtp']]);

                return $send(200, $r);
            }

            /* ---- clients ---- */
            if ($sub === 'clients' && $method === 'POST') {
                $need('admin');
                $r = $clients->create($body['client'] ?? $body);
                $audit(['action' => 'client_created', 'target' => $r['client']['id']]);

                return $send(200, ['ok' => true, 'note' => self::SECRETS_ONCE] + $r);
            }
            if (preg_match('#^clients/([a-z0-9-]{2,32})(?:/(status|rotate-key|revoke-key|rotate-wallet-secret|rotate-webhook-secret|delete|users)(?:/([a-z0-9._@-]{3,64})/(reset-password|status|delete))?)?$#', $sub, $cm)) {
                $id = $cm[1];
                $c = $clients->get($id);
                if (! $c) {
                    throw new GameError(404, 'NOT_FOUND', 'Unknown client.');
                }
                $act = $cm[2] ?? null;
                if (! $act && $method === 'GET') {
                    return $send(200, ['ok' => true, 'client' => $clients->publicView($c), 'report' => $engine->clientReport($id), 'users' => $clientUsers->list($id), 'walletHealth' => $engine->walletWindow(300000, $id),
                        'rounds' => $engine->rounds($id, 10)['rounds'], 'audit' => $engine->auditFor($id, 30)['entries'], 'lastApiUse' => self::lastApi($c)]);
                }
                if (! $act && $method === 'POST') {
                    $need('admin');
                    $patch = self::pick($body['client'] ?? $body, ['name', 'currency', 'limits', 'currencyLimits', 'realityCheckMinutes', 'bigWinMin', 'allowedIps', 'returnUrlHosts', 'wallet', 'webhook']);
                    if (isset($patch['wallet']) && empty($patch['wallet']['secret'])) {
                        unset($patch['wallet']['secret']);                                      // an empty secret field means "keep it"
                    }
                    if (! empty($patch['webhook']['url']) && empty($patch['webhook']['secret'])) {
                        $patch['webhook'] = $patch['webhook'] + ($c['webhook'] ?? []);
                    }
                    $r = $clients->update($id, $patch);
                    $audit(['action' => 'client_updated', 'target' => $id, 'detail' => implode(', ', array_keys($patch)).(! empty($patch['wallet']['secret']) ? ' (wallet secret)' : '')]);

                    return $send(200, ['ok' => true, 'client' => $r]);
                }
                if ($act === 'status' && $method === 'POST') {
                    $need('support');
                    $r = $clients->setStatus($id, ($body['status'] ?? '') === 'disabled' ? 'disabled' : 'active');
                    $audit(['action' => $r['status'] === 'disabled' ? 'client_suspended' : 'client_enabled', 'target' => $id]);

                    return $send(200, ['ok' => true, 'client' => $r]);
                }
                if ($act === 'rotate-key' && $method === 'POST') {
                    $need('admin');
                    $grace = array_key_exists('graceHours', $body) ? (int) round(max(0, min(168, (float) $body['graceHours'])) * 3600000) : null;
                    $r = $clients->rotateKey($id, $grace);
                    $audit(['action' => 'api_key_rotated', 'target' => $id, 'detail' => 'grace '.($grace === null ? 24 : $grace / 3600000).' h']);

                    return $send(200, ['ok' => true, 'note' => self::SECRETS_ONCE] + $r);
                }
                if ($act === 'revoke-key' && $method === 'POST') {
                    $need('admin');
                    $r = $clients->revokeKey($id, (string) ($body['keyId'] ?? ''));
                    $audit(['action' => 'api_key_revoked', 'target' => $id, 'detail' => (string) ($body['keyId'] ?? '')]);

                    return $send(200, ['ok' => true, 'client' => $r]);
                }
                if ($act === 'rotate-wallet-secret' && $method === 'POST') {
                    $need('admin');
                    $r = $clients->rotateWalletSecret($id);
                    $audit(['action' => 'wallet_secret_rotated', 'target' => $id]);

                    return $send(200, ['ok' => true, 'note' => self::SECRETS_ONCE] + $r);
                }
                if ($act === 'rotate-webhook-secret' && $method === 'POST') {
                    $need('admin');
                    $r = $clients->rotateWebhookSecret($id);
                    $audit(['action' => 'webhook_secret_rotated', 'target' => $id]);

                    return $send(200, ['ok' => true, 'note' => self::SECRETS_ONCE] + $r);
                }
                if ($act === 'delete' && $method === 'POST') {
                    $need('admin');
                    if (($body['confirm'] ?? null) !== $id) {
                        throw new GameError(400, 'CONFIRM', 'Type the client id to confirm.');
                    }
                    $clients->remove($id);
                    $audit(['action' => 'client_deleted', 'target' => $id]);

                    return $send(200, ['ok' => true]);
                }
                /* back-office users of this client */
                if ($act === 'users') {
                    $name = $cm[3] ?? null;
                    $what = $cm[4] ?? null;
                    if (! $name && $method === 'GET') {
                        return $send(200, ['ok' => true, 'users' => $clientUsers->list($id)]);
                    }
                    if (! $name && $method === 'POST') {
                        $need('admin');
                        $r = $clientUsers->create($id, ['username' => $body['username'] ?? null, 'role' => $body['role'] ?? null], 'operator:'.$me->username);
                        $audit(['action' => 'client_user_created', 'target' => $id.'/'.$r['user']['username'], 'detail' => $r['user']['role']]);

                        return $send(200, ['ok' => true, 'note' => self::SECRETS_ONCE] + $r);
                    }
                    if ($name && $method === 'POST') {
                        $out = [];
                        if ($what === 'reset-password') {
                            $need('support');
                            $out = $clientUsers->resetPassword($id, $name) + ['note' => self::SECRETS_ONCE];
                        } elseif ($what === 'status') {
                            $need('support');
                            $out = ['user' => $clientUsers->setStatus($id, $name, (string) ($body['status'] ?? ''))];
                        } else {
                            $need('admin');
                            $clientUsers->remove($id, $name);
                        }
                        $clientBackOffice()->endSessions($id, $name);
                        $audit(['action' => 'client_user_'.str_replace('-', '_', $what), 'target' => $id.'/'.$name, 'detail' => $what === 'status' ? ($body['status'] ?? '') : '']);

                        return $send(200, ['ok' => true] + $out);
                    }
                }
            }

            return null;
        };
    }
}
