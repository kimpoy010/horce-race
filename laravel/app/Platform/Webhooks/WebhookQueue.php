<?php

namespace App\Platform\Webhooks;

use App\Platform\Clients\ClientDirectory;
use App\Platform\Wallet\WalletGateway;
use Closure;
use Illuminate\Support\Facades\DB;

/**
 * Events to the platform (a round settled, a big win ...): queued in pending_ops, delivered at least once with back-off, and the platform de-duplicates on the
 * event id. Moved out of the Engine unchanged. The id and the "gameId" of an event name the game; the horse race's are 'horse-race:...' as they have always been.
 */
final class WebhookQueue
{
    /**
     * @param  Closure(): int  $now  the clock in milliseconds
     * @param  Closure(array): void  $log  writes a line to the ledger
     */
    public function __construct(private Closure $now, private Closure $log, private ClientDirectory $clients, private WalletGateway $gateway, private string $defaultGame = 'horse-race') {}

    private function now(): int
    {
        return ($this->now)();
    }

    /** queues an event for the client's webhook if the client has one and wants this type of event; $key makes the event id unique per client and game */
    public function emit(string $type, string $key, array $data, string $clientId, ?string $gameId = null): void
    {
        $game = $gameId ?? $this->defaultGame;
        $wh = $this->clients->isActive($clientId) ? $this->clients->webhookFor($clientId) : null;
        if (! $wh || ! $wh->wants($type)) {
            return;
        }
        $ev = ['id' => $game.':'.($clientId === 'default' ? '' : $clientId.':').$key, 'type' => $type, 'createdAt' => $this->now(), 'gameId' => $game, 'clientId' => $clientId, 'data' => $data];
        ($this->log)(['e' => 'webhook_due', 'ev' => $ev]);
        DB::table('pending_ops')->insertOrIgnore(['tx_id' => $ev['id'], 'kind' => 'webhook', 'player_key' => '', 'amount' => 0, 'race_no' => $data['raceNo'] ?? null,
            'extra' => json_encode($ev, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE), 'since' => $this->now(), 'tries' => 0, 'next_at' => 0]
            + ($game === $this->defaultGame ? [] : ['game_id' => $game, 'round_ref' => isset($data['roundId']) ? (string) $data['roundId'] : null]));
    }

    public function flush(): void
    {
        $t = $this->now();
        foreach (DB::table('pending_ops')->where('kind', 'webhook')->where('next_at', '<=', $t)->orderBy('since')->limit(100)->get() as $p) {
            $ev = json_decode($p->extra, true);
            $cid = $ev['clientId'] ?? 'default';
            $wh = $this->clients->isActive($cid) ? $this->clients->webhookFor($cid) : null;
            if (! $wh) {
                DB::table('pending_ops')->where('tx_id', $p->tx_id)->delete();
                ($this->log)(['e' => 'webhook_dropped', 'id' => $p->tx_id, 'reason' => 'client has no webhook any more']);

                continue;
            }
            try {
                $wh->send($ev);
                DB::table('pending_ops')->where('tx_id', $p->tx_id)->delete();
                ($this->log)(['e' => 'webhook_ok', 'id' => $p->tx_id]);
            } catch (\Throwable $e) {
                $this->gateway->backoff($p, $t);
            }
        }
    }
}
