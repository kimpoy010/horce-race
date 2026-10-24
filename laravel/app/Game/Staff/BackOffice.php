<?php

namespace App\Game\Staff;

use App\Game\Clients\ClientRegistry;
use App\Game\Engine;
use App\Game\GameError;
use Closure;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;
use Symfony\Component\HttpFoundation\Response as SymfonyResponse;

/**
 * Client back office: the API behind /backoffice (port of server/backoffice.js). A person logs in with client id + username + password
 * (+ one-time code when the second factor is on) and gets a cookie session limited to that client's own players. Roles: viewer < support < admin.
 * Every change is written to the ledger and shown in the audit log.
 *
 * Security: argon2id passwords, login throttling per address and per account, HttpOnly + SameSite=Strict cookie (Secure over HTTPS), a CSRF token on every
 * change, an Origin check, idle and absolute session timeouts, role checked on every request (a disabled user or client is out at once), no caching.
 *
 * The same class runs the operator's own admin console (area 'admin', fixed client '_operator' and `$routes`, the extra operator endpoints).
 */
final class BackOffice
{
    public const IDLE_MS = 30 * 60000;

    public const ABSOLUTE_MS = 12 * 3600000;

    private const LOCK_MS = 10 * 60000;

    private string $cookieName;

    private string $cookiePath;

    /** @param Closure|null $routes  function (array $x): ?Response, the operator's extra endpoints */
    public function __construct(
        private UserStore $users,
        private ClientRegistry $clients,
        private Engine $engine,
        private string $area = 'bo',
        private ?string $fixedClient = null,
        private bool $cookieSecure = false,
        private ?Closure $routes = null,
        private ?Closure $clock = null,
    ) {
        $this->cookieName = $fixedClient ? 'admin_session' : 'bo_session';
        $this->cookiePath = $fixedClient ? '/admin' : '/bo';
    }

    public function now(): int
    {
        return $this->clock ? ($this->clock)() : (int) floor(microtime(true) * 1000);
    }

    public function users(): UserStore
    {
        return $this->users;
    }

    private static function sha(string $s): string
    {
        return hash('sha256', $s);
    }

    private static function err(int $status, string $code, string $message = ''): GameError
    {
        return new GameError($status, $code, $message);
    }

    /* ---------- helpers ---------- */

    private function send(int $code, array $obj, array $headers = []): SymfonyResponse
    {
        return response()->json($obj, $code, ['Cache-Control' => 'no-store', 'X-Content-Type-Options' => 'nosniff'] + $headers);
    }

    private function setCookie(string $token, int $maxAge): string
    {
        return $this->cookieName.'='.$token.'; Path='.$this->cookiePath.'; HttpOnly; SameSite=Strict; Max-Age='.$maxAge.($this->cookieSecure ? '; Secure' : '');
    }

    private function cookie(Request $r): ?string
    {
        return preg_match('/(?:^|;\s*)'.$this->cookieName.'=([0-9a-f]{64})(?:;|$)/', (string) $r->header('Cookie'), $m) ? $m[1] : null;
    }

    private function locked(string $key): bool
    {
        $f = Cache::get('horse-bo-fail:'.$key);

        return $f && $f['until'] > $this->now();
    }

    /** counts a failure; true when this one locked the key */
    private function fail(string $key, int $limit): bool
    {
        $t = $this->now();
        $f = Cache::get('horse-bo-fail:'.$key);
        if (! $f || $t - $f['first'] > self::LOCK_MS) {
            $f = ['n' => 0, 'first' => $t, 'until' => 0];
        }
        $f['n']++;
        if ($f['n'] >= $limit) {
            $f['until'] = $t + self::LOCK_MS;
        }
        Cache::put('horse-bo-fail:'.$key, $f, 3600);

        return $f['until'] > $t;
    }

    private function clientExists(string $id): bool
    {
        if ($this->fixedClient) {
            return $id === $this->fixedClient;
        }

        return (bool) $this->clients->get($id) || ($id === 'default' && config('horse.wallet') !== 'none');
    }

    private function clientActive(string $id): bool
    {
        return $this->fixedClient ? $id === $this->fixedClient : $this->engine->clientActive($id);
    }

    /** the session of this request (checked against the user store every time), or throws */
    private function session(Request $r, bool $mutating): array
    {
        $token = $this->cookie($r);
        $s = $token ? DB::table('staff_sessions')->where('token_hash', self::sha($token))->where('area', $this->area)->first() : null;
        $t = $this->now();
        if (! $s) {
            throw self::err(401, 'NOT_LOGGED_IN');
        }
        if ($t - $s->last_seen > self::IDLE_MS || $t - $s->created_at > self::ABSOLUTE_MS) {
            DB::table('staff_sessions')->where('token_hash', $s->token_hash)->delete();
            throw self::err(401, 'SESSION_EXPIRED');
        }
        $u = $this->users->get($s->client, $s->username);
        if (! $u || $u->status !== 'active' || ! $this->clientActive($s->client)) {          // a suspended client ends its staff sessions too
            DB::table('staff_sessions')->where('token_hash', $s->token_hash)->delete();
            throw self::err(401, 'NOT_LOGGED_IN');
        }
        if ($mutating) {
            if (! hash_equals($s->csrf, (string) $r->header('X-CSRF-Token'))) {
                throw self::err(403, 'BAD_CSRF');
            }
            $o = $r->header('Origin');
            if ($o && parse_url($o, PHP_URL_HOST) !== null) {
                $host = parse_url($o, PHP_URL_HOST).(parse_url($o, PHP_URL_PORT) ? ':'.parse_url($o, PHP_URL_PORT) : '');
                if ($host !== $r->getHttpHost()) {
                    throw self::err(403, 'BAD_ORIGIN');
                }
            } elseif ($o) {
                throw self::err(403, 'BAD_ORIGIN');
            }
        }
        DB::table('staff_sessions')->where('token_hash', $s->token_hash)->update(['last_seen' => $t]);

        return ['s' => $s, 'u' => $u, 'token' => $token];
    }

    private function need(array $sess, string $role): void
    {
        if (UserStore::ROLES[$sess['u']->role] < UserStore::ROLES[$role]) {
            throw self::err(403, 'FORBIDDEN', 'Your role ('.$sess['u']->role.') cannot do this.');
        }
    }

    public function endSessions(string $client, ?string $username = null): void
    {
        $q = DB::table('staff_sessions')->where('area', $this->area)->where('client', $client);
        if ($username) {
            $q->where('username', $username);
        }
        $q->delete();
    }

    /* ---------- login ---------- */

    private function login(array $body, string $ip): array
    {
        $client = $this->fixedClient ?: strtolower((string) ($body['client'] ?? ''));
        $username = strtolower((string) ($body['username'] ?? ''));
        $pw = substr((string) ($body['password'] ?? ''), 0, 256);
        $kIp = 'ip:'.$ip;
        $kUser = 'user:'.$client.':'.$username;
        if ($this->locked($kIp) || $this->locked($kUser)) {
            throw self::err(429, 'TOO_MANY_ATTEMPTS', 'Too many failed logins. Try again in a few minutes.');
        }
        $u = $this->users->get($client, $username);
        $ok = $this->clientExists($client) && $u && $u->status === 'active' && $this->clientActive($client);
        $good = $this->users->check($pw, $ok ? $u->pass : $this->dummyHash());       // always one hash check: the answer takes the same time
        $bad = function () use ($kUser, $kIp, $client, $username, $ip) {
            $lockedNow = $this->fail($kUser, 5) | $this->fail($kIp, 20);
            if ($lockedNow && $this->clientExists($client)) {
                $this->engine->audit($client, ['user' => $username, 'action' => 'login_locked', 'ip' => $ip]);
            }
            throw self::err(401, 'BAD_LOGIN', 'Wrong client, username or password.');
        };
        if (! $ok || ! $good) {
            $bad();
        }
        if (! empty($u->totp['enabled'])) {
            if (empty($body['otp'])) {
                throw self::err(401, 'OTP_REQUIRED', 'Enter the code from your authenticator app.');
            }
            if (! $this->users->totpVerify($client, $username, $body['otp'])) {
                $bad();
            }
        }
        Cache::forget('horse-bo-fail:'.$kUser);
        $token = bin2hex(random_bytes(32));
        $t = $this->now();
        $csrf = bin2hex(random_bytes(16));
        DB::table('staff_sessions')->insert(['token_hash' => self::sha($token), 'area' => $this->area, 'client' => $client, 'username' => $username, 'csrf' => $csrf, 'created_at' => $t, 'last_seen' => $t, 'ip' => $ip]);
        $this->users->recordLogin($client, $username);
        $this->engine->audit($client, ['user' => $username, 'role' => $u->role, 'action' => 'login', 'ip' => $ip]);

        return ['token' => $token, 'csrf' => $csrf, 'user' => $this->users->get($client, $username), 'client' => $client];
    }

    private function dummyHash(): string
    {
        return Cache::rememberForever('horse-bo-dummy-hash', fn () => $this->users->hashPassword('dummy-password-for-timing'));
    }

    private function me(object $u, string $client, string $csrf): array
    {
        return ['user' => $this->users->view($u), 'client' => $client, 'csrf' => $csrf, 'role' => $u->role, 'idleMinutes' => self::IDLE_MS / 60000];
    }

    /* ---------- the routes ---------- */

    public function handle(Request $r, string $sub): SymfonyResponse
    {
        $method = $r->method();
        $ip = (string) $r->ip();
        $isClient = ! $this->fixedClient;
        try {
            $raw = $r->getContent();
            $body = $raw === '' || $raw === null ? [] : json_decode($raw, true);
            if (! is_array($body)) {
                return $this->send(400, ['ok' => false, 'error' => 'BAD_JSON']);
            }
            if ($sub === 'login' && $method === 'POST') {
                $l = $this->login($body, $ip);

                return $this->send(200, ['ok' => true] + $this->me($l['user'], $l['client'], $l['csrf']), ['Set-Cookie' => $this->setCookie($l['token'], (int) (self::ABSOLUTE_MS / 1000))]);
            }
            if ($sub === 'logout' && $method === 'POST') {
                $token = $this->cookie($r);
                if ($token) {
                    $s = DB::table('staff_sessions')->where('token_hash', self::sha($token))->first();
                    if ($s) {
                        $this->engine->audit($s->client, ['user' => $s->username, 'action' => 'logout', 'ip' => $ip]);
                        DB::table('staff_sessions')->where('token_hash', $s->token_hash)->delete();
                    }
                }

                return $this->send(200, ['ok' => true], ['Set-Cookie' => $this->setCookie('', 0)]);
            }
            $mutating = ! in_array($method, ['GET', 'HEAD'], true);
            $sess = $this->session($r, $mutating);
            $c = $sess['s']->client;
            $me = $sess['u'];
            $eng = $this->engine;
            $audit = fn (array $e) => $eng->audit($c, ['user' => $me->username, 'role' => $me->role] + $e + ['ip' => $ip]);

            if ($sub === 'me' && $method === 'GET') {
                return $this->send(200, ['ok' => true] + $this->me($me, $c, $sess['s']->csrf));
            }
            if ($sub === 'password' && $method === 'POST') {
                if (! $this->users->check((string) ($body['current'] ?? ''), $me->pass)) {
                    throw self::err(403, 'BAD_PASSWORD', 'The current password is wrong.');
                }
                $this->users->changePassword($c, $me->username, (string) ($body['next'] ?? ''));
                $eng->audit($c, ['user' => $me->username, 'action' => 'password_changed', 'ip' => $ip]);
                DB::table('staff_sessions')->where('area', $this->area)->where('client', $c)->where('username', $me->username)->where('token_hash', '!=', self::sha($sess['token']))->delete();   // other devices are logged out

                return $this->send(200, ['ok' => true]);
            }
            if ($me->must_change) {
                throw self::err(403, 'MUST_CHANGE_PASSWORD', 'Choose a new password first.');
            }

            /* two-step login */
            if ($sub === 'totp/setup' && $method === 'POST') {
                $secret = $this->users->totpStart($c, $me->username);

                return $this->send(200, ['ok' => true, 'secret' => $secret, 'otpauth' => 'otpauth://totp/'.rawurlencode('Horse Race ('.$c.'):'.$me->username).'?secret='.$secret.'&issuer='.rawurlencode('Horse Race')]);
            }
            if ($sub === 'totp/enable' && $method === 'POST') {
                if (! $this->users->totpEnable($c, $me->username, $body['otp'] ?? '')) {
                    throw self::err(400, 'BAD_OTP', 'That code is not right. Check the clock of your phone and try again.');
                }
                $eng->audit($c, ['user' => $me->username, 'action' => 'totp_enabled', 'ip' => $ip]);

                return $this->send(200, ['ok' => true]);
            }
            if ($sub === 'totp/disable' && $method === 'POST') {
                if (! $this->users->check((string) ($body['password'] ?? ''), $me->pass)) {
                    throw self::err(403, 'BAD_PASSWORD', 'The password is wrong.');
                }
                $this->users->totpDisable($c, $me->username);
                $eng->audit($c, ['user' => $me->username, 'action' => 'totp_disabled', 'ip' => $ip]);

                return $this->send(200, ['ok' => true]);
            }

            if (! $isClient && $this->routes) {              // the operator console: clients, API keys, RTP, health
                $res = ($this->routes)(['request' => $r, 'body' => $body, 'sess' => $sess, 'sub' => $sub, 'method' => $method, 'c' => $c, 'me' => $me, 'ip' => $ip, 'engine' => $eng,
                    'send' => fn (int $code, array $obj) => $this->send($code, $obj), 'audit' => $audit, 'need' => fn (string $role) => $this->need($sess, $role), 'bo' => $this]);
                if ($res) {
                    return $res;
                }
            }

            /* reading (viewer) */
            if ($isClient && $sub === 'client' && $method === 'GET') {
                return $this->send(200, ['ok' => true, 'client' => $this->clientInfo($c)]);
            }
            if ($isClient && $sub === 'report' && $method === 'GET') {
                $rep = $eng->clientReport($c);
                unset($rep['rtpSetting']);

                return $this->send(200, $rep + ['rounds' => $eng->rounds($c, 30)['rounds']]);
            }
            if ($isClient && $sub === 'rounds' && $method === 'GET') {
                return $this->send(200, $eng->rounds($c, $r->query('limit')));
            }
            if ($isClient && $sub === 'players' && $method === 'GET') {
                return $this->send(200, $eng->players($c, ['query' => $r->query('query'), 'limit' => $r->query('limit')]));
            }
            $pm = $isClient && preg_match('#^players/([A-Za-z0-9_.@-]{1,64})(?:/(block|unblock|close-sessions))?$#', $sub, $m) ? $m : null;
            if ($pm && $method === 'GET' && empty($pm[2])) {
                return $this->send(200, $eng->playerDetail($c, $pm[1]));
            }
            if ($pm && $method === 'POST' && ! empty($pm[2])) {
                $this->need($sess, 'support');
                $pk = $eng->playerKey($c, $pm[1]);
                $audit(['action' => 'player_'.str_replace('-', '_', $pm[2]), 'target' => $pm[1], 'detail' => substr((string) ($body['reason'] ?? ''), 0, 200)]);
                if ($pm[2] === 'block') {
                    return $this->send(200, $eng->blockPlayer($pk, 'backoffice:'.$c.':'.$me->username));
                }
                if ($pm[2] === 'unblock') {
                    return $this->send(200, $eng->unblockPlayer($pk, 'backoffice:'.$c.':'.$me->username));
                }

                return $this->send(200, ['ok' => true, 'closed' => $eng->closeSessions($pk)]);
            }
            if ($isClient && in_array($sub, ['export/players.csv', 'export/rounds.csv'], true) && $method === 'GET') {
                $audit(['action' => 'export', 'target' => $sub]);
                $csv = $sub === 'export/players.csv'
                    ? self::csv(['player', 'bets', 'staked', 'paid', 'net_for_player', 'last_bet', 'online', 'blocked'], array_map(fn ($p) => [$p['playerId'], $p['bets'], $p['staked'], $p['paid'], $p['paid'] - $p['staked'],
                        $p['lastBetAt'] ? gmdate('c', intdiv($p['lastBetAt'], 1000)) : '', $p['online'] ? 'yes' : 'no', $p['blocked'] ? 'yes' : 'no'], $eng->players($c, ['limit' => 500])['players']))
                    : self::csv(['race', 'time', 'winning_pair', 'odds', 'players', 'bets', 'staked', 'paid', 'ggr'], array_map(fn ($x) => [$x['raceNo'], gmdate('c', intdiv($x['at'], 1000)), $x['combo'], $x['odds'], $x['players'],
                        $x['bets'], $x['staked'], $x['paid'], $x['staked'] - $x['paid']], $eng->rounds($c, 300)['rounds']));

                return response($csv, 200, ['Content-Type' => 'text/csv; charset=utf-8', 'Content-Disposition' => 'attachment; filename="'.substr($sub, 7).'"', 'Cache-Control' => 'no-store', 'X-Content-Type-Options' => 'nosniff']);
            }

            /* admin */
            if ($sub === 'users' && $method === 'GET') {
                $this->need($sess, 'admin');

                return $this->send(200, ['ok' => true, 'users' => $this->users->list($c)]);
            }
            if ($sub === 'users' && $method === 'POST') {
                $this->need($sess, 'admin');
                $res = $this->users->create($c, ['username' => $body['username'] ?? null, 'role' => $body['role'] ?? null], $me->username);       // always a temporary password
                $audit(['action' => 'user_created', 'target' => $res['user']['username'], 'detail' => $res['user']['role']]);

                return $this->send(200, ['ok' => true] + $res);
            }
            if (preg_match('#^users/([a-z0-9._@-]{3,64})/(role|reset-password|status|delete)$#', $sub, $um) && $method === 'POST') {
                $this->need($sess, 'admin');
                $name = $um[1];
                $target = $this->users->get($c, $name);
                if (! $target) {
                    throw self::err(404, 'NOT_FOUND');
                }
                $guard = function () use ($name, $me, $target, $c) {
                    if ($name === $me->username) {
                        throw self::err(400, 'SELF', 'You cannot do this to your own account.');
                    }
                    if ($target->role === 'admin' && $target->status === 'active' && $this->users->activeAdmins($c) <= 1) {
                        throw self::err(400, 'LAST_ADMIN', 'This is the last administrator.');
                    }
                };
                $out = [];
                if ($um[2] === 'role') {
                    if ($name === $me->username && ($body['role'] ?? '') !== 'admin') {
                        throw self::err(400, 'SELF', 'You cannot lower your own role.');
                    }
                    if ($target->role === 'admin' && ($body['role'] ?? '') !== 'admin') {
                        $guard();
                    }
                    $out = ['user' => $this->users->setRole($c, $name, (string) ($body['role'] ?? ''))];
                    $this->endSessions($c, $name);
                } elseif ($um[2] === 'reset-password') {
                    $out = $this->users->resetPassword($c, $name);
                    $this->endSessions($c, $name);
                } elseif ($um[2] === 'status') {
                    if (($body['status'] ?? '') === 'disabled') {
                        $guard();
                    }
                    $out = ['user' => $this->users->setStatus($c, $name, (string) ($body['status'] ?? ''))];
                    if (($body['status'] ?? '') === 'disabled') {
                        $this->endSessions($c, $name);
                    }
                } else {
                    $guard();
                    $this->users->remove($c, $name);
                    $this->endSessions($c, $name);
                }
                $audit(['action' => 'user_'.str_replace('-', '_', $um[2]), 'target' => $name, 'detail' => $um[2] === 'role' ? ($body['role'] ?? '') : ($um[2] === 'status' ? ($body['status'] ?? '') : '')]);

                return $this->send(200, ['ok' => true] + $out);
            }
            if ($isClient && $sub === 'apikey/rotate' && $method === 'POST') {
                $this->need($sess, 'admin');
                if (! $this->clients->get($c)) {
                    throw self::err(400, 'NO_API_KEY', 'This client has no API key to rotate.');
                }
                $grace = array_key_exists('graceHours', $body) ? (int) round(max(0, min(168, (float) $body['graceHours'])) * 3600000) : null;
                $res = $this->clients->rotateKey($c, $grace);
                $audit(['action' => 'api_key_rotated', 'detail' => 'grace '.($grace === null ? 24 : $grace / 3600000).' h']);

                return $this->send(200, ['ok' => true, 'apiKey' => $res['apiKey'], 'client' => $this->clientInfo($c)]);
            }
            if ($sub === 'audit' && $method === 'GET') {
                $this->need($sess, 'admin');

                return $this->send(200, $eng->auditFor($c, $r->query('limit')));
            }
            throw self::err(404, 'NOT_FOUND');
        } catch (GameError $e) {
            $expose = $e->getMessage() !== $e->errorCode;
            if (! $expose && $e->status >= 500) {
                report($e);
            }

            return $this->send($e->status, ['ok' => false, 'error' => $e->errorCode] + ($expose ? ['message' => $e->getMessage()] : []));
        }
    }

    /** what the client's own staff may see of its settings: no secrets */
    private function clientInfo(string $id): array
    {
        $c = $this->clients->get($id);
        if (! $c) {
            return ['id' => $id, 'name' => 'Default client', 'status' => 'active', 'implicit' => true];
        }
        $v = $this->clients->publicView($c);

        return ['id' => $v['id'], 'name' => $v['name'], 'status' => $v['status'], 'currency' => $v['currency'] ?? null, 'limits' => $v['limits'], 'currencyLimits' => $v['currencyLimits'],
            'realityCheckMinutes' => $v['realityCheckMinutes'] ?? null, 'bigWinMin' => $v['bigWinMin'] ?? null, 'allowedIps' => $v['allowedIps'], 'returnUrlHosts' => $v['returnUrlHosts'],
            'wallet' => ['url' => $v['wallet']['url'] ?? null, 'type' => $v['wallet']['type'], 'keyId' => ($v['wallet']['keyId'] ?? '') ?: null],
            'webhook' => isset($v['webhook']) ? ['url' => $v['webhook']['url'], 'events' => $v['webhook']['events']] : null, 'apiKeys' => $v['apiKeys']];
    }

    /** text that starts like a formula is neutralised (CSV injection) */
    public static function csv(array $head, array $rows): string
    {
        $cell = function ($v) {
            $s = $v === null ? '' : (string) $v;
            if (preg_match('/^[=+\-@\t\r]/', $s) && ! preg_match('/^-?\d+(\.\d+)?$/', $s)) {
                $s = "'".$s;
            }

            return preg_match('/[",\n\r]/', $s) ? '"'.str_replace('"', '""', $s).'"' : $s;
        };

        return implode("\r\n", array_map(fn ($r) => implode(',', array_map($cell, $r)), array_merge([$head], $rows)))."\r\n";
    }
}
