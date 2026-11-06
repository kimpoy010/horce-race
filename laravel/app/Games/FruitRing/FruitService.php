<?php

namespace App\Games\FruitRing;

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
 * Fruit Game: the play flow of an instant game with a double-up.
 *
 *   SPIN    Requested -> the wallet takes the stake, credits x credit value (fr:<id>:bet) -> Debited -> the spin is drawn from the player's seed pair (one nonce) and paid:
 *           no win -> Settled; a win -> status "open": the win is HELD, the player may double it (Small/Big, a fair 50/50, up to 3 times in a row) or collect it
 *   DOUBLE  each one draws the next nonce of the pair: right = the held win doubles, wrong = it is lost (Settled with 0); the 3rd right answer collects by itself
 *   COLLECT / a new spin / an idle player (after open_after_ms, the round loop) -> Settled: the held win is credited to the wallet once (fr:<id>:win, idempotent)
 *
 * The wallet sees one debit and, at the end, one credit: a held win is not money in anybody's wallet yet, so a double-up needs no wallet call. The draws are saved with the
 * state of the round in one transaction; one money action per player at a time (the horse race's lock). A repeated requestId (spin) or step number (double) returns what
 * exists and never draws or pays twice. While a win is held the seed pair cannot be revealed (the outcome of the next double would be known). Nothing here lets an operator,
 * a staff role or an API call choose or influence a result.
 */
final class FruitService
{
    public const GAME = Rules::ID;

    private const REQUEST_ID_RE = '/^[A-Za-z0-9_-]{8,64}$/';

    /** @param Closure(): int $now  @param array $settings config games.settings.fruit-ring */
    public function __construct(private Sessions $sessions, private WalletGateway $gateway, private Limits $limits, private ClientDirectory $clients, private Journal $journal,
        private WebhookQueue $webhooks, private SeedService $seeds, private Games $games, private Closure $now, private array $settings, private int $bigWinMin) {}

    private static ?bool $figures = null;

    /** whether the columns of 2026_01_10_000100 exist (code is often deployed before `php artisan migrate`; until then the game plays, the extra figures are simply not kept) */
    private static function hasFigures(): bool
    {
        return self::$figures ??= Schema::hasColumn('instant_rounds', 'spin_win');
    }

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

    /** the limits on the whole stake of a spin (minor units) */
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
        try {
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
        $out = ['currency' => $s->currency, 'decimals' => (int) $s->decimals, 'balance' => $base['balance'], 'limits' => $this->limitsOf($s) + ['maxCreditsPerSymbol' => $this->maxPerSymbol(), 'maxCredits' => $this->maxCredits()],
            'responsible' => $base['responsible'], 'paytable' => Rules::paytable() + ['rtp' => '89.98'], 'seed' => $this->seeds->view($seed), 'minIntervalMs' => (int) $this->settings['min_interval_ms']];
        if ($withRound) {
            $last = DB::table('instant_rounds')->where('player_key', $s->player_key)->where('game_id', self::GAME)->orderByDesc('id')->first();
            $out['last'] = $last ? $this->roundView($last) : null;
            $out['open'] = $last && $last->status === 'open';
            $out['unseen'] = $last && $last->seen_at === null && in_array($last->status, ['settled', 'void'], true);
            $out['unfinished'] = $last && $last->status === 'debiting';
        }

        return $out;
    }

    private function maxPerSymbol(): int
    {
        return (int) ($this->settings['max_credits_per_symbol'] ?? 20);
    }

    private function maxCredits(): int
    {
        return (int) ($this->settings['max_credits'] ?? 100);
    }

    /* ---------- a spin ---------- */

    /** @param mixed $bets credits on each symbol, e.g. {"apple": 2, "bar": 1}; $credit the value of one credit in minor units */
    public function play(string $sessionId, mixed $bets, mixed $credit, mixed $requestId): array
    {
        $s = $this->session($sessionId);
        if (! is_string($requestId) || ! preg_match(self::REQUEST_ID_RE, $requestId) || ! is_int($credit) || $credit < 1 || ! is_array($bets)) {
            throw new GameError(400, 'BAD_REQUEST');
        }
        $clean = [];
        foreach ($bets as $sym => $n) {
            if (! in_array($sym, Rules::SYMBOLS, true) || ! is_int($n) || $n < 0 || $n > $this->maxPerSymbol()) {
                throw new GameError(400, 'BAD_BET');
            }
            if ($n > 0) {
                $clean[$sym] = $n;
            }
        }
        try {
            return Cache::lock('horse-player:'.$s->player_key, 20)->block((int) ($this->settings['lock_wait_seconds'] ?? 5), fn () => $this->playLocked($s, $clean, $credit, $requestId));
        } catch (LockTimeoutException) {
            throw new GameError(429, 'TOO_MANY_REQUESTS');
        }
    }

    private function playLocked(object $s, array $bets, int $credit, string $requestId): array
    {
        $pk = $s->player_key;
        $again = DB::table('instant_rounds')->where('player_key', $pk)->where('request_id', $requestId)->first();
        if ($again) {
            return $this->answer($again, $s, true);
        }
        $credits = array_sum($bets);
        $stake = $credits * $credit;
        $lim = $this->limitsOf($s);
        if ($credits < 1 || $credits > $this->maxCredits() || $stake < $lim['minBet'] || $stake > $lim['maxBet']) {
            throw new GameError(400, 'BAD_BET');
        }
        $this->collectOpen($s);                                          // a win still held from the last spin is collected first
        $day = $this->limits->today($pk);
        if ($lim['dailyLossLimit'] > 0 && $day['staked'] - $day['paid'] + $stake > $lim['dailyLossLimit']) {
            throw new GameError(400, 'DAILY_LOSS_LIMIT');
        }
        $lastAt = DB::table('instant_rounds')->where('player_key', $pk)->where('game_id', self::GAME)->max('created_at');
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
        $ref = 'fr:'.$id;
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
        $settledNow = false;
        DB::transaction(function () use ($id, $ref, $txId, $s, $stake, $res, $bets, $credit, &$settledNow) {
            $seed = $this->seeds->active($s->player_key);
            $nonce = $this->seeds->take($seed);
            $rounds = Draw::spin($this->seeds->serverSeed($seed), $seed->client_seed, $nonce);
            $payouts = Evaluator::payouts($rounds);
            $win = Evaluator::pay($rounds, $bets) * $credit;
            $fig = Par::spinFigures($bets);
            $details = ['bets' => $bets, 'credit' => $credit, 'rounds' => $rounds, 'payouts' => $payouts, 'spinWin' => $win, 'held' => $win, 'doubles' => [], 'spinNonce' => $nonce];
            $this->journal->log(['e' => 'fr.play', 'roundId' => $ref, 'playerId' => $s->player_key, 'stake' => $stake, 'currency' => $s->currency, 'txId' => $txId, 'seedId' => (int) $seed->id,
                'commit' => $seed->commit, 'clientSeed' => $seed->client_seed, 'nonce' => $nonce, 'bets' => $bets, 'credit' => $credit, 'rounds' => $rounds, 'win' => $win, 'paytable' => Rules::PAYTABLE_ID], self::GAME);
            DB::table('instant_rounds')->where('id', $id)->update(['seed_id' => $seed->id, 'nonce' => $nonce, 'holes' => json_encode($rounds), 'details' => json_encode($details),
                'status' => $win > 0 ? 'open' : 'settled', 'settled_at' => $win > 0 ? null : $this->now(), 'payout' => 0, 'multiple' => null]
                + (self::hasFigures() ? ['spin_win' => $win, 'exp_win' => $fig['expected'] * $credit, 'var_win' => $fig['variance'] * $credit * $credit, 'doubles' => 0, 'doubles_won' => 0] : []));
            DB::table('game_sessions')->where('key', $s->key)->update(['balance' => $res['balance'] ?? null, 's_staked' => DB::raw('s_staked + '.(int) $stake)]);
            if ($win === 0) {
                $this->journal->log(['e' => 'fr.settled', 'roundId' => $ref, 'playerId' => $s->player_key, 'payout' => 0, 'doubles' => 0], self::GAME);
                $settledNow = true;
            }
        });
        $round = DB::table('instant_rounds')->where('id', $id)->first();
        if ($settledNow) {
            $this->afterSettled($s, $round);
        }

        return $this->answer($round, DB::table('game_sessions')->where('key', $s->key)->first(), false);
    }

    /* ---------- double-up and collect ---------- */

    /** @param string $side 'small' (1-7) or 'big' (8-14); $step how many double-ups the page has seen so far (a repeated step returns the result that exists) */
    public function double(string $sessionId, int $id, mixed $side, mixed $step, mixed $take = 0): array
    {
        $s = $this->session($sessionId);
        if (! in_array($side, ['small', 'big'], true) || ! is_int($step) || $step < 0 || ! is_int($take) || $take < 0) {
            throw new GameError(400, 'BAD_REQUEST');
        }
        try {
            return Cache::lock('horse-player:'.$s->player_key, 20)->block((int) ($this->settings['lock_wait_seconds'] ?? 5), fn () => $this->doubleLocked($s, $id, $side, $step, $take));
        } catch (LockTimeoutException) {
            throw new GameError(429, 'TOO_MANY_REQUESTS');
        }
    }

    private function doubleLocked(object $s, int $id, string $side, int $step, int $take): array
    {
        $r = $this->own($s, $id);
        $d = json_decode($r->details, true);
        $done = count($d['doubles'] ?? []);
        if ($step < $done) {
            return $this->answer($r, $s, true);                          // this double-up already happened: show it again
        }
        if ($r->status !== 'open' || $step !== $done) {
            throw new GameError(409, 'NOT_OPEN');
        }
        if ($done >= Rules::DOUBLE_MAX || (int) $d['held'] < 1) {
            throw new GameError(409, 'NO_DOUBLE');
        }
        if ($take >= (int) $d['held']) {
            throw new GameError(400, 'BAD_REQUEST');                     // something must stay at stake: the part moved to the balance is smaller than the win
        }
        $seed = DB::table('player_seeds')->where('id', $r->seed_id)->first();
        if (! $seed || $seed->status !== 'active') {
            throw new GameError(409, 'NOT_OPEN');
        }
        $ref = 'fr:'.$id;
        $finished = false;
        $takeTx = null;
        DB::transaction(function () use ($r, $d, $seed, $side, $ref, $s, $take, $done, &$finished, &$takeTx) {
            $nonce = $this->seeds->take($seed);
            $number = Draw::doubleNumber($this->seeds->serverSeed($seed), $seed->client_seed, $nonce);
            $won = Evaluator::doubleWins($number, $side);
            $remain = (int) $d['held'] - $take;                                // the part the player moved to the balance is paid now and not risked
            $d['doubles'][] = ['nonce' => $nonce, 'side' => $side, 'number' => $number, 'won' => $won, 'take' => $take];
            $d['held'] = $won ? $remain * 2 : 0;
            if ($take > 0) {
                $takeTx = $ref.':take'.($done + 1);
                $this->journal->log(['e' => 'fr.take', 'roundId' => $ref, 'playerId' => $s->player_key, 'amount' => $take, 'txId' => $takeTx], self::GAME);
                $this->gateway->queueCredit($takeTx, $r->player_key, $take, null, 'win', array_filter(['currency' => $r->currency, 'brandId' => $r->brand_id]), self::GAME, $ref);
                DB::table('game_sessions')->where('player_key', $r->player_key)->where('game_id', self::GAME)->update(['s_paid' => DB::raw('s_paid + '.$take)]);
            }
            $this->journal->log(['e' => 'fr.double', 'roundId' => $ref, 'playerId' => $s->player_key, 'nonce' => $nonce, 'side' => $side, 'number' => $number, 'won' => $won, 'take' => $take, 'held' => $d['held']], self::GAME);
            DB::table('instant_rounds')->where('id', $r->id)->update(['details' => json_encode($d)]
                + (self::hasFigures() ? ['doubles' => count($d['doubles']), 'doubles_won' => count(array_filter($d['doubles'], fn ($x) => $x['won']))] : []));
            $finished = ! $won || count($d['doubles']) >= Rules::DOUBLE_MAX;
        });
        if ($takeTx !== null) {
            $this->gateway->flushCredits($takeTx);
        }
        $round = DB::table('instant_rounds')->where('id', $id)->first();
        if ($finished) {
            $round = $this->settle($s, $round);                          // lost: nothing left to pay; the third win in a row is collected by itself
        }

        return $this->answer($round, DB::table('game_sessions')->where('key', $s->key)->first(), false);
    }

    public function collect(string $sessionId, int $id): array
    {
        $s = $this->session($sessionId);
        try {
            return Cache::lock('horse-player:'.$s->player_key, 20)->block((int) ($this->settings['lock_wait_seconds'] ?? 5), function () use ($s, $id) {
                $r = $this->own($s, $id);
                if ($r->status === 'open') {
                    $r = $this->settle($s, $r);
                }

                return $this->answer($r, DB::table('game_sessions')->where('key', $s->key)->first(), $r->status === 'settled');
            });
        } catch (LockTimeoutException) {
            throw new GameError(429, 'TOO_MANY_REQUESTS');
        }
    }

    /** collects the open round of the player, if there is one (called with the player's lock held) */
    private function collectOpen(object $s): void
    {
        $open = DB::table('instant_rounds')->where('player_key', $s->player_key)->where('game_id', self::GAME)->where('status', 'open')->get();
        foreach ($open as $r) {
            $this->settle($s, $r);
        }
    }

    /** pays what is held and closes the round; the player's lock is held */
    private function settle(object $s, object $r): object
    {
        $ref = 'fr:'.$r->id;
        $done = DB::transaction(function () use ($r, $s, $ref) {
            $fresh = DB::table('instant_rounds')->where('id', $r->id)->lockForUpdate()->first();
            if ($fresh->status !== 'open') {
                return false;
            }
            $d = json_decode($fresh->details, true);
            $held = (int) $d['held'];
            $payout = $held + self::taken($d);                               // what was moved to the balance on the way, and what is paid now
            DB::table('instant_rounds')->where('id', $r->id)->update(['status' => 'settled', 'payout' => $payout, 'settled_at' => $this->now()]);
            $this->journal->log(['e' => 'fr.settled', 'roundId' => $ref, 'playerId' => $r->player_key, 'payout' => $payout, 'doubles' => count($d['doubles'])], self::GAME);
            if ($held > 0) {
                $this->gateway->queueCredit($ref.':win', $r->player_key, $held, null, 'win', array_filter(['currency' => $r->currency, 'brandId' => $r->brand_id]), self::GAME, $ref);
            }
            DB::table('game_sessions')->where('player_key', $r->player_key)->where('game_id', self::GAME)->update(['s_paid' => DB::raw('s_paid + '.$held)]);

            return true;
        });
        $round = DB::table('instant_rounds')->where('id', $r->id)->first();
        if ($done) {
            $this->afterSettled($s, $round);
        }

        return $round;
    }

    /** the credit to the wallet, and the big-win webhook, once a round is settled */
    private function afterSettled(object $s, object $round): void
    {
        $ref = 'fr:'.$round->id;
        $client = $this->clients->config($round->client_id);
        $d = json_decode($round->details, true);
        if ((int) $round->payout - self::taken($d) > 0) {
            $this->gateway->flushCredits($ref.':win');
        }
        $raw = PlayerKey::split($round->player_key)[1];
        $common = ['roundId' => $ref, 'gameId' => self::GAME, 'playerId' => $raw, 'brandId' => $round->brand_id, 'currency' => $round->currency, 'stake' => (int) $round->stake, 'payout' => (int) $round->payout,
            'spinWin' => $d['spinWin'], 'doubles' => count($d['doubles']), 'paytable' => Rules::PAYTABLE_ID];
        if ((int) $round->payout > 0 && (int) $round->payout >= ($client['bigWinMin'] ?? $this->bigWinMin)) {
            $this->webhooks->emit('big.win', 'win:'.$ref, $common, $round->client_id, self::GAME);
        }
        if (! empty($client['gameSettings'][self::GAME]['roundWebhooks'])) {
            $this->webhooks->emit('round.settled', $ref, $common + ['nonce' => (int) $round->nonce], $round->client_id, self::GAME);
        }
    }

    /** the total moved to the balance before the round ended (by the player's arrows) */
    private static function taken(array $d): int
    {
        return (int) array_sum(array_map(fn ($x) => (int) ($x['take'] ?? 0), $d['doubles'] ?? []));
    }

    private function void(int $id, string $reason): void
    {
        DB::table('instant_rounds')->where('id', $id)->where('status', 'debiting')->update(['status' => 'void', 'settled_at' => $this->now()]);
        $r = DB::table('instant_rounds')->where('id', $id)->first();
        $this->journal->log(['e' => 'fr.void', 'roundId' => 'fr:'.$id, 'playerId' => $r->player_key, 'stake' => (int) $r->stake, 'reason' => $reason], self::GAME);
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
        $ref = 'fr:'.$r->id;
        $open = $r->status === 'open';

        return ['id' => (int) $r->id, 'ref' => $ref, 'status' => $r->status, 'stake' => (int) $r->stake, 'currency' => $r->currency, 'paytable' => ['id' => $r->paytable_id],
            'bets' => $d['bets'] ?? null, 'credit' => $d['credit'] ?? null, 'rounds' => $d['rounds'] ?? null, 'payouts' => $d['payouts'] ?? null, 'spinWin' => $d['spinWin'] ?? 0,
            'held' => $open ? (int) ($d['held'] ?? 0) : 0, 'doubles' => $d['doubles'] ?? [], 'canDouble' => $open && count($d['doubles'] ?? []) < Rules::DOUBLE_MAX && (int) ($d['held'] ?? 0) > 0,
            'payout' => (int) $r->payout, 'nonce' => $r->nonce === null ? null : (int) $r->nonce, 'seedId' => $r->seed_id === null ? null : (int) $r->seed_id,
            'createdAt' => (int) $r->created_at, 'settledAt' => $r->settled_at === null ? null : (int) $r->settled_at, 'seen' => $r->seen_at !== null,
            'taken' => $d ? self::taken($d) : 0,
            'creditPending' => (int) $r->payout > 0 && DB::table('pending_ops')->where('tx_id', 'like', $ref.':%')->exists(),
            'creditPendingAmount' => (int) DB::table('pending_ops')->where('tx_id', 'like', $ref.':%')->where('kind', 'credit')->sum('amount')];
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
            return Cache::lock('horse-player:'.$s->player_key, 20)->block((int) ($this->settings['lock_wait_seconds'] ?? 5), function () use ($s, $clientSeed) {
                if (DB::table('instant_rounds')->where('player_key', $s->player_key)->where('game_id', self::GAME)->whereIn('status', ['open', 'debiting'])->exists()) {
                    throw new GameError(409, 'ROUND_OPEN');             // revealing the seed now would reveal the next double-up
                }

                return $this->seeds->rotate($s->player_key, $clientSeed === '' ? null : $clientSeed);
            });
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
        $d = json_decode($r->details, true);
        $verify = ['spin' => 'php bin/fruit-verify.php --server-seed '.$seed['serverSeed'].' --client-seed '.$seed['clientSeed'].' --nonce '.(int) $r->nonce.' --bets '.implode(',', array_map(fn ($sym) => $d['bets'][$sym] ?? 0, Rules::SYMBOLS)).' --commit '.$seed['commit']];
        foreach ($d['doubles'] as $i => $x) {
            $verify['double'.($i + 1)] = 'php bin/fruit-verify.php --double --server-seed '.$seed['serverSeed'].' --client-seed '.$seed['clientSeed'].' --nonce '.(int) $x['nonce'];
        }

        return ['round' => $this->roundView($r), 'proof' => ['serverSeed' => $seed['serverSeed'], 'commit' => $seed['commit'], 'clientSeed' => $seed['clientSeed'], 'nonce' => (int) $r->nonce,
            'rounds' => $d['rounds'], 'doubles' => $d['doubles'], 'paytable' => Rules::paytable(), 'verify' => $verify]];
    }

    /* ---------- recovery ---------- */

    /** spins that waited for their debit too long are rolled back and void; a win held by a player who went away is collected (run by the round loop) */
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
                    $ref = 'fr:'.$r->id;
                    $this->gateway->queueRollback($ref.':bet', $r->player_key, (int) $r->stake, ['kind' => 'bet', 'roundId' => $ref, 'gameId' => self::GAME, 'roundRef' => $ref, 'currency' => $r->currency, 'brandId' => $r->brand_id]);
                    $this->void((int) $r->id, 'stuck');
                    $n++;
                }
            } finally {
                $lock->release();
            }
        }
        foreach (DB::table('instant_rounds')->where('game_id', self::GAME)->where('status', 'open')->where('created_at', '<', $this->now() - (int) $this->settings['open_after_ms'])->orderBy('id')->limit(50)->get() as $r) {
            $lock = Cache::lock('horse-player:'.$r->player_key, 20);
            if (! $lock->get()) {
                continue;
            }
            try {
                $s = DB::table('game_sessions')->where('player_key', $r->player_key)->where('game_id', self::GAME)->orderByDesc('created_at')->first();
                $fresh = DB::table('instant_rounds')->where('id', $r->id)->first();
                if ($fresh && $fresh->status === 'open' && $s) {
                    $this->settle($s, $fresh);
                    $n++;
                }
            } finally {
                $lock->release();
            }
        }

        return $n;
    }
}
