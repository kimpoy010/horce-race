<?php

namespace App\Game;

use App\Game\Wallet\Wallet;
use App\Game\Wallet\WalletException;
use Closure;
use Illuminate\Contracts\Cache\LockTimeoutException;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\RateLimiter;

/**
 * Live game engine (port of server/engine.js): continuous rounds, bets, draw, settlement and the audit ledger.
 *
 *   BETTING (bet_ms) -> draw at bet close -> COUNTDOWN -> RACE -> RESULTS (settlement at the end of the race)
 *
 * Fixed odds per pair: a winning bet pays stake x odds (stake included). The 15 odds values are shuffled over the pairs every
 * race (from the round seed); each pair is drawn with probability proportional to 1/odds of that race (Odds::buildForRtp).
 * Money is integer minor units; payouts round down.
 *
 * The Node server keeps the round in memory of one long-running process. Here the state lives in the database (rounds, bets,
 * game_sessions, pending_ops), so web requests (any number of PHP workers) and the daemon (`php artisan game:run`, the only
 * process that moves rounds forward) share it. tick() is what the daemon calls every 250 ms.
 */
final class Engine
{
    private const PLAYER_ID_RE = '/^[A-Za-z0-9_.@-]{1,64}$/';

    private array $table;          // the base odds

    private array $values;         // the 15 odds values, sorted

    public function __construct(private Wallet $wallet, private Ledger $ledger, private array $cfg, private ?Closure $clock = null)
    {
        $this->table = Odds::build($cfg['odds'] ?? null);
        $this->values = array_map(fn ($c) => $this->table['odds'][$c], Odds::combos());
        sort($this->values);
        Odds::buildForRtp($this->table['odds'], $this->rtp());       // throws if the configured RTP is out of range
    }

    public function now(): int
    {
        return $this->clock ? ($this->clock)() : (int) floor(microtime(true) * 1000);
    }

    public function cfg(string $k): mixed
    {
        return $this->cfg[$k];
    }

    /* ---------- settings ---------- */

    public function rtp(): float
    {
        $v = DB::table('settings')->where('key', 'rtp')->value('value');
        if ($v !== null) {
            $x = (float) $v;
            if ($x >= Odds::MIN_RTP && $x <= Odds::MAX_RTP) {
                return $x;
            }
        }

        return (float) $this->cfg['rtp'];
    }

    /** the RTP applies to rounds opened from now on */
    public function setRtp(float|int|string $v, string $who = 'controller'): array
    {
        $v = (float) $v;
        if ($v > 1) {
            $v /= 100;
        }
        if (! ($v >= Odds::MIN_RTP - 1e-9 && $v <= Odds::MAX_RTP + 1e-9)) {
            throw new GameError(400, 'RTP_OUT_OF_RANGE');
        }
        $v = round($v * 10000) / 10000;
        $was = $this->rtp();
        $cur = $this->current();
        DB::table('settings')->updateOrInsert(['key' => 'rtp'], ['value' => (string) $v]);
        $this->log(['e' => 'rtp_set', 'from' => $was, 'to' => $v, 'who' => $who, 'appliesFromRace' => $cur ? $cur->race_no + 1 : 1]);

        return ['ok' => true, 'rtp' => $v, 'appliesFromRace' => $cur ? $cur->race_no + 1 : 1, 'currentRaceRtp' => $cur ? (float) $cur->rtp : null];
    }

    public function previewRtp(float|int|string $v): array
    {
        $v = (float) $v;
        if ($v > 1) {
            $v /= 100;
        }
        if (! ($v >= Odds::MIN_RTP - 1e-9 && $v <= Odds::MAX_RTP + 1e-9)) {
            throw new GameError(400, 'RTP_OUT_OF_RANGE');
        }
        $t = Odds::buildForRtp($this->table['odds'], $v);
        $rows = [];
        foreach ($this->values as $o) {
            $c = collect(Odds::combos())->first(fn ($x) => $t['odds'][$x] == $o);
            $rows[] = ['odds' => $o, 'probability' => $t['prob'][$c], 'rtp' => $t['rtpBy'][$c], 'cheap' => in_array($c, $t['cheap'], true)];
        }

        return ['ok' => true, 'rtp' => $v, 'uniformRtp' => $t['uniform'], 'bestRtp' => $t['bestRtp'], 'cheapRtp' => $t['cheapRtp'], 'evenSpreadRtp' => $t['evenSpread'], 'rows' => $rows];
    }

    public static function payoutFor(int $stake, float|int $odds): int
    {
        return intdiv($stake * (int) floor($odds * 1000 + 0.5), 1000);
    }

    /* ---------- ledger ---------- */

    public function log(array $ev): void
    {
        $ev['t'] = $this->now();
        $this->ledger->append($ev);
    }

    public function ledger(): Ledger
    {
        return $this->ledger;
    }

    /* ---------- rounds ---------- */

    public function current(): ?object
    {
        return DB::table('rounds')->orderByDesc('race_no')->first();
    }

    private function odds(object $r): array
    {
        return json_decode($r->odds, true);
    }

    private function tableOf(object $r): array
    {
        return Odds::buildForRtp($this->odds($r), (float) $r->rtp);
    }

    public function open(): object
    {
        $seed = Rng::newSeed();
        $t = $this->now();
        $raceNo = (int) (DB::table('rounds')->max('race_no') ?? 0) + 1;
        $odds = ($this->cfg['shuffle_odds'] ?? true) ? Rng::oddsLayout($seed, $raceNo, $this->values) : $this->table['odds'];
        $rtp = $this->rtp();
        Odds::buildForRtp($odds, $rtp);
        $commit = Rng::commitOf($seed);
        $close = $t + $this->cfg['bet_ms'];
        DB::transaction(function () use ($raceNo, $seed, $commit, $odds, $rtp, $t, $close) {
            DB::table('rounds')->insert(['race_no' => $raceNo, 'seed' => $seed, 'commit' => $commit, 'odds' => json_encode($odds), 'rtp' => $rtp,
                'open_at' => $t, 'bet_close_at' => $close, 'status' => 'betting']);
            $this->log(['e' => 'open', 'raceNo' => $raceNo, 'seed' => $seed, 'commit' => $commit, 'odds' => $odds, 'rtp' => $rtp, 'openAt' => $t, 'betCloseAt' => $close]);
        });

        return $this->current();
    }

    private function drawNow(object $r): void
    {
        $o = Rng::draw($r->seed, $r->race_no, $this->tableOf($r)['weights']);
        $start = $this->now() + $this->cfg['countdown_ms'];
        DB::transaction(function () use ($r, $o, $start) {
            DB::table('rounds')->where('race_no', $r->race_no)->update(['status' => 'racing', 'combo' => $o['combo'], 'order' => json_encode($o['order']), 'anim_seed' => $o['animSeed'], 'start_at' => $start]);
            $this->log(['e' => 'draw', 'raceNo' => $r->race_no, 'combo' => $o['combo'], 'order' => $o['order'], 'animSeed' => $o['animSeed'], 'startAt' => $start]);
        });
    }

    private function settle(object $r): void
    {
        $odds = $this->odds($r);
        DB::transaction(function () use ($r, $odds) {
            DB::table('rounds')->where('race_no', $r->race_no)->lockForUpdate()->first();
            $bets = DB::table('bets')->where('race_no', $r->race_no)->where('status', 'open')->orderBy('placed_at')->orderBy('id')->get();
            $payouts = [];
            $staked = 0;
            $paid = 0;
            foreach ($bets as $b) {
                $staked += $b->stake;
                if ($b->combo === $r->combo) {
                    $pay = self::payoutFor($b->stake, $odds[$b->combo]);
                    $paid += $pay;
                    DB::table('bets')->where('id', $b->id)->update(['status' => 'won', 'payout' => $pay]);
                    $w = $payouts[$b->player_key] ?? ['amount' => 0, 'betIds' => [], 'currency' => $b->currency, 'brandId' => $b->brand_id];
                    $w['amount'] += $pay;
                    $w['betIds'][] = $b->id;
                    $payouts[$b->player_key] = $w;
                } else {
                    DB::table('bets')->where('id', $b->id)->update(['status' => 'lost', 'payout' => 0]);
                }
            }
            DB::table('rounds')->where('race_no', $r->race_no)->update(['status' => 'settled', 'staked' => $staked, 'paid' => $paid, 'settled_at' => $this->now()]);
            $list = [];
            foreach ($payouts as $pk => $w) {
                $list[] = ['playerId' => $pk, 'amount' => $w['amount']];
            }
            $this->log(['e' => 'settled', 'raceNo' => $r->race_no, 'combo' => $r->combo, 'staked' => $staked, 'paid' => $paid, 'payouts' => $list]);
            foreach ($payouts as $pk => $w) {
                $this->queueCredit('win:'.$r->race_no.':'.$pk, $pk, $w['amount'], $r->race_no, 'win', ['betIds' => $w['betIds'], 'currency' => $w['currency'], 'brandId' => $w['brandId']]);
                DB::table('game_sessions')->where('player_key', $pk)->increment('s_paid', $w['amount']);
            }
        });
        $this->flushCredits();
    }

    /** the daemon calls this every 250 ms */
    public function tick(): void
    {
        $t = $this->now();
        $r = $this->current();
        if (! $r) {
            $r = $this->open();
        }
        if ($r->status === 'betting' && $t >= $r->bet_close_at) {
            $this->drawNow($r);
            $r = $this->current();
        }
        if ($r->status === 'racing' && $t >= $r->start_at + $this->cfg['race_ms']) {
            $this->settle($r);
            $r = $this->current();
        }
        if ($r->status === 'settled' && $t >= $r->start_at + $this->cfg['race_ms'] + $this->cfg['results_ms']) {
            $this->open();
        }
        $this->flushCredits();
        $this->flushRollbacks();
        DB::table('game_sessions')->where('expires_at', '<', $t)->delete();
        Cache::put('horse:tick', $t, 3600);
    }

    /* ---------- wallet queues (credits and rollbacks that still have to reach the platform) ---------- */

    private function queueCredit(string $txId, string $playerKey, int $amount, int $raceNo, string $kind, array $extra = []): void
    {
        if ($amount <= 0 || DB::table('pending_ops')->where('tx_id', $txId)->exists()) {
            return;
        }
        $this->log(['e' => 'credit_due', 'txId' => $txId, 'playerId' => $playerKey, 'amount' => $amount, 'raceNo' => $raceNo, 'kind' => $kind, 'extra' => $extra ?: new \stdClass]);
        DB::table('pending_ops')->insert(['tx_id' => $txId, 'kind' => 'credit', 'player_key' => $playerKey, 'amount' => $amount, 'race_no' => $raceNo, 'tx_kind' => $kind,
            'extra' => json_encode($extra ?: new \stdClass), 'since' => $this->now(), 'tries' => 0, 'next_at' => 0]);
    }

    /** a debit that timed out twice may or may not have been applied: ask the wallet to cancel it (and refuse it if it arrives late) */
    private function queueRollback(string $txId, string $playerKey, int $amount, array $meta): void
    {
        if (DB::table('pending_ops')->where('tx_id', 'rb:'.$txId)->exists()) {
            return;
        }
        $extra = array_filter(['currency' => $meta['currency'] ?? null, 'brandId' => $meta['brandId'] ?? null, 'betId' => $meta['betId'] ?? null, 'betIds' => $meta['betIds'] ?? null], fn ($v) => $v !== null);
        $this->log(['e' => 'rollback_due', 'txId' => $txId, 'playerId' => $playerKey, 'amount' => $amount, 'raceNo' => $meta['raceNo'] ?? null, 'extra' => $extra ?: new \stdClass]);
        DB::table('pending_ops')->insert(['tx_id' => 'rb:'.$txId, 'kind' => 'rollback', 'player_key' => $playerKey, 'amount' => $amount, 'race_no' => $meta['raceNo'] ?? null,
            'extra' => json_encode($extra ?: new \stdClass), 'since' => $this->now(), 'tries' => 0, 'next_at' => 0]);
    }

    private function backoff(object $p, int $t): void
    {
        $tries = $p->tries + 1;
        DB::table('pending_ops')->where('tx_id', $p->tx_id)->update(['tries' => $tries, 'next_at' => $t + min(60000, 1000 * (2 ** min($tries, 6)))]);
    }

    public function flushCredits(): void
    {
        $t = $this->now();
        foreach (DB::table('pending_ops')->where('kind', 'credit')->where('next_at', '<=', $t)->orderBy('since')->limit(200)->get() as $p) {
            try {
                $extra = json_decode($p->extra ?? '{}', true) ?: [];
                $res = $this->walletCall(fn () => $this->wallet->credit($p->player_key, $p->amount, $p->tx_id, ['raceNo' => $p->race_no, 'roundId' => (string) $p->race_no, 'kind' => $p->tx_kind] + $extra));
                DB::table('pending_ops')->where('tx_id', $p->tx_id)->delete();
                $this->log(['e' => 'credit_ok', 'txId' => $p->tx_id, 'raceNo' => $p->race_no]);
                if (isset($res['balance'])) {
                    DB::table('game_sessions')->where('player_key', $p->player_key)->update(['balance' => $res['balance']]);
                }
            } catch (\Throwable $e) {
                $this->backoff($p, $t);
            }
        }
    }

    public function flushRollbacks(): void
    {
        $t = $this->now();
        foreach (DB::table('pending_ops')->where('kind', 'rollback')->where('next_at', '<=', $t)->orderBy('since')->limit(200)->get() as $p) {
            $orig = substr($p->tx_id, 3);
            try {
                $extra = json_decode($p->extra ?? '{}', true) ?: [];
                $res = $this->walletCall(fn () => $this->wallet->rollback($p->player_key, $p->amount, $orig, ['raceNo' => $p->race_no, 'roundId' => (string) $p->race_no, 'kind' => 'rollback', 'refTxId' => $orig] + $extra));
                DB::table('pending_ops')->where('tx_id', $p->tx_id)->delete();
                $this->log(['e' => 'rollback_ok', 'txId' => $orig, 'status' => $res['status'] ?? null]);
                if (isset($res['balance'])) {
                    DB::table('game_sessions')->where('player_key', $p->player_key)->update(['balance' => $res['balance']]);
                }
            } catch (WalletException $e) {
                if ($e->unsupported) {                      // the platform has no rollback: reconcile by hand
                    DB::table('pending_ops')->where('tx_id', $p->tx_id)->delete();
                    $this->log(['e' => 'rollback_unsupported', 'txId' => $orig]);

                    continue;
                }
                $this->backoff($p, $t);
            } catch (\Throwable $e) {
                $this->backoff($p, $t);
            }
        }
    }

    private function walletCall(Closure $fn): mixed
    {
        return $fn();
    }

    /* ---------- sessions ---------- */

    private static function skey(string $id): string
    {
        return hash('sha256', $id);
    }

    private function limitsFor(string $currency, ?array $info): array
    {
        $base = ['minBet' => $this->cfg['min_bet'], 'maxBet' => $this->cfg['max_bet'], 'maxRoundStake' => $this->cfg['max_round_stake'], 'dailyLossLimit' => $this->cfg['daily_loss_limit'] ?: 0];
        $pos = fn ($v) => is_int($v) && $v > 0;
        foreach ([($this->cfg['currency_limits'][$currency] ?? null), $info['limits'] ?? null] as $src) {
            if (! is_array($src)) {
                continue;
            }
            foreach (['minBet', 'maxBet', 'maxRoundStake'] as $k) {
                if ($pos($src[$k] ?? null)) {
                    $base[$k] = $src[$k];
                }
            }
            if (isset($src['dailyLossLimit']) && is_int($src['dailyLossLimit']) && $src['dailyLossLimit'] >= 0) {
                $base['dailyLossLimit'] = $src['dailyLossLimit'];
            }
        }
        $base['maxBet'] = max($base['maxBet'], $base['minBet']);
        $base['maxRoundStake'] = max($base['maxRoundStake'], $base['minBet']);

        return $base;
    }

    public function auth(string $token): array
    {
        try {
            $info = $this->walletCall(fn () => $this->wallet->validateToken($token));
        } catch (\Throwable $e) {
            throw new GameError(401, 'INVALID_TOKEN');
        }
        if (! preg_match(self::PLAYER_ID_RE, (string) ($info['playerId'] ?? ''))) {
            throw new GameError(401, 'INVALID_PLAYER_ID');
        }
        $pk = (string) $info['playerId'];
        if (! empty($info['blocked']) || DB::table('blocked_players')->where('player_key', $pk)->exists()) {
            throw new GameError(403, 'PLAYER_BLOCKED');
        }
        $id = bin2hex(random_bytes(24));
        $currency = $info['currency'] ?? $this->cfg['currency'];
        $rm = isset($info['realityCheckMinutes']) && is_int($info['realityCheckMinutes']) ? $info['realityCheckMinutes'] : $this->cfg['reality_check_minutes'];
        $d = $info['decimals'] ?? null;
        $t = $this->now();
        DB::table('game_sessions')->insert([
            'key' => self::skey($id), 'player_key' => $pk, 'raw_id' => $pk, 'client_id' => 'default', 'brand_id' => ! empty($info['brandId']) ? (string) $info['brandId'] : null,
            'currency' => $currency, 'decimals' => is_int($d) && $d >= 0 && $d <= 4 ? $d : 2, 'balance' => $info['balance'] ?? null, 'return_url' => $info['returnUrl'] ?? null,
            'limits' => json_encode($this->limitsFor($currency, $info)), 'reality_minutes' => $rm > 0 ? $rm : 0, 's_staked' => 0, 's_paid' => 0,
            'created_at' => $t, 'expires_at' => $t + $this->cfg['session_ttl_ms'], 'refreshed_at' => $t,
        ]);
        $s = DB::table('game_sessions')->where('key', self::skey($id))->first();

        return ['session' => $id, 'playerId' => $pk, 'returnUrl' => $info['returnUrl'] ?? null] + $this->sessionView($s);
    }

    private function sessionView(object $s): array
    {
        return ['currency' => $s->currency, 'decimals' => (int) $s->decimals, 'balance' => $s->balance === null ? null : (int) $s->balance, 'limits' => json_decode($s->limits, true), 'brandId' => $s->brand_id,
            'responsible' => ['realityCheckMinutes' => (int) $s->reality_minutes, 'startedAt' => (int) $s->created_at, 'staked' => (int) $s->s_staked, 'paid' => (int) $s->s_paid,
                'dailyNetLoss' => max(0, $this->dayNet($s->player_key))]];
    }

    public function session(string $id): ?object
    {
        if ($id === '') {
            return null;
        }
        $s = DB::table('game_sessions')->where('key', self::skey($id))->first();
        if (! $s) {
            return null;
        }
        if ($s->expires_at < $this->now()) {
            DB::table('game_sessions')->where('key', $s->key)->delete();

            return null;
        }

        return $s;
    }

    /** stake and payout of a player today (UTC), for the daily loss limit */
    private function dayRec(string $playerKey): array
    {
        $day = gmdate('Y-m-d', intdiv($this->now(), 1000));
        $from = strtotime($day.' 00:00:00 UTC') * 1000;
        $q = DB::table('bets')->where('player_key', $playerKey)->where('placed_at', '>=', $from)->where('placed_at', '<', $from + 86400000)->where('status', '!=', 'refunded');

        return ['staked' => (int) $q->sum('stake'), 'paid' => (int) (clone $q)->sum('payout')];
    }

    private function dayNet(string $playerKey): int
    {
        $d = $this->dayRec($playerKey);

        return $d['staked'] - $d['paid'];
    }

    public function blockPlayer(string $playerKey, string $who = 'operator'): array
    {
        if ($playerKey === '') {
            throw new GameError(400, 'BAD_REQUEST');
        }
        DB::table('blocked_players')->updateOrInsert(['player_key' => $playerKey], ['who' => $who]);
        $n = DB::table('game_sessions')->where('player_key', $playerKey)->delete();
        $this->log(['e' => 'player_blocked', 'playerId' => $playerKey, 'who' => $who]);

        return ['ok' => true, 'blocked' => true, 'closed' => $n];
    }

    public function unblockPlayer(string $playerKey, string $who = 'operator'): array
    {
        DB::table('blocked_players')->where('player_key', $playerKey)->delete();
        $this->log(['e' => 'player_unblocked', 'playerId' => $playerKey, 'who' => $who]);

        return ['ok' => true, 'blocked' => false];
    }

    /* ---------- betting ---------- */

    /** @param mixed $list the "bets" array of the request: [{combo, stake}] */
    public function placeBets(string $sessionId, mixed $list): array
    {
        $s = $this->session($sessionId);
        if (! $s) {
            throw new GameError(401, 'SESSION_EXPIRED');
        }
        if (DB::table('blocked_players')->where('player_key', $s->player_key)->exists()) {
            throw new GameError(403, 'PLAYER_BLOCKED');
        }
        $rl = 'horse-bet:'.$s->key;       // at most 12 bet requests per 5 s per session
        if (RateLimiter::tooManyAttempts($rl, 12)) {
            throw new GameError(429, 'TOO_MANY_REQUESTS');
        }
        RateLimiter::hit($rl, 5);
        $r = $this->current();
        if (! $r || $r->status !== 'betting' || $this->now() >= $r->bet_close_at) {
            throw new GameError(409, 'BETTING_CLOSED');
        }
        $combos = Odds::combos();
        if (! is_array($list) || ! array_is_list($list) || ! $list || count($list) > count($combos)) {
            throw new GameError(400, 'BAD_REQUEST');
        }
        $lim = json_decode($s->limits, true);
        $merged = [];
        foreach ($list as $b) {
            $stake = is_array($b) ? ($b['stake'] ?? null) : null;
            if (! is_array($b) || ! in_array($b['combo'] ?? null, $combos, true) || ! is_int($stake) || $stake < $lim['minBet'] || $stake > $lim['maxBet']) {
                throw new GameError(400, 'BAD_BET');
            }
            $merged[$b['combo']] = ($merged[$b['combo']] ?? 0) + $stake;
        }
        try {                                           // one bet request per player at a time: the limits below cannot be raced
            return Cache::lock('horse-player:'.$s->player_key, 20)->block(5, fn () => $this->placeLocked($s, $r->race_no, $merged, $lim));
        } catch (LockTimeoutException) {
            throw new GameError(429, 'TOO_MANY_REQUESTS');
        }
    }

    private function placeLocked(object $s, int $raceNo, array $merged, array $lim): array
    {
        $mineTotal = (int) DB::table('bets')->where('race_no', $raceNo)->where('player_key', $s->player_key)->sum('stake');
        $total = 0;
        foreach ($merged as $combo => $stake) {
            $perCombo = (int) DB::table('bets')->where('race_no', $raceNo)->where('player_key', $s->player_key)->where('combo', $combo)->sum('stake');
            if ($perCombo + $stake > $lim['maxBet']) {
                throw new GameError(400, 'MAX_BET_EXCEEDED');
            }
            $total += $stake;
        }
        if ($mineTotal + $total > $lim['maxRoundStake']) {
            throw new GameError(400, 'MAX_ROUND_STAKE_EXCEEDED');
        }
        $day = $this->dayRec($s->player_key);
        if ($lim['dailyLossLimit'] > 0 && $day['staked'] - $day['paid'] + $total > $lim['dailyLossLimit']) {
            throw new GameError(400, 'DAILY_LOSS_LIMIT');
        }
        $batch = bin2hex(random_bytes(8));
        $txId = 'bet:'.$raceNo.':'.$batch;
        $base = ['raceNo' => $raceNo, 'roundId' => (string) $raceNo, 'currency' => $s->currency, 'brandId' => $s->brand_id];
        $betIds = array_map(fn ($c) => $batch.':'.$c, array_keys($merged));
        $res = $this->debit($s->player_key, $total, $txId, ['kind' => 'bet', 'betId' => $batch, 'betIds' => $betIds] + $base);

        $placed = DB::transaction(function () use ($raceNo, $merged, $s, $total, $batch, $txId, $res, $betIds, $base) {
            $r = DB::table('rounds')->where('race_no', $raceNo)->lockForUpdate()->first();
            if (! $r || $r->status !== 'betting' || $this->now() >= $r->bet_close_at) {     // betting closed while the wallet was busy
                $this->queueCredit('refund:'.$txId, $s->player_key, $total, $raceNo, 'refund', ['betId' => $batch, 'betIds' => $betIds, 'refTxId' => $txId] + $base);

                return null;
            }
            $placed = [];
            $odds = json_decode($r->odds, true);
            foreach ($merged as $combo => $stake) {
                $id = $batch.':'.$combo;
                $at = $this->now();
                DB::table('bets')->insert(['id' => $id, 'race_no' => $raceNo, 'player_key' => $s->player_key, 'combo' => $combo, 'stake' => $stake, 'status' => 'open', 'payout' => 0,
                    'currency' => $s->currency, 'brand_id' => $s->brand_id, 'placed_at' => $at]);
                $this->log(['e' => 'bet', 'raceNo' => $raceNo, 'id' => $id, 'playerId' => $s->player_key, 'combo' => $combo, 'stake' => $stake, 'txId' => $txId, 'currency' => $s->currency, 'brandId' => $s->brand_id]);
                $placed[] = ['id' => $id, 'raceNo' => $raceNo, 'combo' => $combo, 'stake' => $stake, 'status' => 'open', 'payout' => 0, 'odds' => $odds[$combo]];
            }
            DB::table('game_sessions')->where('key', $s->key)->update(['balance' => $res['balance'] ?? null, 's_staked' => DB::raw('s_staked + '.(int) $total)]);

            return $placed;
        });
        if ($placed === null) {
            throw new GameError(409, 'BETTING_CLOSED');
        }

        return ['bets' => $placed, 'balance' => $res['balance'] ?? null];
    }

    private function debit(string $playerKey, int $amount, string $txId, array $meta): array
    {
        for ($attempt = 0; $attempt < 2; $attempt++) {
            try {
                return $this->walletCall(fn () => $this->wallet->debit($playerKey, $amount, $txId, $meta));
            } catch (WalletException $e) {
                if ($e->getMessage() === 'INSUFFICIENT_FUNDS') {
                    throw new GameError(402, 'INSUFFICIENT_FUNDS');
                }
                if ($e->definitive) {
                    throw new GameError(502, 'WALLET_REJECTED');
                }
                if ($attempt === 1) {
                    $this->log(['e' => 'debit_unknown', 'playerId' => $playerKey, 'amount' => $amount, 'txId' => $txId]);
                    $this->queueRollback($txId, $playerKey, $amount, $meta);
                    throw new GameError(502, 'WALLET_UNAVAILABLE');
                }
                usleep(250000);                          // the same txId again: the wallet is idempotent
            }
        }
        throw new GameError(502, 'WALLET_UNAVAILABLE');
    }

    /* ---------- views ---------- */

    private function phase(object $r, int $t): string
    {
        if ($r->status === 'betting') {
            return 'betting';
        }
        if ($t < $r->start_at) {
            return 'closed';
        }
        if ($t < $r->start_at + $this->cfg['race_ms']) {
            return 'racing';
        }

        return 'results';
    }

    public function rules(): array
    {
        return ['combos' => Odds::combos(), 'oddsValues' => $this->values, 'shuffleOdds' => (bool) ($this->cfg['shuffle_odds'] ?? true), 'minBet' => $this->cfg['min_bet'],
            'maxBet' => $this->cfg['max_bet'], 'maxRoundStake' => $this->cfg['max_round_stake'], 'currency' => $this->cfg['currency']];
    }

    /** what every browser polls (GET /api/public) */
    public function publicState(): array
    {
        $t = $this->now();
        $r = $this->current();
        $drawn = $r && $r->order ? $r : DB::table('rounds')->where('status', 'settled')->orderByDesc('race_no')->first();
        $settled = DB::table('rounds')->where('status', 'settled')->orderByDesc('race_no')->limit(8)->get()->reverse()->values();
        $round = null;
        if ($r) {
            $tb = $this->tableOf($r);
            $round = ['raceNo' => (int) $r->race_no, 'phase' => $this->phase($r, $t), 'openAt' => (int) $r->open_at, 'betCloseAt' => (int) $r->bet_close_at, 'startAt' => $r->start_at === null ? null : (int) $r->start_at,
                'commit' => $r->commit, 'odds' => $this->odds($r), 'rtp' => (float) $r->rtp, 'cheapRtp' => $tb['cheapRtp'], 'cheapPairs' => $tb['cheap']];
        }
        $st = [
            'mode' => 'live', 'serverNow' => $t, 'nextRaceNo' => $r ? (int) $r->race_no + ($r->status === 'betting' ? 0 : 1) : 1,
            'timings' => ['countdown' => $this->cfg['countdown_ms'], 'race' => $this->cfg['race_ms'], 'results' => $this->cfg['results_ms'], 'bet' => $this->cfg['bet_ms']],
            'rules' => $this->rules(), 'round' => $round, 'race' => null,
            'history' => $settled->map(fn ($x) => ['raceNo' => (int) $x->race_no, 'order' => json_decode($x->order, true)])->all(),
            'reveals' => DB::table('rounds')->where('status', 'settled')->orderByDesc('race_no')->limit(5)->get()->reverse()->values()->map(fn ($x) => [
                'raceNo' => (int) $x->race_no, 'seed' => $x->seed, 'commit' => $x->commit, 'combo' => $x->combo, 'order' => json_decode($x->order, true), 'odds' => $this->odds($x), 'rtp' => (float) $x->rtp])->all(),
        ];
        if ($drawn) {
            $st['race'] = ['raceNo' => (int) $drawn->race_no, 'startAt' => (int) $drawn->start_at, 'seed' => (int) $drawn->anim_seed, 'order' => $t >= $drawn->start_at - 2000 ? json_decode($drawn->order, true) : null];
        }

        return $st;
    }

    private function mine(object $r, string $playerKey): array
    {
        $odds = $this->odds($r);

        return DB::table('bets')->where('race_no', $r->race_no)->where('player_key', $playerKey)->orderBy('placed_at')->orderBy('id')->get()
            ->map(fn ($b) => ['combo' => $b->combo, 'stake' => (int) $b->stake, 'odds' => $odds[$b->combo], 'status' => $b->status, 'payout' => (int) $b->payout])->all();
    }

    public function me(string $sessionId): array
    {
        $s = $this->session($sessionId);
        if (! $s) {
            throw new GameError(401, 'SESSION_EXPIRED');
        }
        if ($this->now() - $s->refreshed_at > 15000) {
            DB::table('game_sessions')->where('key', $s->key)->update(['refreshed_at' => $this->now()]);
            try {
                $bal = $this->walletCall(fn () => $this->wallet->balance($s->raw_id));
                DB::table('game_sessions')->where('key', $s->key)->update(['balance' => $bal]);
            } catch (\Throwable $e) {
                // keep the cached balance
            }
            $s = DB::table('game_sessions')->where('key', $s->key)->first();
        }
        $out = ['playerId' => $s->raw_id, 'returnUrl' => $s->return_url, 'raceNo' => null, 'bets' => [], 'last' => null] + $this->sessionView($s);
        $cur = $this->current();
        if ($cur) {
            $out['raceNo'] = (int) $cur->race_no;
            $out['bets'] = $this->mine($cur, $s->player_key);
        }
        $prev = DB::table('rounds')->where('status', 'settled')->orderByDesc('race_no')->first();
        if ($prev) {
            $b = $this->mine($prev, $s->player_key);
            if ($b) {
                $out['last'] = ['raceNo' => (int) $prev->race_no, 'combo' => $prev->combo, 'bets' => $b];
            }
        }

        return $out;
    }

    public function historyFor(string $playerKey, mixed $limit = 50): array
    {
        $limit = max(1, min(200, (int) $limit ?: 50));
        $rounds = [];
        $rows = DB::table('bets')->join('rounds', 'rounds.race_no', '=', 'bets.race_no')->where('bets.player_key', $playerKey)
            ->orderByDesc('bets.race_no')->orderBy('bets.placed_at')->orderBy('bets.id')->limit(400)
            ->get(['bets.*', 'rounds.odds as r_odds', 'rounds.status as r_status', 'rounds.combo as r_combo', 'rounds.order as r_order', 'rounds.commit as r_commit']);
        foreach ($rows as $b) {
            $settled = $b->r_status === 'settled';
            $x = $rounds[$b->race_no] ?? ['raceNo' => (int) $b->race_no, 'roundId' => (string) $b->race_no, 'combo' => $settled ? $b->r_combo : null,
                'order' => $settled ? json_decode($b->r_order, true) : null, 'commit' => $settled ? $b->r_commit : null, 'staked' => 0, 'paid' => 0, 'bets' => []];
            $odds = json_decode($b->r_odds, true);
            $x['bets'][] = ['raceNo' => (int) $b->race_no, 'betId' => $b->id, 'combo' => $b->combo, 'stake' => (int) $b->stake, 'odds' => $odds[$b->combo] ?? null, 'status' => $b->status,
                'payout' => (int) $b->payout, 'placedAt' => (int) $b->placed_at, 'currency' => $b->currency, 'brandId' => $b->brand_id];
            $x['staked'] += (int) $b->stake;
            $x['paid'] += $b->status === 'refunded' ? (int) $b->stake : (int) $b->payout;
            $rounds[$b->race_no] = $x;
        }

        return ['ok' => true, 'playerId' => $playerKey, 'clientId' => 'default', 'rounds' => array_slice(array_values($rounds), 0, $limit)];
    }

    /** a revealed round, so anyone can check: sha256(seed) === commit, the odds layout and the draw */
    public function proof(int $raceNo): array
    {
        $r = DB::table('rounds')->where('race_no', $raceNo)->where('status', 'settled')->first();
        if (! $r) {
            throw new GameError(404, 'NOT_FOUND');
        }

        return ['ok' => true, 'hash' => 'sha256', 'raceNo' => (int) $r->race_no, 'roundId' => (string) $r->race_no, 'commit' => $r->commit, 'seed' => $r->seed, 'odds' => $this->odds($r),
            'rtp' => (float) $r->rtp, 'combo' => $r->combo, 'order' => json_decode($r->order, true)];
    }

    /** numbers for the operator's controller (GET /api/report, /api/admin) */
    public function report(): array
    {
        $p = $this->previewRtp($this->rtp());
        $settled = DB::table('rounds')->where('status', 'settled');
        $rounds = (int) (clone $settled)->count();
        $staked = (int) (clone $settled)->sum('staked');
        $paid = (int) (clone $settled)->sum('paid');
        $bets = (int) DB::table('bets')->whereIn('status', ['won', 'lost'])->count();
        $wins = array_fill_keys(Odds::combos(), 0);
        $winsByOdds = [];
        foreach ((clone $settled)->get(['combo', 'odds']) as $x) {
            $wins[$x->combo]++;
            $o = json_decode($x->odds, true)[$x->combo];
            $winsByOdds[(string) $o] = ($winsByOdds[(string) $o] ?? 0) + 1;
        }
        $cur = $this->current();
        $recent = (clone $settled)->orderByDesc('race_no')->limit(50)->get()->map(function ($x) {
            $n = (int) DB::table('bets')->where('race_no', $x->race_no)->count();

            return ['raceNo' => (int) $x->race_no, 'combo' => $x->combo, 'order' => json_decode($x->order, true), 'staked' => (int) $x->staked, 'paid' => (int) $x->paid, 'bets' => $n,
                'odds' => json_decode($x->odds, true)[$x->combo]];
        })->all();
        $byCurrency = [];
        foreach (DB::table('bets')->whereIn('status', ['won', 'lost'])->selectRaw('currency, sum(stake) as s, sum(payout) as p')->groupBy('currency')->get() as $c) {
            $byCurrency[$c->currency] = ['staked' => (int) $c->s, 'paid' => (int) $c->p];
        }

        return [
            'mode' => 'live', 'rtpSetting' => $this->rtp(), 'rtpOfCurrentRace' => $cur ? (float) $cur->rtp : null, 'bestBetRtp' => $p['bestRtp'], 'cheapPairsRtp' => $p['cheapRtp'], 'evenSpreadRtp' => $p['evenSpreadRtp'],
            'theoreticalRtp' => $this->rtp(), 'shuffleOdds' => (bool) ($this->cfg['shuffle_odds'] ?? true), 'oddsValues' => $this->values, 'winsByOdds' => (object) $winsByOdds,
            'oddsProb' => (object) collect($p['rows'])->mapWithKeys(fn ($r) => [(string) $r['odds'] => $r['probability']])->all(),
            'limits' => ['minBet' => $this->cfg['min_bet'], 'maxBet' => $this->cfg['max_bet'], 'maxRoundStake' => $this->cfg['max_round_stake']],
            'rounds' => $rounds, 'bets' => $bets, 'staked' => $staked, 'paid' => $paid, 'actualRtp' => $staked ? $paid / $staked : null, 'houseWin' => $staked - $paid, 'wins' => $wins,
            'pendingCredits' => (int) DB::table('pending_ops')->where('kind', 'credit')->count(), 'pendingRollbacks' => (int) DB::table('pending_ops')->where('kind', 'rollback')->count(),
            'pendingWebhooks' => 0, 'blockedPlayers' => (int) DB::table('blocked_players')->count(), 'byCurrency' => (object) $byCurrency, 'byClient' => (object) [],
            'activeSessions' => (int) DB::table('game_sessions')->where('expires_at', '>', $this->now())->count(), 'recent' => $recent, 'commit' => $cur ? $cur->commit : null, 'currentRound' => $cur ? (int) $cur->race_no : null,
        ];
    }

    public function health(): array
    {
        $reasons = [];
        $l = $this->ledger->verify();
        if (! $l['ok']) {
            $reasons[] = 'ledger hash chain is broken at line '.$l['broken']['line'];
        }
        $tick = Cache::get('horse:tick');
        if ($tick === null || ($this->now() - $tick) > 5000) {
            $reasons[] = 'the round loop (php artisan game:run) has not run for '.($tick === null ? 'a while' : round(($this->now() - $tick) / 1000).' s');
        }

        return ['ok' => ! $reasons, 'reasons' => $reasons];
    }
}
