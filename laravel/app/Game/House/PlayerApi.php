<?php

namespace App\Game\House;

use App\Game\Engine;
use App\Game\GameError;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;
use Symfony\Component\HttpFoundation\Response;

/**
 * /player/api/*: registration, sign-in and the wallet of the operator's own players (the same-origin JSON API behind /account).
 * Cookie session (HttpOnly, SameSite=Lax, Secure over https) with a CSRF token on every change and an Origin check; argon2id passwords; throttled
 * sign-in per address and per account; registrations limited per address; nothing is cached.
 */
final class PlayerApi
{
    public const IDLE_MS = 7 * 86400000;

    public const ABSOLUTE_MS = 30 * 86400000;

    private const LOCK_MS = 10 * 60000;

    private const COOKIE = 'player_session';

    private ?string $dummy = null;

    public function __construct(private House $house, private Engine $engine, private bool $cookieSecure = false) {}

    private static function sha(string $s): string
    {
        return hash('sha256', $s);
    }

    private function send(int $code, array $obj, array $headers = []): Response
    {
        return response()->json($obj, $code, ['Cache-Control' => 'no-store', 'X-Content-Type-Options' => 'nosniff'] + $headers);
    }

    private function setCookie(string $token, int $maxAge): string
    {
        return self::COOKIE.'='.$token.'; Path=/; HttpOnly; SameSite=Lax; Max-Age='.$maxAge.($this->cookieSecure ? '; Secure' : '');
    }

    private function cookie(Request $r): ?string
    {
        return preg_match('/(?:^|;\s*)'.self::COOKIE.'=([0-9a-f]{64})(?:;|$)/', (string) $r->header('Cookie'), $m) ? $m[1] : null;
    }

    private function origin(Request $r): void
    {
        $o = $r->header('Origin');
        if ($o) {
            $host = parse_url($o, PHP_URL_HOST);
            $full = $host === null ? null : $host.(parse_url($o, PHP_URL_PORT) ? ':'.parse_url($o, PHP_URL_PORT) : '');
            if ($full !== $r->getHttpHost()) {
                throw new GameError(403, 'BAD_ORIGIN');
            }
        }
    }

    /* ---------- throttling ---------- */

    private function locked(string $key): bool
    {
        $f = Cache::get('horse-pl-fail:'.$key);

        return $f && $f['until'] > $this->engine->now();
    }

    private function fail(string $key, int $limit): void
    {
        $t = $this->engine->now();
        $f = Cache::get('horse-pl-fail:'.$key);
        if (! $f || $t - $f['first'] > self::LOCK_MS) {
            $f = ['n' => 0, 'first' => $t, 'until' => 0];
        }
        $f['n']++;
        if ($f['n'] >= $limit) {
            $f['until'] = $t + self::LOCK_MS;
        }
        Cache::put('horse-pl-fail:'.$key, $f, 3600);
    }

    /* ---------- sessions ---------- */

    private function open(object $p, string $ip): array
    {
        $token = bin2hex(random_bytes(32));
        $csrf = bin2hex(random_bytes(16));
        $t = $this->engine->now();
        DB::table('player_sessions')->insert(['token_hash' => self::sha($token), 'player_id' => $p->id, 'csrf' => $csrf, 'created_at' => $t, 'last_seen' => $t, 'ip' => $ip]);
        DB::table('players')->where('id', $p->id)->update(['last_login_at' => $t]);
        DB::table('player_sessions')->where('last_seen', '<', $t - self::IDLE_MS)->delete();

        return ['token' => $token, 'csrf' => $csrf];
    }

    /** @return array{0:object,1:object} [player, session] */
    private function session(Request $r, bool $mutating): array
    {
        $token = $this->cookie($r);
        $s = $token ? DB::table('player_sessions')->where('token_hash', self::sha($token))->first() : null;
        if (! $s) {
            throw new GameError(401, 'NOT_LOGGED_IN');
        }
        $t = $this->engine->now();
        if ($t - $s->last_seen > self::IDLE_MS || $t - $s->created_at > self::ABSOLUTE_MS) {
            DB::table('player_sessions')->where('token_hash', $s->token_hash)->delete();
            throw new GameError(401, 'SESSION_EXPIRED');
        }
        $p = $this->house->player((int) $s->player_id);
        if (! $p || $p->status !== 'active') {
            DB::table('player_sessions')->where('token_hash', $s->token_hash)->delete();
            throw new GameError(401, 'NOT_LOGGED_IN');
        }
        if ($mutating && ! hash_equals($s->csrf, (string) $r->header('X-CSRF-Token'))) {
            throw new GameError(403, 'BAD_CSRF');
        }
        DB::table('player_sessions')->where('token_hash', $s->token_hash)->update(['last_seen' => $t]);

        return [$p, $s];
    }

    private function me(object $p, string $csrf): array
    {
        return ['player' => $this->house->view($p), 'csrf' => $csrf, 'payment' => $this->house->publicSettings()];
    }

    /* ---------- the endpoints ---------- */

    public function handle(Request $r, string $sub): Response
    {
        $method = $r->method();
        $ip = (string) $r->ip();
        try {
            $raw = $r->getContent();
            $body = $raw === '' || $raw === null ? [] : json_decode($raw, true);
            if (! is_array($body)) {
                return $this->send(400, ['ok' => false, 'error' => 'BAD_JSON']);
            }
            if ($method !== 'GET' && $method !== 'HEAD') {
                $this->origin($r);
            }
            if ($sub === 'config' && $method === 'GET') {                  // before sign-in: is registration open, what are the limits
                return $this->send(200, ['ok' => true, 'payment' => $this->house->publicSettings()]);
            }
            if ($sub === 'register' && $method === 'POST') {
                if ($this->locked('reg:'.$ip)) {
                    throw new GameError(429, 'TOO_MANY_ATTEMPTS');
                }
                $this->fail('reg:'.$ip, 10);                                 // ten sign-up attempts per address per 10 minutes, success or not
                $p = $this->house->register($body, $ip);
                $s = $this->open($p, $ip);

                return $this->send(200, ['ok' => true] + $this->me($p, $s['csrf']), ['Set-Cookie' => $this->setCookie($s['token'], (int) (self::ABSOLUTE_MS / 1000))]);
            }
            if ($sub === 'login' && $method === 'POST') {
                $user = strtolower(trim((string) ($body['username'] ?? '')));
                if ($this->locked('ip:'.$ip) || $this->locked('u:'.$user)) {
                    throw new GameError(429, 'TOO_MANY_ATTEMPTS');
                }
                $p = $user !== '' ? DB::table('players')->where('username', $user)->first() : null;
                $ok = password_verify((string) ($body['password'] ?? ''), $p ? $p->pass : ($this->dummy ??= password_hash('dummy', PASSWORD_ARGON2ID)));
                if (! $p || ! $ok) {
                    $this->fail('ip:'.$ip, 30);
                    $this->fail('u:'.$user, 8);
                    throw new GameError(401, 'BAD_LOGIN');
                }
                if ($p->status !== 'active') {
                    throw new GameError(403, 'ACCOUNT_SUSPENDED');
                }
                $s = $this->open($p, $ip);

                return $this->send(200, ['ok' => true] + $this->me($p, $s['csrf']), ['Set-Cookie' => $this->setCookie($s['token'], (int) (self::ABSOLUTE_MS / 1000))]);
            }
            if ($sub === 'logout' && $method === 'POST') {
                $token = $this->cookie($r);
                if ($token) {
                    DB::table('player_sessions')->where('token_hash', self::sha($token))->delete();
                }

                return $this->send(200, ['ok' => true], ['Set-Cookie' => $this->setCookie('', 0)]);
            }

            [$p, $s] = $this->session($r, $method !== 'GET' && $method !== 'HEAD');
            if ($sub === 'me' && $method === 'GET') {
                return $this->send(200, ['ok' => true] + $this->me($p, $s->csrf));
            }
            if ($sub === 'launch' && $method === 'POST') {                  // a one-time token for POST /api/auth (client "house")
                return $this->send(200, ['ok' => true, 'token' => $this->house->launchToken($p), 'client' => HouseWallet::CLIENT]);
            }
            if ($sub === 'wallet' && $method === 'GET') {
                return $this->send(200, ['ok' => true, 'balance' => (int) $p->balance, 'tx' => $this->house->txOf((int) $p->id, 30), 'deposits' => $this->house->depositsOf((int) $p->id, 20),
                    'withdrawals' => $this->house->withdrawalsOf((int) $p->id, 20)]);
            }
            if ($sub === 'deposit' && $method === 'POST') {
                $id = $this->house->requestDeposit($p, $body);

                return $this->send(200, ['ok' => true, 'id' => $id]);
            }
            if ($sub === 'withdraw' && $method === 'POST') {
                $id = $this->house->requestWithdrawal($p, $body);

                return $this->send(200, ['ok' => true, 'id' => $id, 'balance' => (int) DB::table('players')->where('id', $p->id)->value('balance')]);
            }
            if ($sub === 'password' && $method === 'POST') {
                $this->house->changePassword($p, (string) ($body['current'] ?? ''), (string) ($body['next'] ?? ''));
                DB::table('player_sessions')->where('player_id', $p->id)->where('token_hash', '!=', $s->token_hash)->delete();

                return $this->send(200, ['ok' => true]);
            }

            return $this->send(404, ['ok' => false, 'error' => 'NOT_FOUND']);
        } catch (GameError $e) {
            return $this->send($e->status, ['ok' => false, 'error' => $e->errorCode, 'message' => $e->getMessage()]);
        }
    }
}
