<?php

namespace App\Games\BingoPinball16;

use App\Game\GameError;
use App\Games\BingoPinball\SeedService;
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
 * Bingo Pinball 16: the play flow of an instant game, the same shape as Bingo Pinball's (docs/bingo/API.md): one play = one request;
 *
 *   Requested -> the wallet takes the stake (b16:<id>:bet) -> Debited -> 16 balls and 5 jackpot numbers are drawn from the player's seed pair -> the best pattern is paid,
 *   the stake's share goes into the jackpot pool (and the whole pool is paid when all five jackpot numbers are lit) -> Settled -> the win is credited (b16:<id>:win)
 *
 * The result is drawn only after the wallet has confirmed the debit and is saved, with the pool change, its ledger lines and the queued credit, in one transaction.
 * One money action per player at a time (the horse race's lock); a repeated requestId returns the round that exists and never debits twice. Nothing here lets an
 * operator, a staff role or an API call choose or influence a result; the plunger is decoration.
 */
final class Bingo16Service
{
    public const GAME = Rules::ID;

    private const REQUEST_ID_RE = '/^[A-Za-z0-9_-]{8,64}$/';

    /** @param Closure(): int $now  @param array $settings config games.settings.bingo-pinball-16 */
    public function __construct(private Sessions $sessions, private WalletGateway $gateway, private Limits $limits, private ClientDirectory $clients, private Journal $journal,
        private WebhookQueue $webhooks, private SeedService $seeds, private JackpotPool $pool, private Games $games, private Closure $now, private array $settings, private int $bigWinMin) {}

    private function now(): int
    {
        return ($this->now)();
    }

    private function assertEnabled(array $client): void
    {
        if (! $this->games->isEnabled($client, self::GAME)) {
            throw new GameError(403, 'GAME_NOT_ENABLED');
        }
    }

    /** exchanges the platform's launch token for a session of this game; the token is not used up while the game is off for the client */
    public function auth(string $token, ?string $clientHint): array
    {
        $this->seeds->assertReady();
        $cid = $this->clients->resolve($clientHint);
        $this->assertEnabled($this->clients->config($cid));
        $out = $this->sessions->auth($token, $cid, self::GAME);

        return ['session' => $out['session'], 'playerId' => $out['playerId'], 'returnUrl' => $out['returnUrl']] + $this->stateOf($this->sessions->find($out['session'], self::GAME), false);
    }

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
        try {                                                  // like the horse race: ask the wallet, keep the last known balance when it does not answer
            $w = $this->clients->walletFor($s->client_id) ?? throw new \RuntimeException('no wallet');
            DB::table('game_sessions')->where('key', $s->key)->update(['balance' => $this->gateway->call(fn () => $w->balance($s->raw_id), 'balance', $s->client_id)]);
        } catch (\Throwable $e) {
            // keep the stored balance
        }

        return $this->stateOf($this->sessions->find($sessionId, self::GAME) ?? $s, true);
    }

    private function stateOf(object $s, bool $withRound): array
    {
        $base = $this->sessions->view($s);
        $seed = $this->seeds->active($s->player_key);
        $out = ['currency' => $s->currency, 'decimals' => (int) $s->decimals, 'balance' => $base['balance'], 'limits' => $this->limitsOf($s), 'responsible' => $base['responsible'],
            'paytable' => Rules::paytable() + ['rtp' => '90.00', 'maxMultiple' => 30], 'jackpot' => $this->pool->view($s->currency), 'seed' => $this->seeds->view($seed),
            'minIntervalMs' => (int) $this->settings['min_interval_ms']];
        if ($withRound) {
            $last = DB::table('instant_rounds')->where('player_key', $s->player_key)->where('game_id', self::GAME)->orderByDesc('id')->first();
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
        try {
            return Cache::lock('horse-player:'.$s->player_key, 20)->block((int) ($this->settings['lock_wait_seconds'] ?? 5), fn () => $this->playLocked($s, $stake, $requestId));
        } catch (LockTimeoutException) {
            throw new GameError(429, 'TOO_MANY_REQUESTS');
        }
    }

    private function playLocked(object $s, int $stake, string $requestId): array
    {
        $pk = $s->player_key;
        $again = DB::table('instant_rounds')->where('player_key', $pk)->where('request_id', $requestId)->first();
        if ($again) {
            return $this->answer($again, $s, true);
        }
        $client = $this->clients->config($s->client_id);
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
        if ($this->seeds->needsRotation($seed)) {
            $this->seeds->rotate($pk);
        }
        DB::table('instant_rounds')->where('player_key', $pk)->where('game_id', self::GAME)->whereNull('seen_at')->whereIn('status', ['settled', 'void'])->update(['seen_at' => $this->now()]);

        $id = DB::table('instant_rounds')->insertGetId(['game_id' => self::GAME, 'player_key' => $pk, 'client_id' => $s->client_id, 'stake' => $stake, 'currency' => $s->currency, 'brand_id' => $s->brand_id,
            'paytable_id' => Rules::PAYTABLE_ID, 'paytable_version' => 1, 'status' => 'debiting', 'request_id' => $requestId, 'created_at' => $this->now()]);
        $ref = 'b16:'.$id;
        $txId = $ref.':bet';
        $meta = ['kind' => 'bet', 'roundId' => $ref, 'gameId' => self::GAME, 'roundRef' => $ref, 'currency' => $s->currency, 'brandId' => $s->brand_id];
        try {
            $res = $this->gateway->debit($pk, $stake, $txId, $meta);
        } catch (GameError $e) {
            if ($e->errorCode === 'WALLET_UNAVAILABLE') {
                $this->void($id, 'debit_unknown');
            } else {
                DB::table('instant_rounds')->where('id', $id)->delete();
            }
            throw $e;
        }

        DB::transaction(function () use ($id, $ref, $txId, $s, $stake, $res, $client) {
            $seed = $this->seeds->active($s->player_key);
            $nonce = $this->seeds->take($seed);
            $d = Draw::play($this->seeds->serverSeed($seed), $seed->client_seed, $nonce);
            $e = Evaluator::evaluate($d['balls'], $d['jackpotNumbers']);
            $patternPay = $stake * $e['multiple'];
            $pool = $this->pool->settle($ref, $stake, $s->currency, $e['jackpot']);          // locks the pool row; the whole pool when all five numbers are lit
            $payout = $patternPay + $pool['paid'];
            $t = $this->now();
            $details = ['balls' => $d['balls'], 'jackpotNumbers' => $d['jackpotNumbers'], 'lit' => $e['lit'], 'pattern' => $e['pattern'], 'lines' => $e['lines'], 'jackpotLit' => $e['jackpotLit'],
                'jackpot' => $e['jackpot'], 'patternPay' => $patternPay, 'contribution' => $pool['contribution'], 'poolBefore' => $pool['poolBefore'], 'poolAfter' => $pool['poolAfter']];
            DB::table('instant_rounds')->where('id', $id)->update(['seed_id' => $seed->id, 'nonce' => $nonce, 'holes' => json_encode($d['balls']), 'best_lit' => count($e['lit']), 'multiple' => $e['multiple'],
                'payout' => $payout, 'jackpot_paid' => $pool['paid'], 'details' => json_encode($details), 'status' => 'settled', 'settled_at' => $t]);
            $this->journal->log(['e' => 'b16.play', 'roundId' => $ref, 'playerId' => $s->player_key, 'stake' => $stake, 'currency' => $s->currency, 'txId' => $txId, 'seedId' => (int) $seed->id,
                'commit' => $seed->commit, 'clientSeed' => $seed->client_seed, 'nonce' => $nonce, 'paytable' => Rules::PAYTABLE_ID], self::GAME);
            $this->journal->log(['e' => 'b16.settled', 'roundId' => $ref, 'playerId' => $s->player_key, 'balls' => $d['balls'], 'jackpotNumbers' => $d['jackpotNumbers'], 'pattern' => $e['pattern'], 'multiple' => $e['multiple'],
                'patternPay' => $patternPay, 'jackpotPaid' => $pool['paid'], 'payout' => $payout], self::GAME);
            if ($payout > 0) {
                $this->gateway->queueCredit($ref.':win', $s->player_key, $payout, null, 'win', array_filter(['currency' => $s->currency, 'brandId' => $s->brand_id]), self::GAME, $ref);
            }
            DB::table('game_sessions')->where('key', $s->key)->update(['balance' => $res['balance'] ?? null, 's_staked' => DB::raw('s_staked + '.(int) $stake), 's_paid' => DB::raw('s_paid + '.(int) $payout)]);
            $this->announce($s, $client, $ref, $stake, $payout, $e, $pool['paid'], $nonce);
        });
        $round = DB::table('instant_rounds')->where('id', $id)->first();
        if ((int) $round->payout > 0) {
            $this->gateway->flushCredits($ref.':win');
        }

        return $this->answer($round, DB::table('game_sessions')->where('key', $s->key)->first(), false);
    }

    /** a big win (and every jackpot) always, a round.settled for every play only when the client asked for them */
    private function announce(object $s, array $client, string $ref, int $stake, int $payout, array $e, int $jackpotPaid, int $nonce): void
    {
        $raw = PlayerKey::split($s->player_key)[1];
        $common = ['roundId' => $ref, 'gameId' => self::GAME, 'playerId' => $raw, 'brandId' => $s->brand_id, 'currency' => $s->currency, 'stake' => $stake, 'payout' => $payout, 'multiple' => $e['multiple'],
            'pattern' => $e['pattern'], 'jackpotPaid' => $jackpotPaid, 'paytable' => Rules::PAYTABLE_ID];
        if ($payout > 0 && ($jackpotPaid > 0 || $payout >= ($client['bigWinMin'] ?? $this->bigWinMin))) {
            $this->webhooks->emit('big.win', 'win:'.$ref, $common, $s->client_id, self::GAME);
        }
        if (! empty($client['gameSettings'][self::GAME]['roundWebhooks'])) {
            $this->webhooks->emit('round.settled', $ref, $common + ['balls' => $e['lit'], 'nonce' => $nonce], $s->client_id, self::GAME);
        }
    }

    private function void(int $id, string $reason): void
    {
        DB::table('instant_rounds')->where('id', $id)->where('status', 'debiting')->update(['status' => 'void', 'settled_at' => $this->now()]);
        $r = DB::table('instant_rounds')->where('id', $id)->first();
        $this->journal->log(['e' => 'b16.void', 'roundId' => 'b16:'.$id, 'playerId' => $r->player_key, 'stake' => (int) $r->stake, 'reason' => $reason], self::GAME);
    }

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
        $d = $r->details === null ? null : json_decode($r->details, true);
        $ref = 'b16:'.$r->id;
        $pattern = $d['pattern'] ?? null;

        return ['id' => (int) $r->id, 'ref' => $ref, 'status' => $r->status, 'stake' => (int) $r->stake, 'currency' => $r->currency, 'paytable' => ['id' => $r->paytable_id],
            'balls' => $d['balls'] ?? null, 'jackpotNumbers' => $d['jackpotNumbers'] ?? null, 'lit' => $d['lit'] ?? null, 'pattern' => $pattern, 'patternName' => $pattern ? Rules::PATTERNS[$pattern][0] : null,
            'lines' => $d['lines'] ?? null, 'multiple' => $r->multiple === null ? null : (int) $r->multiple, 'jackpotLit' => $d['jackpotLit'] ?? null, 'jackpot' => $d['jackpot'] ?? false,
            'patternPay' => $d['patternPay'] ?? 0, 'jackpotPaid' => (int) $r->jackpot_paid, 'payout' => (int) $r->payout, 'nonce' => $r->nonce === null ? null : (int) $r->nonce,
            'seedId' => $r->seed_id === null ? null : (int) $r->seed_id, 'createdAt' => (int) $r->created_at, 'settledAt' => $r->settled_at === null ? null : (int) $r->settled_at, 'seen' => $r->seen_at !== null,
            'creditPending' => (int) $r->payout > 0 && DB::table('pending_ops')->where('tx_id', $ref.':win')->exists()];
    }

    private function own(object $s, int $id): object
    {
        $r = DB::table('instant_rounds')->where('id', $id)->where('game_id', self::GAME)->where('player_key', $s->player_key)->first();
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

        return ['rounds' => DB::table('instant_rounds')->where('player_key', $s->player_key)->where('game_id', self::GAME)->whereIn('status', ['settled', 'void'])->orderByDesc('id')->limit($n)->get()
            ->map(fn ($r) => $this->roundView($r))->all()];
    }

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

        return ['round' => $this->roundView($r), 'proof' => ['serverSeed' => $seed['serverSeed'], 'commit' => $seed['commit'], 'clientSeed' => $seed['clientSeed'], 'nonce' => (int) $r->nonce,
            'balls' => json_decode($r->details, true)['balls'], 'jackpotNumbers' => json_decode($r->details, true)['jackpotNumbers'], 'paytable' => Rules::paytable(),
            'verify' => 'php bin/bingo16-verify.php --server-seed '.$seed['serverSeed'].' --client-seed '.$seed['clientSeed'].' --nonce '.(int) $r->nonce.' --stake '.(int) $r->stake.' --commit '.$seed['commit']]];
    }

    /* ---------- recovery ---------- */

    /** plays that waited for their debit too long: the debit is rolled back and the play is void (run by the round loop) */
    public function recoverStuck(): int
    {
        if (! Cache::remember('horse:has-instant-rounds', 300, fn () => Schema::hasTable('instant_rounds'))) {
            return 0;
        }
        $n = 0;
        foreach (DB::table('instant_rounds')->where('game_id', self::GAME)->where('status', 'debiting')->where('created_at', '<', $this->now() - (int) $this->settings['stuck_after_ms'])->orderBy('id')->limit(50)->get() as $r) {
            $lock = Cache::lock('horse-player:'.$r->player_key, 20);
            if (! $lock->get()) {
                continue;
            }
            try {
                $now = DB::table('instant_rounds')->where('id', $r->id)->first();
                if ($now && $now->status === 'debiting') {
                    $ref = 'b16:'.$r->id;
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
