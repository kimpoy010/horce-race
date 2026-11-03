<?php

namespace App\Games\BingoPinball;

use App\Game\Clients\SecretBox;
use App\Game\GameError;
use App\Platform\Ledger\Journal;
use Closure;
use Illuminate\Support\Facades\DB;

/**
 * The provably fair seed pairs of a player (see docs/bingo/MATH.md, section 3).
 *
 * A pair is a server seed (32 random bytes, secret, stored encrypted) and a client seed (the player's own or a random default). The player is shown the commit,
 * sha256 of the server seed, before the first play. Every play under the pair uses the next nonce (1, 2, 3 ...). When the pair is replaced, on the player's request or
 * after `rotate_every` plays, the old server seed is revealed so that every play under it can be re-run, and a new pair with a new commit starts.
 *
 * Callers hold the player's lock (the same lock as every money action of the player): nothing here is safe against two simultaneous callers for one player.
 */
final class SeedService
{
    public const GAME = 'bingo-pinball';

    /** @param Closure(): int $now the clock in milliseconds */
    public function __construct(private Journal $journal, private Closure $now, private string $clientsKey, private int $rotateEvery = 1000) {}

    private function newPair(string $playerKey, ?string $clientSeed): object
    {
        if ($this->clientsKey === '') {                       // SecretBox would store the seed in clear text without a key
            throw new GameError(503, 'GAME_NOT_CONFIGURED', 'HORSE_CLIENTS_KEY is needed to keep the seeds secret');
        }
        $clientSeed ??= bin2hex(random_bytes(8));
        if (! preg_match(Draw::CLIENT_SEED_RE, $clientSeed)) {
            throw new GameError(400, 'BAD_CLIENT_SEED', 'The client seed is 1 to 64 letters, digits, "-" or "_".');
        }
        $seed = Draw::newServerSeed();
        $id = DB::table('player_seeds')->insertGetId(['player_key' => $playerKey, 'game_id' => self::GAME, 'server_seed' => SecretBox::encrypt($seed, $this->clientsKey), 'commit' => Draw::commitOf($seed),
            'client_seed' => $clientSeed, 'next_nonce' => 1, 'status' => 'active', 'created_at' => ($this->now)()]);
        $row = DB::table('player_seeds')->where('id', $id)->first();
        $this->journal->log(['e' => 'seed.commit', 'playerId' => $playerKey, 'seedId' => $id, 'commit' => $row->commit, 'clientSeed' => $clientSeed], self::GAME);

        return $row;
    }

    /** the player's current pair; the first call makes one */
    public function active(string $playerKey): object
    {
        return DB::table('player_seeds')->where('player_key', $playerKey)->where('game_id', self::GAME)->where('status', 'active')->orderByDesc('id')->first() ?? $this->newPair($playerKey, null);
    }

    /** what the player may see of a pair that is still secret */
    public function view(object $seed): array
    {
        return ['seedId' => (int) $seed->id, 'commit' => $seed->commit, 'clientSeed' => $seed->client_seed, 'nextNonce' => (int) $seed->next_nonce, 'plays' => (int) $seed->next_nonce - 1,
            'rotatesAfter' => $this->rotateEvery];
    }

    public function serverSeed(object $seed): string
    {
        return (string) SecretBox::decrypt($seed->server_seed, $this->clientsKey);
    }

    /** the pair has been used for as many plays as it may be */
    public function needsRotation(object $seed): bool
    {
        return $this->rotateEvery > 0 && (int) $seed->next_nonce > $this->rotateEvery;
    }

    /** reserves the nonce of the next play under the pair and returns it */
    public function take(object $seed): int
    {
        $nonce = (int) $seed->next_nonce;
        DB::table('player_seeds')->where('id', $seed->id)->update(['next_nonce' => $nonce + 1]);

        return $nonce;
    }

    /**
     * Reveals the current pair and starts a new one (with the given client seed, or a random one).
     *
     * @return array{revealed: array, active: array}
     */
    public function rotate(string $playerKey, ?string $clientSeed = null): array
    {
        if ($clientSeed !== null && ! preg_match(Draw::CLIENT_SEED_RE, $clientSeed)) {
            throw new GameError(400, 'BAD_CLIENT_SEED', 'The client seed is 1 to 64 letters, digits, "-" or "_".');
        }

        return DB::transaction(function () use ($playerKey, $clientSeed) {
            $old = $this->active($playerKey);
            $revealed = $this->reveal($old);
            $new = $this->newPair($playerKey, $clientSeed);

            return ['revealed' => $revealed, 'active' => $this->view($new)];
        });
    }

    /** closes a pair and makes its server seed public */
    private function reveal(object $seed): array
    {
        DB::table('player_seeds')->where('id', $seed->id)->update(['status' => 'revealed', 'revealed_at' => ($this->now)()]);
        $server = $this->serverSeed($seed);
        $plays = (int) $seed->next_nonce - 1;
        $this->journal->log(['e' => 'seed.reveal', 'playerId' => $seed->player_key, 'seedId' => (int) $seed->id, 'commit' => $seed->commit, 'serverSeed' => $server, 'plays' => $plays], self::GAME);

        return ['seedId' => (int) $seed->id, 'serverSeed' => $server, 'commit' => $seed->commit, 'clientSeed' => $seed->client_seed, 'plays' => $plays];
    }

    /** everything needed to re-run the plays of a pair, or null while the pair is still secret */
    public function revealed(int $seedId): ?array
    {
        $seed = DB::table('player_seeds')->where('id', $seedId)->first();
        if (! $seed || $seed->status !== 'revealed') {
            return null;
        }

        return ['seedId' => (int) $seed->id, 'serverSeed' => $this->serverSeed($seed), 'commit' => $seed->commit, 'clientSeed' => $seed->client_seed, 'plays' => (int) $seed->next_nonce - 1];
    }
}
