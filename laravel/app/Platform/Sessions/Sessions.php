<?php

namespace App\Platform\Sessions;

use App\Game\GameError;
use App\Platform\Clients\ClientDirectory;
use App\Platform\Limits\Limits;
use App\Platform\PlayerKey;
use App\Platform\Wallet\WalletGateway;
use Closure;
use Illuminate\Support\Facades\DB;

/**
 * Player sessions: the launch token a platform gives the player is exchanged for a game session (the wallet validates it), the session is looked up on every
 * request, and an operator or platform can block a player or end a player's sessions. Moved out of the Engine unchanged. A session belongs to one game
 * (game_id, 'horse-race' unless another game asks for its own).
 */
final class Sessions
{
    /**
     * @param  Closure(): int  $now  the clock in milliseconds
     * @param  Closure(array): void  $log  writes a line to the ledger
     */
    public function __construct(private Closure $now, private Closure $log, private array $cfg, private ClientDirectory $clients, private WalletGateway $gateway, private Limits $limits) {}

    private function now(): int
    {
        return ($this->now)();
    }

    /** the session id the player holds is never stored: only its hash is */
    public static function key(string $id): string
    {
        return hash('sha256', $id);
    }

    /** exchanges a launch token for a session. @throws GameError */
    public function auth(string $token, ?string $clientHint = null, string $gameId = 'horse-race'): array
    {
        $clientId = $this->clients->resolve($clientHint);
        $client = $this->clients->config($clientId);
        $wallet = $this->clients->walletFor($clientId);
        if (! $wallet) {
            throw new GameError(400, 'INVALID_CLIENT');
        }
        try {
            $info = $this->gateway->call(fn () => $wallet->validateToken($token), 'validate', $clientId);
        } catch (\Throwable $e) {
            throw new GameError(401, 'INVALID_TOKEN');
        }
        if (! preg_match(ClientDirectory::PLAYER_ID_RE, (string) ($info['playerId'] ?? ''))) {
            throw new GameError(401, 'INVALID_PLAYER_ID');
        }
        $pk = PlayerKey::make($clientId, (string) $info['playerId']);
        if (! empty($info['blocked']) || DB::table('blocked_players')->where('player_key', $pk)->exists()) {
            throw new GameError(403, 'PLAYER_BLOCKED');
        }
        $id = bin2hex(random_bytes(24));
        $currency = $info['currency'] ?? $client['currency'] ?? $this->cfg['currency'];
        $rm = isset($info['realityCheckMinutes']) && is_int($info['realityCheckMinutes']) ? $info['realityCheckMinutes'] : ($client['realityCheckMinutes'] ?? $this->cfg['reality_check_minutes']);
        $returnUrl = $info['returnUrl'] ?? null;
        if ($returnUrl && ! empty($client['returnUrlHosts'])) {
            $host = strtolower((string) parse_url($returnUrl, PHP_URL_HOST));
            if (! in_array($host, $client['returnUrlHosts'], true)) {
                $returnUrl = null;
            }
        }
        $d = $info['decimals'] ?? ($client['currencyLimits'][$currency]['decimals'] ?? ($this->cfg['currency_limits'][$currency]['decimals'] ?? null));
        $t = $this->now();
        DB::table('game_sessions')->insert([
            'key' => self::key($id), 'player_key' => $pk, 'raw_id' => (string) $info['playerId'], 'client_id' => $clientId, 'brand_id' => ! empty($info['brandId']) ? (string) $info['brandId'] : null,
            'currency' => $currency, 'decimals' => is_int($d) && $d >= 0 && $d <= 4 ? $d : 2, 'balance' => $info['balance'] ?? null, 'return_url' => $returnUrl,
            'limits' => json_encode($this->limits->for($currency, $info, $client)), 'reality_minutes' => $rm > 0 ? (int) $rm : 0, 's_staked' => 0, 's_paid' => 0,
            'created_at' => $t, 'expires_at' => $t + $this->cfg['session_ttl_ms'], 'refreshed_at' => $t,
        ] + ($gameId === 'horse-race' ? [] : ['game_id' => $gameId]));
        $s = DB::table('game_sessions')->where('key', self::key($id))->first();

        return ['session' => $id, 'playerId' => (string) $info['playerId'], 'returnUrl' => $returnUrl] + $this->view($s);
    }

    /** what a session tells the player: currency, balance, limits and the responsible-gaming figures */
    public function view(object $s): array
    {
        return ['currency' => $s->currency, 'decimals' => (int) $s->decimals, 'balance' => $s->balance === null ? null : (int) $s->balance, 'limits' => json_decode($s->limits, true), 'brandId' => $s->brand_id,
            'responsible' => ['realityCheckMinutes' => (int) $s->reality_minutes, 'startedAt' => (int) $s->created_at, 'staked' => (int) $s->s_staked, 'paid' => (int) $s->s_paid,
                'dailyNetLoss' => max(0, $this->limits->dayNet($s->player_key))]];
    }

    /** the live session of a session id, or null (unknown, expired, or its client was disabled) */
    public function find(string $id): ?object
    {
        if ($id === '') {
            return null;
        }
        $s = DB::table('game_sessions')->where('key', self::key($id))->first();
        if (! $s) {
            return null;
        }
        if ($s->expires_at < $this->now() || ! $this->clients->isActive($s->client_id)) {          // a disabled client ends its sessions
            DB::table('game_sessions')->where('key', $s->key)->delete();

            return null;
        }

        return $s;
    }

    public function blockPlayer(string $playerKey, string $who = 'operator'): array
    {
        if ($playerKey === '') {
            throw new GameError(400, 'BAD_REQUEST');
        }
        DB::table('blocked_players')->updateOrInsert(['player_key' => $playerKey], ['who' => $who]);
        $n = DB::table('game_sessions')->where('player_key', $playerKey)->delete();
        ($this->log)(['e' => 'player_blocked', 'playerId' => $playerKey, 'who' => $who]);

        return ['ok' => true, 'blocked' => true, 'closed' => $n];
    }

    /** operator / platform: end a player's sessions (all of them) at once */
    public function closeSessions(string $playerKey): int
    {
        $n = DB::table('game_sessions')->where('player_key', $playerKey)->delete();
        if ($n) {
            ($this->log)(['e' => 'sessions_closed', 'playerId' => $playerKey, 'count' => $n]);
        }

        return $n;
    }

    public function unblockPlayer(string $playerKey, string $who = 'operator'): array
    {
        DB::table('blocked_players')->where('player_key', $playerKey)->delete();
        ($this->log)(['e' => 'player_unblocked', 'playerId' => $playerKey, 'who' => $who]);

        return ['ok' => true, 'blocked' => false];
    }
}
