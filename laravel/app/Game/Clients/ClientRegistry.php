<?php

namespace App\Game\Clients;

use App\Game\GameError;
use App\Game\Wallet\HttpWallet;
use App\Game\Wallet\MockWallet;
use App\Game\Wallet\Wallet;
use App\Game\Webhook;
use Closure;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;

/**
 * Client registry (port of server/clients.js): the platforms (operators) that offer the game. One game, many clients. Per client:
 *   - how the game reaches its wallet (URL + signing secret) and where its webhooks go,
 *   - its own API key(s) for the client API (stored hashed, shown once),
 *   - its currency, limits, reality check, big-win threshold, allowed IP addresses.
 * Stored in the `clients` table; wallet and webhook secrets are encrypted with HORSE_CLIENTS_KEY (same format as the Node file).
 */
final class ClientRegistry
{
    public const ID_RE = '/^[a-z0-9][a-z0-9-]{1,31}$/';

    /** @var array<string,array{0:int,1:?array}> */
    private array $cache = [];

    /** @var array<string,Wallet> */
    private array $wallets = [];

    /** @var array<string,?Webhook> */
    private array $hooks = [];

    public function __construct(private string $secret = '', private bool $allowMock = false, private bool $allowHttp = false, private ?Closure $clock = null, private int $cacheMs = 2000) {}

    public function now(): int
    {
        return $this->clock ? ($this->clock)() : (int) floor(microtime(true) * 1000);
    }

    private static function sha(string $s): string
    {
        return hash('sha256', $s);
    }

    /* ---------- ip allow list (IPv4 exact or CIDR, IPv6 exact) ---------- */

    private static function v4(string $ip): ?int
    {
        if (! preg_match('/^(?:::ffff:)?(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/i', $ip, $m)) {
            return null;
        }

        return (((int) $m[1]) << 24) + (((int) $m[2]) << 16) + (((int) $m[3]) << 8) + (int) $m[4];
    }

    public static function ipAllowed(array $list, string $ip): bool
    {
        if (! $list) {
            return true;
        }
        $n = self::v4($ip);
        foreach ($list as $e) {
            if ($e === $ip) {
                return true;
            }
            [$base, $bits] = array_pad(explode('/', (string) $e, 2), 2, null);
            $b = self::v4($base);
            if ($b === null || $n === null) {
                continue;
            }
            $len = $bits === null ? 32 : (int) $bits;
            $mask = $len === 0 ? 0 : (0xFFFFFFFF << (32 - $len)) & 0xFFFFFFFF;
            if (($n & $mask) === ($b & $mask)) {
                return true;
            }
        }

        return false;
    }

    private static function validIpEntry(string $e): bool
    {
        [$base, $bits] = array_pad(explode('/', $e, 2), 2, null);
        if (self::v4($base) !== null) {
            return $bits === null || (ctype_digit($bits) && (int) $bits >= 0 && (int) $bits <= 32);
        }

        return $bits === null && (bool) preg_match('/^[0-9a-f:]+$/i', $base);
    }

    /* ---------- validation ---------- */

    private static function fail(string $m, int $status = 400, string $code = 'BAD_CLIENT'): GameError
    {
        return GameError::badClient($m, $status, $code);
    }

    private static function posInt(mixed $v): bool
    {
        return is_int($v) && $v > 0;
    }

    private static function cleanLimits(mixed $l, string $label): ?array
    {
        if ($l === null) {
            return null;
        }
        if (! is_array($l)) {
            throw self::fail("$label must be an object");
        }
        $out = [];
        foreach (['minBet', 'maxBet', 'maxRoundStake'] as $k) {
            if (array_key_exists($k, $l)) {
                if (! self::posInt($l[$k])) {
                    throw self::fail("$label.$k must be a positive whole number (minor units)");
                }
                $out[$k] = $l[$k];
            }
        }
        if (array_key_exists('dailyLossLimit', $l)) {
            if (! is_int($l['dailyLossLimit']) || $l['dailyLossLimit'] < 0) {
                throw self::fail("$label.dailyLossLimit must be a whole number, 0 = none");
            }
            $out['dailyLossLimit'] = $l['dailyLossLimit'];
        }
        if (array_key_exists('decimals', $l)) {
            if (! is_int($l['decimals']) || $l['decimals'] < 0 || $l['decimals'] > 4) {
                throw self::fail("$label.decimals must be 0 to 4");
            }
            $out['decimals'] = $l['decimals'];
        }
        if (isset($out['minBet'], $out['maxBet']) && $out['maxBet'] < $out['minBet']) {
            throw self::fail("$label.maxBet is below minBet");
        }

        return $out;
    }

    private function urlOk(string $url, string $label): void
    {
        $u = parse_url($url);
        if (! $u || empty($u['scheme']) || empty($u['host'])) {
            throw self::fail("$label must be a full URL");
        }
        $local = (bool) preg_match('/^(localhost|127\.|\[::1\])/', $u['host']);
        if ($u['scheme'] !== 'https' && ! ($u['scheme'] === 'http' && ($this->allowHttp || $local))) {
            throw self::fail("$label must be https (http only for localhost)");
        }
    }

    /** the normalised client (secrets still in plain text) */
    public function normalize(array $c): array
    {
        if (! preg_match(self::ID_RE, (string) ($c['id'] ?? ''))) {
            throw self::fail('id must be 2 to 32 characters: lower-case letters, digits and "-", starting with a letter or digit');
        }
        $out = ['id' => $c['id'], 'name' => mb_substr((string) ($c['name'] ?? $c['id']), 0, 80), 'status' => ($c['status'] ?? '') === 'disabled' ? 'disabled' : 'active'];
        $w = $c['wallet'] ?? [];
        if (($w['type'] ?? null) === 'mock') {
            if (! $this->allowMock) {
                throw self::fail('wallet.type "mock" is only allowed with HORSE_ALLOW_MOCK_WALLET=true and never in production');
            }
            $out['wallet'] = ['type' => 'mock'];
        } else {
            $this->urlOk((string) ($w['url'] ?? ''), 'wallet.url');
            if (! is_string($w['secret'] ?? null) || strlen($w['secret']) < 16) {
                throw self::fail('wallet.secret must be at least 16 characters (openssl rand -hex 32)');
            }
            $out['wallet'] = ['type' => 'http', 'url' => rtrim((string) $w['url'], '/'), 'secret' => $w['secret'], 'keyId' => ! empty($w['keyId']) ? mb_substr((string) $w['keyId'], 0, 40) : '',
                'auth' => ($w['auth'] ?? '') === 'bearer' ? 'bearer' : 'hmac', 'timeoutMs' => self::posInt($w['timeoutMs'] ?? null) ? $w['timeoutMs'] : 8000];
        }
        if (! empty($c['webhook']['url'])) {
            $this->urlOk((string) $c['webhook']['url'], 'webhook.url');
            $secret = $c['webhook']['secret'] ?? ($out['wallet']['type'] === 'http' ? $out['wallet']['secret'] : '');
            if (! is_string($secret) || strlen($secret) < 16) {
                throw self::fail('webhook.secret must be at least 16 characters (it defaults to the wallet secret)');
            }
            $out['webhook'] = ['url' => (string) $c['webhook']['url'], 'secret' => $secret, 'keyId' => ! empty($c['webhook']['keyId']) ? (string) $c['webhook']['keyId'] : '',
                'events' => $c['webhook']['events'] ?? 'round.settled,big.win'];
        }
        if (array_key_exists('currency', $c) && $c['currency'] !== null && ! preg_match('/^[A-Z]{3,5}$/', (string) $c['currency'])) {
            throw self::fail('currency must be an upper-case code such as PHP');
        }
        if (! empty($c['currency'])) {
            $out['currency'] = $c['currency'];
        }
        $out['limits'] = self::cleanLimits($c['limits'] ?? null, 'limits') ?: [];
        $out['currencyLimits'] = [];
        foreach (($c['currencyLimits'] ?? []) as $k => $v) {
            $out['currencyLimits'][$k] = self::cleanLimits($v, "currencyLimits.$k");
        }
        if (array_key_exists('realityCheckMinutes', $c)) {
            if (! is_numeric($c['realityCheckMinutes']) || $c['realityCheckMinutes'] < 0) {
                throw self::fail('realityCheckMinutes must be 0 or more');
            }
            $out['realityCheckMinutes'] = $c['realityCheckMinutes'] + 0;
        }
        if (array_key_exists('bigWinMin', $c)) {
            if (! self::posInt($c['bigWinMin'])) {
                throw self::fail('bigWinMin must be a positive whole number');
            }
            $out['bigWinMin'] = $c['bigWinMin'];
        }
        $out['allowedIps'] = [];
        foreach (($c['allowedIps'] ?? []) as $e) {
            if (! self::validIpEntry((string) $e)) {
                throw self::fail('allowedIps: "'.$e.'" is not an IP address or CIDR range');
            }
            $out['allowedIps'][] = (string) $e;
        }
        $out['returnUrlHosts'] = array_map(fn ($h) => strtolower((string) $h), $c['returnUrlHosts'] ?? []);
        $out['apiKeys'] = array_map(fn ($k) => ['id' => (string) $k['id'], 'hash' => (string) $k['hash'], 'createdAt' => $k['createdAt'] ?? 0, 'expiresAt' => $k['expiresAt'] ?? null, 'lastUsedAt' => $k['lastUsedAt'] ?? null],
            is_array($c['apiKeys'] ?? null) ? $c['apiKeys'] : []);
        $out['createdAt'] = $c['createdAt'] ?? 0;
        $out['updatedAt'] = $c['updatedAt'] ?? 0;

        return $out;
    }

    /* ---------- storage ---------- */

    private function decode(object $row): array
    {
        $c = json_decode($row->data, true);
        foreach (['wallet', 'webhook'] as $k) {
            if (isset($c[$k]['secret'])) {
                $c[$k]['secret'] = SecretBox::decrypt($c[$k]['secret'], $this->secret);
            }
        }

        return $this->normalize($c);
    }

    private function encode(array $c): string
    {
        foreach (['wallet', 'webhook'] as $k) {
            if (isset($c[$k]['secret'])) {
                $c[$k]['secret'] = SecretBox::encrypt($c[$k]['secret'], $this->secret);
            }
        }

        return json_encode($c, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT);
    }

    private function save(array $c, bool $new = false): void
    {
        $row = ['status' => $c['status'], 'data' => $this->encode($c), 'updated_at' => $c['updatedAt']];
        if ($new) {
            DB::table('clients')->insert(['id' => $c['id'], 'created_at' => $c['createdAt']] + $row);
        } else {
            DB::table('clients')->where('id', $c['id'])->update($row);
        }
        $this->forget($c['id']);
    }

    private function forget(string $id): void
    {
        unset($this->cache[$id], $this->wallets[$id], $this->hooks[$id]);
    }

    /** a client with its secrets in plain text, or null (kept for a short while so a busy table does not read the database for every request) */
    public function get(string $id): ?array
    {
        $now = $this->now();
        if (isset($this->cache[$id]) && $now - $this->cache[$id][0] < $this->cacheMs) {
            return $this->cache[$id][1];
        }
        $row = DB::table('clients')->where('id', $id)->first();
        $c = $row ? $this->decode($row) : null;
        $was = $this->cache[$id][1] ?? null;
        $this->cache[$id] = [$now, $c];
        if ($c === null || ($was && $was['updatedAt'] !== $c['updatedAt'])) {        // changed elsewhere (the operator's web request): rebuild the adapters
            unset($this->wallets[$id], $this->hooks[$id]);
        }

        return $c;
    }

    public function isActive(string $id): bool
    {
        $c = $this->get($id);

        return $c !== null && $c['status'] === 'active';
    }

    public function count(): int
    {
        return (int) DB::table('clients')->count();
    }

    /** @return list<array> the public view of every client */
    public function list(): array
    {
        return DB::table('clients')->orderBy('id')->get()->map(fn ($r) => $this->publicView($this->decode($r)))->all();
    }

    /** the ids of the active clients */
    public function activeIds(): array
    {
        return DB::table('clients')->where('status', 'active')->orderBy('id')->pluck('id')->all();
    }

    /** what an operator or the client itself may see: no secrets, no key hashes */
    public function publicView(array $c): array
    {
        foreach (['wallet', 'webhook'] as $k) {
            if (isset($c[$k]['secret'])) {
                $c[$k]['secret'] = '***'.substr((string) $c[$k]['secret'], -4);
            }
        }
        $c['apiKeys'] = array_map(fn ($k) => ['id' => $k['id'], 'createdAt' => $k['createdAt'], 'expiresAt' => $k['expiresAt'], 'lastUsedAt' => $k['lastUsedAt']], $c['apiKeys']);
        $c['limits'] = (object) $c['limits'];
        $c['currencyLimits'] = (object) $c['currencyLimits'];

        return $c;
    }

    /* ---------- changes ---------- */

    /** returns the key text; only its hash is kept. The older keys expire after $graceMs (null = they stay) */
    private function newKey(array &$c, ?int $graceMs = null): string
    {
        $key = 'hrk_'.$c['id'].'_'.bin2hex(random_bytes(24));
        $t = $this->now();
        if ($graceMs !== null) {
            foreach ($c['apiKeys'] as &$k) {
                if (! $k['expiresAt'] || $k['expiresAt'] > $t + $graceMs) {
                    $k['expiresAt'] = $t + $graceMs;
                }
            }
            unset($k);
        }
        $n = 0;
        foreach ($c['apiKeys'] as $k) {
            $n = max($n, (int) substr((string) $k['id'], 1));
        }
        $c['apiKeys'][] = ['id' => 'k'.($n + 1), 'hash' => self::sha($key), 'createdAt' => $t, 'expiresAt' => null, 'lastUsedAt' => null];

        return $key;
    }

    /** creates a client and its first API key (returned once); the wallet secret is generated when not given and returned once */
    public function create(array $input): array
    {
        if (DB::table('clients')->where('id', $input['id'] ?? '')->exists()) {
            throw self::fail('a client with this id exists', 409, 'CLIENT_EXISTS');
        }
        $walletSecret = null;
        if (isset($input['wallet']) && ($input['wallet']['type'] ?? null) !== 'mock' && empty($input['wallet']['secret'])) {
            $walletSecret = bin2hex(random_bytes(32));
            $input['wallet']['secret'] = $walletSecret;
        }
        $c = $this->normalize(['apiKeys' => []] + $input);
        $c['createdAt'] = $c['updatedAt'] = $this->now();
        $apiKey = $this->newKey($c);
        $this->save($c, true);
        $out = ['client' => $this->publicView($c), 'apiKey' => $apiKey];
        if ($walletSecret) {
            $out['walletSecret'] = $walletSecret;
        }

        return $out;
    }

    private function need(string $id): array
    {
        $c = $this->get($id);
        if (! $c) {
            throw self::fail('unknown client', 404, 'NOT_FOUND');
        }

        return $c;
    }

    public function update(string $id, array $patch): array
    {
        $cur = $this->need($id);
        $merged = $cur;
        foreach (['name', 'status', 'currency', 'realityCheckMinutes', 'bigWinMin', 'allowedIps', 'returnUrlHosts', 'limits', 'currencyLimits', 'webhook'] as $k) {
            if (array_key_exists($k, $patch)) {
                $merged[$k] = $patch[$k];
            }
        }
        if (! empty($patch['wallet'])) {
            $merged['wallet'] = $patch['wallet'] + $merged['wallet'];
        }
        if (array_key_exists('webhook', $patch) && $patch['webhook'] === null) {
            unset($merged['webhook']);
        }
        $c = $this->normalize($merged);
        $c['createdAt'] = $cur['createdAt'];
        $c['updatedAt'] = $this->now();
        $this->save($c);

        return $this->publicView($c);
    }

    public function setStatus(string $id, string $status): array
    {
        return $this->update($id, ['status' => $status]);
    }

    /** a new key; the old keys keep working for $graceMs (default 24 h, 0 = revoke now) so the client can switch over */
    public function rotateKey(string $id, ?int $graceMs = null): array
    {
        $c = $this->need($id);
        $apiKey = $this->newKey($c, $graceMs ?? 24 * 3600 * 1000);
        $c['updatedAt'] = $this->now();
        $this->save($c);

        return ['client' => $this->publicView($c), 'apiKey' => $apiKey];
    }

    public function revokeKey(string $id, string $keyId): array
    {
        $c = $this->need($id);
        $c['apiKeys'] = array_values(array_filter($c['apiKeys'], fn ($k) => $k['id'] !== $keyId));
        $c['updatedAt'] = $this->now();
        $this->save($c);

        return $this->publicView($c);
    }

    /** a new signing secret (returned once); the client's platform has to switch to it at the same time */
    public function rotateWalletSecret(string $id): array
    {
        $c = $this->need($id);
        if ($c['wallet']['type'] !== 'http') {
            throw self::fail('this client uses the mock wallet: there is no secret');
        }
        $c['wallet']['secret'] = $secret = bin2hex(random_bytes(32));
        $c['updatedAt'] = $this->now();
        $this->save($c);

        return ['client' => $this->publicView($c), 'walletSecret' => $secret];
    }

    public function rotateWebhookSecret(string $id): array
    {
        $c = $this->need($id);
        if (empty($c['webhook'])) {
            throw self::fail('this client has no webhook');
        }
        $c['webhook']['secret'] = $secret = bin2hex(random_bytes(32));
        $c['updatedAt'] = $this->now();
        $this->save($c);

        return ['client' => $this->publicView($c), 'webhookSecret' => $secret];
    }

    public function remove(string $id): void
    {
        if (! DB::table('clients')->where('id', $id)->delete()) {
            throw self::fail('unknown client', 404, 'NOT_FOUND');
        }
        $this->forget($id);
    }

    /* ---------- the client API key ---------- */

    /** Bearer key -> the client, or null. Failed attempts are counted per address (10 in 5 minutes block the address for 5 minutes). */
    public function authenticate(?string $key, string $ip): ?array
    {
        $t = $this->now();
        $fk = 'horse-keyfail:'.$ip;
        $f = Cache::get($fk);
        if ($f && $f['until'] > $t) {
            return null;
        }
        if ($f && $t - $f['first'] > 300000) {
            $f = null;                                               // count failures inside a 5 minute window
        }
        $hit = null;
        if (preg_match('/^hrk_([a-z0-9][a-z0-9-]{1,31})_[0-9a-f]{48}$/', (string) $key, $m)) {
            $c = $this->get($m[1]);
            if ($c && $c['status'] === 'active' && self::ipAllowed($c['allowedIps'], $ip)) {
                $h = self::sha((string) $key);
                foreach ($c['apiKeys'] as $i => $k) {
                    if (hash_equals($k['hash'], $h) && (! $k['expiresAt'] || $k['expiresAt'] > $t)) {
                        if (! $k['lastUsedAt'] || $t - $k['lastUsedAt'] > 300000) {         // not on every call: at most every five minutes
                            $c['apiKeys'][$i]['lastUsedAt'] = $t;
                            $row = DB::table('clients')->where('id', $c['id'])->first();
                            if ($row) {
                                $raw = json_decode($row->data, true);
                                foreach ($raw['apiKeys'] as $j => $rk) {
                                    if ($rk['id'] === $k['id']) {
                                        $raw['apiKeys'][$j]['lastUsedAt'] = $t;
                                    }
                                }
                                DB::table('clients')->where('id', $c['id'])->update(['data' => json_encode($raw, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT)]);
                                $this->forget($c['id']);
                            }
                        }
                        $hit = $c;
                        break;
                    }
                }
            }
        }
        if (! $hit) {
            $n = ($f['n'] ?? 0) + 1;
            Cache::put($fk, ['n' => $n, 'first' => $f['first'] ?? $t, 'until' => $n >= 10 ? $t + 300000 : 0], 600);
        } else {
            Cache::forget($fk);
        }

        return $hit;
    }

    /* ---------- adapters ---------- */

    /** the wallet adapter of a client (kept until its settings change) */
    public function walletFor(string $id): ?Wallet
    {
        $c = $this->get($id);
        if (! $c) {
            return null;
        }
        $key = $id;
        if (! isset($this->wallets[$key])) {
            $w = $c['wallet'];
            $this->wallets[$key] = $w['type'] === 'mock'
                ? new MockWallet((int) config('horse.mock_start_balance'), $c['currency'] ?? config('horse.currency'), $id)
                : new HttpWallet($w['url'], $w['secret'], $w['keyId'], $w['auth'], $w['timeoutMs'], $c['currency'] ?? config('horse.currency'), config('horse.game_id'));
        }

        return $this->wallets[$key];
    }

    public function webhookFor(string $id): ?Webhook
    {
        $c = $this->get($id);
        if (! $c || empty($c['webhook'])) {
            return null;
        }
        $h = $c['webhook'];

        return $this->hooks[$id] ??= new Webhook($h['url'], $h['secret'], $h['keyId'], $h['events']);
    }
}
