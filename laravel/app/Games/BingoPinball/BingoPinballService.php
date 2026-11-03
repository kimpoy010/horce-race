<?php

namespace App\Games\BingoPinball;

use App\Game\GameError;
use App\Platform\Clients\ClientDirectory;
use App\Platform\Games\Games;
use App\Platform\Ledger\Journal;
use App\Platform\Limits\Limits;
use App\Platform\PlayerKey;
use App\Platform\Sessions\Sessions;
use App\Platform\Wallet\WalletGateway;
use App\Platform\Webhooks\WebhookQueue;
use Closure;
use Illuminate\Contracts\Cache\LockTimeoutException;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * Bingo Pinball: the play flow of an instant game. One play = one request:
 *
 *   Requested -> the wallet takes the stake (bp:<id>:bet) -> Debited -> the five holes are drawn from the player's seed pair -> Drawn -> the best line is paid -> Settled
 *        |                                                                                                                              |
 *        |- limits / blocked / no funds / wallet says no -> nothing is charged (the round row is removed)                                |- a win is credited (bp:<id>:win),
 *        |- the debit answer is lost -> the play is void and a rollback is queued                                                         retried until the platform has it
 *
 * The result is drawn only after the wallet has confirmed the debit, and it is saved in the same transaction as its ledger lines and the queued credit: whatever
 * happens to the player's connection, /state shows the result. One money action per player at a time (the same lock as the horse race's bets). A repeated
 * requestId returns the round that already exists and never debits twice. Nothing here lets an operator, a staff role or an API call choose or influence a result.
 */
final class BingoPinballService
{
    public const GAME = 'bingo-pinball';

    private const REQUEST_ID_RE = '/^[A-Za-z0-9_-]{8,64}$/';

    /**
     * @param  Closure(): int  $now  the clock in milliseconds
     * @param  array{min_interval_ms:int, stuck_after_ms:int}  $settings
     */
    public function __construct(private Sessions $sessions, private WalletGateway $gateway, private Limits $limits, private ClientDirectory $clients, private Journal $journal,
        private WebhookQueue $webhooks, private SeedService $seeds, private Games $games, private Closure $now, private array $settings, private int $bigWinMin) {}

    private function now(): int
    {
        return ($this->now)();
    }

    /* ---------- the player's session ---------- */

    /** the client's paytable, or GAME_NOT_CONFIGURED: the RTP is an operator's decision, there is no default */
    private function paytableOf(array $client): Paytable
    {
        $v = $client['gameSettings'][self::GAME]['paytable'] ?? null;
        if (! is_int($v) || ! in_array($v, Paytables::VERSIONS, true)) {
            throw new GameError(409, 'GAME_NOT_CONFIGURED', 'This game has no paytable for this client yet.');
        }

        return Paytables::get($v);
    }

    private function assertEnabled(array $client): void
    {
        if (! $this->games->isEnabled($client, self::GAME)) {
            throw new GameError(403, 'GAME_NOT_ENABLED');
        }
    }

    /** exchanges the platform's launch token for a Bingo Pinball session. The token is not used up when the game is off or not set up for the client. */
    public function auth(string $token, ?string $clientHint): array
    {
        $this->seeds->assertReady();
        $cid = $this->clients->resolve($clientHint);
        $client = $this->clients->config($cid);
        $this->assertEnabled($client);
        $this->paytableOf($client);
        $out = $this->sessions->auth($token, $cid, self::GAME);

        return ['session' => $out['session'], 'playerId' => $out['playerId'], 'returnUrl' => $out['returnUrl']] + $this->stateOf($this->sessions->find($out['session']), false);
    }

    /** the live session of this game (any other game's session, a blocked player, a game that was switched off since: refused) */
    private function session(string $id): object
    {
        $this->seeds->assertReady();
        $s = $this->sessions->find($id);
        if (! $s) {
            throw new GameError(401, 'SESSION_EXPIRED');
        }
        if ($s->game_id !== self::GAME) {
            throw new GameError(403, 'WRONG_GAME');
        }
        $this->assertEnabled($this->clients->config($s->client_id));
        if (DB::table('blocked_players')->where('player_key', $s->player_key)->exists()) {
            throw new GameError(403, 'PLAYER_BLOCKED');
        }

        return $s;
    }

    /** the limits of this player in this game: the session's, narrowed by what the operator set for the client */
    private function limitsOf(object $s): array
    {
        $lim = json_decode($s->limits, true);
        $own = $this->clients->config($s->client_id)['gameSettings'][self::GAME]['limits'] ?? [];
        if (isset($own['minBet'])) {
            $lim['minBet'] = max($lim['minBet'], $own['minBet']);
        }
        if (isset($own['maxBet'])) {
            $lim['maxBet'] = min($lim['maxBet'], $own['maxBet']);
        }
        $lim['maxBet'] = max($lim['maxBet'], $lim['minBet']);

        return $lim;
    }

    /* ---------- state ---------- */

    public function state(string $sessionId): array
    {
        $s = $this->session($sessionId);
        $this->refreshBalance($s);

        return $this->stateOf($this->sessions->find($sessionId) ?? $s, true);
    }

    private function refreshBalance(object $s): void
    {
        try {                                                  // like the horse race: ask the wallet, keep the last known balance when it does not answer
            $w = $this->clients->walletFor($s->client_id) ?? throw new \RuntimeException('no wallet');
            $bal = $this->gateway->call(fn () => $w->balance($s->raw_id), 'balance', $s->client_id);
            DB::table('game_sessions')->where('key', $s->key)->update(['balance' => $bal]);
        } catch (\Throwable $e) {
            // keep the stored balance
        }
    }

    private function stateOf(object $s, bool $withRound): array
    {
        $client = $this->clients->config($s->client_id);
        $pt = $this->paytableOf($client);
        $base = $this->sessions->view($s);
        $seed = $this->seeds->active($s->player_key);
        $out = ['currency' => $s->currency, 'decimals' => (int) $s->decimals, 'balance' => $base['balance'], 'limits' => $this->limitsOf($s), 'responsible' => $base['responsible'],
            'paytable' => ['id' => $pt->id, 'version' => $pt->version, 'pays' => $pt->pays, 'card' => $pt->card, 'rtp' => $pt->publishedRtp, 'maxMultiple' => $pt->maxMultiple()],
            'seed' => $this->seeds->view($seed), 'minIntervalMs' => (int) $this->settings['min_interval_ms']];
        if ($withRound) {
            $last = DB::table('instant_rounds')->where('player_key', $s->player_key)->orderByDesc('id')->first();
            $out['last'] = $last ? $this->roundView($last) : null;
            $out['unseen'] = $last && $last->seen_at === null && in_array($last->status, ['settled', 'void'], true);
            $out['unfinished'] = $last && $last->status === 'debiting';
        }

        return $out;
    }

    /* ---------- a play ---------- */

    public function play(string $sessionId, mixed $stake, mixed $requestId): array
    {
        $s = $this->session($sessionId);
        if (! is_string($requestId) || ! preg_match(self::REQUEST_ID_RE, $requestId) || ! is_int($stake)) {
            throw new GameError(400, 'BAD_REQUEST');
        }
        try {                                                  // one money action per player at a time: the same lock as the horse race's bets
            return Cache::lock('horse-player:'.$s->player_key, 20)->block((int) ($this->settings['lock_wait_seconds'] ?? 5), fn () => $this->playLocked($s, $stake, $requestId));
        } catch (LockTimeoutException) {
            throw new GameError(429, 'TOO_MANY_REQUESTS');
        }
    }

    private function playLocked(object $s, int $stake, string $requestId): array
    {
        $pk = $s->player_key;
        $again = DB::table('instant_rounds')->where('player_key', $pk)->where('request_id', $requestId)->first();
        if ($again) {                                          // the same request twice: the same round, never a second debit
            return $this->answer($again, $s, true);
        }
        $client = $this->clients->config($s->client_id);
        $pt = $this->paytableOf($client);
        $lim = $this->limitsOf($s);
        if ($stake < $lim['minBet'] || $stake > $lim['maxBet']) {
            throw new GameError(400, 'BAD_BET');
        }
        $day = $this->limits->today($pk);
        if ($lim['dailyLossLimit'] > 0 && $day['staked'] - $day['paid'] + $stake > $lim['dailyLossLimit']) {
            throw new GameError(400, 'DAILY_LOSS_LIMIT');
        }
        $lastAt = DB::table('instant_rounds')->where('player_key', $pk)->max('created_at');
        if ($lastAt !== null && $this->now() - (int) $lastAt < (int) $this->settings['min_interval_ms']) {
            throw new GameError(429, 'TOO_FAST');
        }
        $seed = $this->seeds->active($pk);
        if ($this->seeds->needsRotation($seed)) {              // after so many plays the pair is replaced and the old server seed revealed
            $this->seeds->rotate($pk);
        }
        DB::table('instant_rounds')->where('player_key', $pk)->whereNull('seen_at')->whereIn('status', ['settled', 'void'])->update(['seen_at' => $this->now()]);    // the player moved on

        $id = DB::table('instant_rounds')->insertGetId(['game_id' => self::GAME, 'player_key' => $pk, 'client_id' => $s->client_id, 'stake' => $stake, 'currency' => $s->currency, 'brand_id' => $s->brand_id,
            'paytable_id' => $pt->id, 'paytable_version' => $pt->version, 'status' => 'debiting', 'request_id' => $requestId, 'created_at' => $this->now()]);
        $ref = 'bp:'.$id;
        $txId = $ref.':bet';
        $meta = ['kind' => 'bet', 'roundId' => $ref, 'gameId' => self::GAME, 'roundRef' => $ref, 'currency' => $s->currency, 'brandId' => $s->brand_id];
        try {
            $res = $this->gateway->debit($pk, $stake, $txId, $meta);
        } catch (GameError $e) {
            if ($e->errorCode === 'WALLET_UNAVAILABLE') {      // the outcome is unknown: the gateway queued a rollback; this play is void
                $this->void($id, 'debit_unknown');
            } else {                                           // a refusal is an answer: nothing was charged and there is nothing to keep
                DB::table('instant_rounds')->where('id', $id)->delete();
            }
            throw $e;
        }

        DB::transaction(function () use ($id, $ref, $txId, $s, $stake, $pt, $res, $client) {
            $seed = $this->seeds->active($s->player_key);
            $nonce = $this->seeds->take($seed);
            $holes = Draw::holes($this->seeds->serverSeed($seed), $seed->client_seed, $nonce);
            $e = Evaluator::evaluate($pt->card, $holes);
            $multiple = $pt->multiple($e['lit']);
            $payout = $pt->payout($stake, $e['lit']);
            $t = $this->now();
            DB::table('instant_rounds')->where('id', $id)->update(['seed_id' => $seed->id, 'nonce' => $nonce, 'holes' => json_encode($holes), 'best_lit' => $e['lit'], 'best_line' => $e['line'],
                'multiple' => $multiple, 'payout' => $payout, 'status' => 'settled', 'settled_at' => $t]);
            $this->journal->log(['e' => 'bp.play', 'roundId' => $ref, 'playerId' => $s->player_key, 'stake' => $stake, 'currency' => $s->currency, 'txId' => $txId, 'seedId' => (int) $seed->id,
                'commit' => $seed->commit, 'clientSeed' => $seed->client_seed, 'nonce' => $nonce, 'paytable' => $pt->id], self::GAME);
            $this->journal->log(['e' => 'bp.settled', 'roundId' => $ref, 'playerId' => $s->player_key, 'holes' => $holes, 'bestLit' => $e['lit'], 'bestLine' => $e['line'], 'multiple' => $multiple, 'payout' => $payout], self::GAME);
            if ($payout > 0) {
                $this->gateway->queueCredit($ref.':win', $s->player_key, $payout, null, 'win', array_filter(['currency' => $s->currency, 'brandId' => $s->brand_id]), self::GAME, $ref);
            }
            DB::table('game_sessions')->where('key', $s->key)->update(['balance' => $res['balance'] ?? null, 's_staked' => DB::raw('s_staked + '.(int) $stake), 's_paid' => DB::raw('s_paid + '.(int) $payout)]);
            $this->announce($s, $client, $id, $ref, $stake, $payout, $multiple, $holes, $e['lit'], $pt, $nonce);
        });
        $round = DB::table('instant_rounds')->where('id', $id)->first();
        if ((int) $round->payout > 0) {
            $this->gateway->flushCredits($ref.':win');         // the win is sent to the platform now; if it does not answer it stays queued and is retried
        }

        return $this->answer($round, DB::table('game_sessions')->where('key', $s->key)->first(), false);
    }

    /** the events to the platform: a big win always, a round.settled for every play only when the client asked for them */
    private function announce(object $s, array $client, int $id, string $ref, int $stake, int $payout, int $multiple, array $holes, int $lit, Paytable $pt, int $nonce): void
    {
        $raw = PlayerKey::split($s->player_key)[1];
        $common = ['roundId' => $ref, 'gameId' => self::GAME, 'playerId' => $raw, 'brandId' => $s->brand_id, 'currency' => $s->currency, 'stake' => $stake, 'payout' => $payout, 'multiple' => $multiple, 'paytable' => $pt->id];
        if ($payout > 0 && $payout >= ($client['bigWinMin'] ?? $this->bigWinMin)) {
            $this->webhooks->emit('big.win', 'win:'.$ref, $common + ['bestLit' => $lit], $s->client_id, self::GAME);
        }
        if (! empty($client['gameSettings'][self::GAME]['roundWebhooks'])) {
            $this->webhooks->emit('round.settled', $ref, $common + ['holes' => $holes, 'bestLit' => $lit, 'nonce' => $nonce], $s->client_id, self::GAME);
        }
    }

    /** a play whose debit has an unknown outcome (or never finished): void, with the reason in the ledger */
    private function void(int $id, string $reason): void
    {
        DB::table('instant_rounds')->where('id', $id)->where('status', 'debiting')->update(['status' => 'void', 'settled_at' => $this->now()]);
        $r = DB::table('instant_rounds')->where('id', $id)->first();
        $this->journal->log(['e' => 'bp.void', 'roundId' => 'bp:'.$id, 'playerId' => $r->player_key, 'stake' => (int) $r->stake, 'reason' => $reason], self::GAME);
    }

    /** the answer to a play (or to a repeated play) */
    private function answer(object $r, ?object $session, bool $repeat): array
    {
        if ($r->status === 'void') {
            throw new GameError(409, 'ROUND_VOID');
        }
        if ($r->status === 'debiting') {
            throw new GameError(409, 'ROUND_IN_PROGRESS');
        }
        $session ??= DB::table('game_sessions')->where('player_key', $r->player_key)->where('game_id', self::GAME)->orderByDesc('created_at')->first();

        return ['round' => $this->roundView($r), 'balance' => $session && $session->balance !== null ? (int) $session->balance : null, 'repeat' => $repeat];
    }

    /* ---------- reading rounds ---------- */

    public function roundView(object $r): array
    {
        $holes = $r->holes === null ? null : json_decode($r->holes, true);
        $ref = 'bp:'.$r->id;

        return ['id' => (int) $r->id, 'ref' => $ref, 'status' => $r->status, 'stake' => (int) $r->stake, 'currency' => $r->currency, 'paytable' => ['id' => $r->paytable_id, 'version' => (int) $r->paytable_version],
            'holes' => $holes, 'bestLit' => $r->best_lit === null ? null : (int) $r->best_lit, 'bestLine' => $r->best_line === null ? null : (int) $r->best_line,
            'bestLineName' => $r->best_line === null ? null : Card::lineName((int) $r->best_line), 'multiple' => $r->multiple === null ? null : (int) $r->multiple, 'payout' => (int) $r->payout, 'nonce' => $r->nonce === null ? null : (int) $r->nonce,
            'seedId' => $r->seed_id === null ? null : (int) $r->seed_id, 'createdAt' => (int) $r->created_at, 'settledAt' => $r->settled_at === null ? null : (int) $r->settled_at, 'seen' => $r->seen_at !== null,
            'creditPending' => (int) $r->payout > 0 && DB::table('pending_ops')->where('tx_id', $ref.':win')->exists()];
    }

    private function own(object $s, int $id): object
    {
        $r = DB::table('instant_rounds')->where('id', $id)->where('player_key', $s->player_key)->first();
        if (! $r) {
            throw new GameError(404, 'NOT_FOUND');
        }

        return $r;
    }

    public function round(string $sessionId, int $id): array
    {
        return ['round' => $this->roundView($this->own($this->session($sessionId), $id))];
    }

    public function history(string $sessionId, mixed $limit = 50): array
    {
        $s = $this->session($sessionId);
        $n = max(1, min(100, (int) $limit ?: 50));

        return ['rounds' => DB::table('instant_rounds')->where('player_key', $s->player_key)->whereIn('status', ['settled', 'void'])->orderByDesc('id')->limit($n)->get()->map(fn ($r) => $this->roundView($r))->all()];
    }

    /** the player's page says it has shown the result (the animation finished): /state stops reporting the round as unseen */
    public function markSeen(string $sessionId, int $id): array
    {
        $s = $this->session($sessionId);
        $this->own($s, $id);
        DB::table('instant_rounds')->where('id', $id)->whereNull('seen_at')->update(['seen_at' => $this->now()]);

        return [];
    }

    /* ---------- fairness ---------- */

    public function rotateSeed(string $sessionId, mixed $clientSeed): array
    {
        $s = $this->session($sessionId);
        if ($clientSeed !== null && ! is_string($clientSeed)) {
            throw new GameError(400, 'BAD_CLIENT_SEED');
        }
        try {
            return Cache::lock('horse-player:'.$s->player_key, 20)->block((int) ($this->settings['lock_wait_seconds'] ?? 5), fn () => $this->seeds->rotate($s->player_key, $clientSeed === '' ? null : $clientSeed));
        } catch (LockTimeoutException) {
            throw new GameError(429, 'TOO_MANY_REQUESTS');
        }
    }

    /** what is needed to re-run a play: available once the seed pair it was drawn under has been revealed */
    public function proof(string $sessionId, int $id): array
    {
        $r = $this->own($this->session($sessionId), $id);
        if ($r->status !== 'settled') {
            throw new GameError(409, 'NOT_SETTLED');
        }
        $seed = $this->seeds->revealed((int) $r->seed_id);
        if (! $seed) {
            throw new GameError(409, 'SEED_NOT_REVEALED');
        }
        $pt = Paytables::get((int) $r->paytable_version);

        return ['round' => $this->roundView($r), 'proof' => ['serverSeed' => $seed['serverSeed'], 'commit' => $seed['commit'], 'clientSeed' => $seed['clientSeed'], 'nonce' => (int) $r->nonce, 'holes' => json_decode($r->holes, true),
            'paytable' => ['id' => $pt->id, 'version' => $pt->version, 'pays' => $pt->pays, 'card' => $pt->card],
            'verify' => 'php bin/bingo-verify.php --server-seed '.$seed['serverSeed'].' --client-seed '.$seed['clientSeed'].' --nonce '.(int) $r->nonce.' --version '.$pt->version.' --stake '.(int) $r->stake.' --commit '.$seed['commit']]];
    }

    /* ---------- recovery ---------- */

    /**
     * Plays that have waited for their debit for too long (the process died between the debit and the draw): the debit may have been taken, so it is rolled back
     * (the wallet is idempotent and refuses a late debit with that id) and the play is void. Run by the round loop every few seconds.
     *
     * @return int the number of plays cancelled
     */
    public function recoverStuck(): int
    {
        if (! Cache::remember('horse:has-instant-rounds', 300, fn () => Schema::hasTable('instant_rounds'))) {
            return 0;
        }
        $n = 0;
        foreach (DB::table('instant_rounds')->where('status', 'debiting')->where('created_at', '<', $this->now() - (int) $this->settings['stuck_after_ms'])->orderBy('id')->limit(50)->get() as $r) {
            $lock = Cache::lock('horse-player:'.$r->player_key, 20);
            if (! $lock->get()) {                              // the player is in the middle of something: next time
                continue;
            }
            try {
                $now = DB::table('instant_rounds')->where('id', $r->id)->first();
                if ($now && $now->status === 'debiting') {
                    $ref = 'bp:'.$r->id;
                    $this->gateway->queueRollback($ref.':bet', $r->player_key, (int) $r->stake, ['kind' => 'bet', 'roundId' => $ref, 'gameId' => self::GAME, 'roundRef' => $ref, 'currency' => $r->currency, 'brandId' => $r->brand_id]);
                    $this->void((int) $r->id, 'stuck');
                    $n++;
                }
            } finally {
                $lock->release();
            }
        }

        return $n;
    }
}
