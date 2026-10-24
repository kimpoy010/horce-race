<?php

namespace App\Game;

use App\Game\Wallet\Signer;
use Illuminate\Support\Facades\Http;

/**
 * Server-to-server events to the platform (at least once, signed like the wallet calls, docs/WALLET_API.md):
 *   POST <url>  { id, type, createdAt, gameId, data }        (id is unique and stable: de-duplicate on it)
 * types: round.settled (every race) and big.win (a player's payout in one race >= the client's threshold).
 * Any 2xx reply means "received"; anything else is retried with back-off.
 */
final class Webhook
{
    /** @var list<string> */
    private array $events;

    public function __construct(private string $url, private string $key, private string $keyId = '', string $events = 'round.settled,big.win', private int $timeoutMs = 8000)
    {
        $this->events = array_values(array_filter(array_map('trim', explode(',', $events))));
    }

    public function wants(string $type): bool
    {
        return in_array($type, $this->events, true);
    }

    /** @throws \RuntimeException when the platform did not answer 2xx */
    public function send(array $ev): void
    {
        $text = json_encode($ev, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        $headers = ['Content-Type' => 'application/json'] + Signer::headers($this->key, $this->keyId, 'POST', parse_url($this->url, PHP_URL_PATH) ?: '/', $text);
        $res = Http::withHeaders($headers)->timeout(max(1, (int) ceil($this->timeoutMs / 1000)))->withBody($text, 'application/json')->post($this->url);
        if (! $res->successful()) {
            throw new \RuntimeException('HTTP_'.$res->status());
        }
    }
}
