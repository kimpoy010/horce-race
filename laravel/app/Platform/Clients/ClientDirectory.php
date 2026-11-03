<?php

namespace App\Platform\Clients;

use App\Game\Clients\ClientRegistry;
use App\Game\GameError;
use App\Game\Wallet\Wallet;
use App\Game\Webhook;

/**
 * Which platform a player belongs to and what that platform has: its wallet, its webhook, whether it is active. The registry holds the clients; the implicit
 * "default" client (HORSE_WALLET) has the wallet and webhook the application was started with. Moved out of the Engine unchanged.
 */
final class ClientDirectory
{
    public const PLAYER_ID_RE = '/^[A-Za-z0-9_.@-]{1,64}$/';

    public function __construct(private ?Wallet $wallet, private ?Webhook $webhook, private ?ClientRegistry $clients) {}

    public function registry(): ?ClientRegistry
    {
        return $this->clients;
    }

    /** the client's settings (limits, big-win threshold ...); a client that is not in the registry has none */
    public function config(string $id): array
    {
        return ($this->clients ? $this->clients->get($id) : null) ?? ['id' => $id, 'status' => 'active', 'limits' => [], 'currencyLimits' => []];
    }

    public function walletFor(string $clientId): ?Wallet
    {
        if ($this->clients && $this->clients->get($clientId)) {
            return $this->clients->walletFor($clientId);
        }

        return $clientId === 'default' ? $this->wallet : null;
    }

    public function webhookFor(string $clientId): ?Webhook
    {
        if ($this->clients && $this->clients->get($clientId)) {
            return $this->clients->webhookFor($clientId);
        }

        return $clientId === 'default' ? $this->webhook : null;
    }

    public function isActive(string $id): bool
    {
        $c = $this->clients ? $this->clients->get($id) : null;

        return $c ? $c['status'] === 'active' : ($id === 'default' && $this->wallet !== null);
    }

    /** which client a launch belongs to (the launch link may omit it when there is only one) */
    public function resolve(?string $clientId): string
    {
        if (! $clientId) {
            if ($this->wallet) {
                return 'default';
            }
            $active = $this->clients ? $this->clients->activeIds() : [];
            if (count($active) === 1) {
                return $active[0];
            }
            throw new GameError(400, 'CLIENT_REQUIRED');
        }
        if (! preg_match(ClientRegistry::ID_RE, $clientId)) {
            throw new GameError(400, 'INVALID_CLIENT');
        }
        $c = $this->clients ? $this->clients->get($clientId) : null;
        if ($c) {
            if ($c['status'] !== 'active') {
                throw new GameError(403, 'CLIENT_DISABLED');
            }

            return $clientId;
        }
        if ($clientId === 'default' && $this->wallet) {
            return 'default';
        }
        throw new GameError(400, 'INVALID_CLIENT');
    }

    public function playerKey(?string $clientId, mixed $playerId): string
    {
        if (! preg_match(self::PLAYER_ID_RE, (string) $playerId)) {
            throw new GameError(400, 'BAD_REQUEST');
        }

        return \App\Platform\PlayerKey::make($clientId ?: 'default', (string) $playerId);
    }

    /** restricts a query to the players of one client (their player keys start with "<client>:", the default client's have no ":") */
    public static function ofClient($q, string $clientId, string $col = 'player_key')
    {
        return $clientId === 'default' ? $q->where($col, 'not like', '%:%') : $q->where($col, 'like', $clientId.':%');
    }
}
