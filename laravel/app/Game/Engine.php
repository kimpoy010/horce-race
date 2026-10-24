<?php

namespace App\Game;

use App\Game\Clients\ClientRegistry;
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

    /**
     * @param  Wallet|null  $wallet  wallet of the implicit "default" client (HORSE_WALLET); null = registry clients only (HORSE_WALLET=none)
     * @param  Webhook|null  $webhook  webhook of the default client
     */
    public function __construct(private ?Wallet $wallet, private Ledger $ledger, private array $cfg, private ?Closure $clock = null, private ?ClientRegistry $clients = null, private ?Webhook $webhook = null)
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
            $per = [];                                               // per client: its own bets, staked and paid (for its webhook)
            foreach ($bets as $b) {
                $staked += $b->stake;
                $cid = self::splitPk($b->player_key)[0];
                $per[$cid] ??= ['bets' => 0, 'staked' => 0, 'paid' => 0];
                $per[$cid]['bets']++;
                $per[$cid]['staked'] += $b->stake;
                if ($b->combo === $r->combo) {
                    $pay = self::payoutFor($b->stake, $odds[$b->combo]);
                    $paid += $pay;
                    $per[$cid]['paid'] += $pay;
                    DB::table('bets')->where('id', $b->id)->update(['status' => 'won', 'payout' => $pay]);
                    $w = $payouts[$b->player_key] ?? ['amount' => 0, 'stake' => 0, 'betIds' => [], 'currency' => $b->currency, 'brandId' => $b->brand_id, 'odds' => $odds[$b->combo]];
                    $w['amount'] += $pay;
                    $w['stake'] += $b->stake;
                    $w['betIds'][] = $b->id;
                    $payouts[$b->player_key] = $w;
                } else {
                    DB::table('bets')->where('id', $b->id)->update(['status' => 'lost', 'payout' => 0]);
                }
            }
            DB::table('rounds')->where('race_no', $r->race_no)->update(['status' => 'settled', 'staked' => $staked, 'paid' => $paid, 'settled_at' => $this->now()]);
            $this->trackRtp($bets, $odds, $r);
            $list = [];
            foreach ($payouts as $pk => $w) {
                $list[] = ['playerId' => $pk, 'amount' => $w['amount']];
            }
            $this->log(['e' => 'settled', 'raceNo' => $r->race_no, 'combo' => $r->combo, 'staked' => $staked, 'paid' => $paid, 'payouts' => $list]);
            foreach ($payouts as $pk => $w) {
                $this->queueCredit('win:'.$r->race_no.':'.$pk, $pk, $w['amount'], $r->race_no, 'win', ['betIds' => $w['betIds'], 'currency' => $w['currency'], 'brandId' => $w['brandId']]);
                DB::table('game_sessions')->where('player_key', $pk)->increment('s_paid', $w['amount']);
            }
            // every client with a webhook gets the result; the money figures are its own players'
            $cids = array_unique(array_merge(['default'], $this->clients ? DB::table('clients')->pluck('id')->all() : []));
            foreach ($cids as $cid) {
                $x = $per[$cid] ?? ['bets' => 0, 'staked' => 0, 'paid' => 0];
                $this->emit('round.settled', 'round:'.$r->race_no, ['roundId' => (string) $r->race_no, 'raceNo' => (int) $r->race_no, 'combo' => $r->combo, 'order' => json_decode($r->order, true), 'odds' => $odds,
                    'oddsOfWinner' => $odds[$r->combo], 'rtp' => (float) $r->rtp, 'commit' => $r->commit, 'seed' => $r->seed, 'bets' => $x['bets'], 'staked' => $x['staked'], 'paid' => $x['paid'],
                    'ledgerHash' => $this->ledger->head(), 'ledgerLines' => $this->ledger->lines()], $cid);
            }
            foreach ($payouts as $pk => $w) {
                [$cid, $raw] = self::splitPk($pk);
                $min = $this->clientCfg($cid)['bigWinMin'] ?? $this->cfg['big_win_min'];
                if ($w['amount'] >= $min) {
                    $this->emit('big.win', 'win:'.$r->race_no.':'.$raw, ['roundId' => (string) $r->race_no, 'raceNo' => (int) $r->race_no, 'playerId' => $raw, 'brandId' => $w['brandId'], 'currency' => $w['currency'],
                        'stake' => $w['stake'], 'payout' => $w['amount'], 'odds' => $w['odds'], 'betIds' => $w['betIds']], $cid);
                }
            }
        });
        $this->flushCredits();
    }

    /** each bet is a lottery ticket: it pays stake x odds with probability p. Summing expectation and variance over all bets says whether the payouts are in line with the odds */
    private function trackRtp($bets, array $odds, object $r): void
    {
        $prob = $this->tableOf($r)['prob'];
        $exp = 0.0;
        $var = 0.0;
        $staked = 0;
        $paid = 0;
        foreach ($bets as $b) {
            $p = $prob[$b->combo];
            $w = $b->stake * $odds[$b->combo];
            $exp += $w * $p;
            $var += $w * $w * $p * (1 - $p);
            $staked += $b->stake;
            if ($b->combo === $r->combo) {
                $paid += self::payoutFor($b->stake, $odds[$b->combo]);
            }
        }
        $T = json_decode((string) DB::table('settings')->where('key', 'rtp_track')->value('value'), true) ?: ['exp' => 0, 'varsum' => 0, 'paid' => 0, 'staked' => 0];
        $T = ['exp' => $T['exp'] + $exp, 'varsum' => $T['varsum'] + $var, 'paid' => $T['paid'] + $paid, 'staked' => $T['staked'] + $staked];
        DB::table('settings')->updateOrInsert(['key' => 'rtp_track'], ['value' => json_encode($T)]);
    }

    public function rtpZ(): float
    {
        $T = json_decode((string) DB::table('settings')->where('key', 'rtp_track')->value('value'), true);

        return $T && $T['varsum'] > 0 ? ($T['paid'] - $T['exp']) / sqrt($T['varsum']) : 0.0;
    }

    /** cancels a race that was never drawn and gives every stake back (queued like any credit: the wallet confirms each refund) */
    public function voidRound(int $raceNo, string $reason): int
    {
        $n = DB::transaction(function () use ($raceNo, $reason) {
            $r = DB::table('rounds')->where('race_no', $raceNo)->lockForUpdate()->first();
            if (! $r || $r->status !== 'betting') {
                throw new GameError(409, 'NOT_VOID_ABLE');
            }
            $bets = DB::table('bets')->where('race_no', $raceNo)->where('status', 'open')->get();
            $this->log(['e' => 'void', 'raceNo' => $raceNo, 'reason' => $reason]);
            DB::table('bets')->where('race_no', $raceNo)->where('status', 'open')->update(['status' => 'refunded']);
            DB::table('rounds')->where('race_no', $raceNo)->update(['status' => 'void']);
            $per = [];
            foreach ($bets as $b) {
                $per[$b->player_key] = ($per[$b->player_key] ?? 0) + $b->stake;
            }
            foreach ($per as $pk => $amount) {
                $this->queueCredit('refund:'.$raceNo.':'.$pk, $pk, $amount, $raceNo, 'refund');
            }

            return $bets->count();
        });
        $this->bust();

        return $n;
    }

    /** recomputes the payouts-vs-odds figures from the settled races (after an import) */
    public function rebuildRtpTrack(): void
    {
        $T = ['exp' => 0.0, 'varsum' => 0.0, 'paid' => 0, 'staked' => 0];
        foreach (DB::table('rounds')->where('status', 'settled')->orderBy('race_no')->get() as $r) {
            $odds = $this->odds($r);
            $prob = $this->tableOf($r)['prob'];
            foreach (DB::table('bets')->where('race_no', $r->race_no)->whereIn('status', ['won', 'lost'])->get() as $b) {
                $w = $b->stake * $odds[$b->combo];
                $T['exp'] += $w * $prob[$b->combo];
                $T['varsum'] += $w * $w * $prob[$b->combo] * (1 - $prob[$b->combo]);
                $T['staked'] += $b->stake;
                $T['paid'] += $b->payout;
            }
        }
        DB::table('settings')->updateOrInsert(['key' => 'rtp_track'], ['value' => json_encode($T)]);
    }

    /** the daemon calls this every 250 ms */
    public function tick(): void
    {
        $t = $this->now();
        $r = $this->current();
        if (! $r) {
            $r = $this->open();
            $this->bust();
        }
        if ($r->status === 'betting' && $t >= $r->bet_close_at) {
            $this->drawNow($r);
            $this->bust();
            $r = $this->current();
        }
        if ($r->status === 'racing' && $t >= $r->start_at + $this->cfg['race_ms']) {
            $this->settle($r);
            $this->bust();
            $r = $this->current();
        }
        if ($r->status === 'settled' && $t >= $r->start_at + $this->cfg['race_ms'] + $this->cfg['results_ms']) {
            $this->open();
            $this->bust();
        }
        if ($r->status === 'void') {                      // a race that was cancelled (cutover from another server): start a fresh one
            $this->open();
            $this->bust();
        }
        $this->flushCredits();
        $this->flushRollbacks();
        $this->flushWebhooks();
        DB::table('game_sessions')->where('expires_at', '<', $t)->delete();
        DB::table('wallet_calls')->where('at', '<', $t - 3600000)->delete();
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

    /** webhooks to the platform: at least once; the platform de-duplicates on `id` */
    private function emit(string $type, string $key, array $data, string $clientId): void
    {
        $wh = $this->clientActive($clientId) ? $this->webhookFor($clientId) : null;
        if (! $wh || ! $wh->wants($type)) {
            return;
        }
        $ev = ['id' => $this->cfg['game_id'].':'.($clientId === 'default' ? '' : $clientId.':').$key, 'type' => $type, 'createdAt' => $this->now(), 'gameId' => $this->cfg['game_id'], 'clientId' => $clientId, 'data' => $data];
        $this->log(['e' => 'webhook_due', 'ev' => $ev]);
        DB::table('pending_ops')->insertOrIgnore(['tx_id' => $ev['id'], 'kind' => 'webhook', 'player_key' => '', 'amount' => 0, 'race_no' => $data['raceNo'] ?? null,
            'extra' => json_encode($ev, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE), 'since' => $this->now(), 'tries' => 0, 'next_at' => 0]);
    }

    public function flushWebhooks(): void
    {
        $t = $this->now();
        foreach (DB::table('pending_ops')->where('kind', 'webhook')->where('next_at', '<=', $t)->orderBy('since')->limit(100)->get() as $p) {
            $ev = json_decode($p->extra, true);
            $cid = $ev['clientId'] ?? 'default';
            $wh = $this->clientActive($cid) ? $this->webhookFor($cid) : null;
            if (! $wh) {
                DB::table('pending_ops')->where('tx_id', $p->tx_id)->delete();
                $this->log(['e' => 'webhook_dropped', 'id' => $p->tx_id, 'reason' => 'client has no webhook any more']);

                continue;
            }
            try {
                $wh->send($ev);
                DB::table('pending_ops')->where('tx_id', $p->tx_id)->delete();
                $this->log(['e' => 'webhook_ok', 'id' => $p->tx_id]);
            } catch (\Throwable $e) {
                $this->backoff($p, $t);
            }
        }
    }

    public function flushCredits(): void
    {
        $t = $this->now();
        foreach (DB::table('pending_ops')->where('kind', 'credit')->where('next_at', '<=', $t)->orderBy('since')->limit(200)->get() as $p) {
            try {
                $extra = json_decode($p->extra ?? '{}', true) ?: [];
                [$cid, $raw] = self::splitPk($p->player_key);
                $w = $this->walletFor($cid) ?? throw new \RuntimeException('no wallet for client '.$cid);
                $res = $this->walletCall(fn () => $w->credit($raw, $p->amount, $p->tx_id, ['raceNo' => $p->race_no, 'roundId' => (string) $p->race_no, 'kind' => $p->tx_kind] + $extra), 'credit', $cid);
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
                [$cid, $raw] = self::splitPk($p->player_key);
                $w = $this->walletFor($cid) ?? throw new \RuntimeException('no wallet for client '.$cid);
                $res = $this->walletCall(fn () => $w->rollback($raw, $p->amount, $orig, ['raceNo' => $p->race_no, 'roundId' => (string) $p->race_no, 'kind' => 'rollback', 'refTxId' => $orig] + $extra), 'rollback', $cid);
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

    /** every wallet call goes through here: timing and failures feed the overview and /metrics. A normal refusal is an answer; no answer, a server error or a rejected signature is a failure. */
    private function walletCall(Closure $fn, string $op = 'call', string $clientId = 'default'): mixed
    {
        $t0 = hrtime(true);
        $ok = true;
        try {
            return $fn();
        } catch (\Throwable $e) {
            $ok = $e->getMessage() === 'INSUFFICIENT_FUNDS' || ($e instanceof WalletException && $e->definitive && ! in_array($e->status, [401, 403], true));
            throw $e;
        } finally {
            try {
                $ms = (int) round((hrtime(true) - $t0) / 1e6);
                DB::table('wallet_calls')->insert(['at' => $this->now(), 'client' => $clientId, 'op' => $op, 'ms' => $ms, 'ok' => $ok]);
                $this->countWalletCall($clientId, $op, $ms, $ok);
            } catch (\Throwable $e) {
                // metrics must never break a bet
            }
        }
    }

    /** running totals for /metrics (counters only go up, so they are kept apart from the hour of detailed calls) */
    private function countWalletCall(string $clientId, string $op, int $ms, bool $ok): void
    {
        DB::table('wallet_stats')->insertOrIgnore(['client' => $clientId, 'op' => $op]);
        $set = [$ok ? 'ok' : 'fail' => DB::raw(($ok ? 'ok' : 'fail').' + 1'), 'sum_ms' => DB::raw('sum_ms + '.$ms)];
        foreach ([50, 100, 250, 500, 1000, 2500, 5000, 10000] as $le) {
            if ($ms <= $le) {
                $set['le'.$le] = DB::raw('le'.$le.' + 1');
            }
        }
        DB::table('wallet_stats')->where('client', $clientId)->where('op', $op)->update($set);
    }

    /** calls in the last $windowMs: calls, failures, failRate, p95 (ms) */
    public function walletWindow(int $windowMs, ?string $client = null): array
    {
        $q = DB::table('wallet_calls')->where('at', '>=', $this->now() - $windowMs);
        if ($client !== null) {
            $q->where('client', $client);
        }
        $ms = (clone $q)->orderBy('ms')->pluck('ms')->all();
        $n = count($ms);
        $fails = (int) (clone $q)->where('ok', false)->count();

        return ['calls' => $n, 'failures' => $fails, 'failRate' => $n ? $fails / $n : 0, 'p95' => $n ? $ms[min($n - 1, (int) floor($n * 0.95))] : 0];
    }

    /* ---------- clients: every player belongs to one client (platform). Internally a player is "clientId:playerId" ("default" client: just playerId) ---------- */

    public static function pk(?string $clientId, string $playerId): string
    {
        return ! $clientId || $clientId === 'default' ? $playerId : $clientId.':'.$playerId;
    }

    /** @return array{0:string,1:string} [clientId, playerId] */
    public static function splitPk(string $pk): array
    {
        $i = strpos($pk, ':');

        return $i === false ? ['default', $pk] : [substr($pk, 0, $i), substr($pk, $i + 1)];
    }

    private function clientCfg(string $id): array
    {
        return ($this->clients ? $this->clients->get($id) : null) ?? ['id' => $id, 'status' => 'active', 'limits' => [], 'currencyLimits' => []];
    }

    private function walletFor(string $clientId): ?Wallet
    {
        if ($this->clients && $this->clients->get($clientId)) {
            return $this->clients->walletFor($clientId);
        }

        return $clientId === 'default' ? $this->wallet : null;
    }

    private function webhookFor(string $clientId): ?Webhook
    {
        if ($this->clients && $this->clients->get($clientId)) {
            return $this->clients->webhookFor($clientId);
        }

        return $clientId === 'default' ? $this->webhook : null;
    }

    public function clientActive(string $id): bool
    {
        $c = $this->clients ? $this->clients->get($id) : null;

        return $c ? $c['status'] === 'active' : ($id === 'default' && $this->wallet !== null);
    }

    /** which client a launch belongs to (the launch link may omit it when there is only one) */
    public function resolveClient(?string $clientId): string
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

        return self::pk($clientId ?: 'default', (string) $playerId);
    }

    /** restricts a query to the players of one client (their player keys start with "<client>:", the default client's have no ":") */
    private function ofClient($q, string $clientId, string $col = 'player_key')
    {
        return $clientId === 'default' ? $q->where($col, 'not like', '%:%') : $q->where($col, 'like', $clientId.':%');
    }

    /* ---------- sessions ---------- */

    private static function skey(string $id): string
    {
        return hash('sha256', $id);
    }

    private function limitsFor(string $currency, ?array $info, array $client = []): array
    {
        $base = ['minBet' => $this->cfg['min_bet'], 'maxBet' => $this->cfg['max_bet'], 'maxRoundStake' => $this->cfg['max_round_stake'], 'dailyLossLimit' => $this->cfg['daily_loss_limit'] ?: 0];
        $pos = fn ($v) => is_int($v) && $v > 0;
        foreach ([($this->cfg['currency_limits'][$currency] ?? null), $client['limits'] ?? null, ($client['currencyLimits'][$currency] ?? null), $info['limits'] ?? null] as $src) {      // server table, the client's settings, then what the platform sends for this player
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

    public function auth(string $token, ?string $clientHint = null): array
    {
        $clientId = $this->resolveClient($clientHint);
        $client = $this->clientCfg($clientId);
        $wallet = $this->walletFor($clientId);
        if (! $wallet) {
            throw new GameError(400, 'INVALID_CLIENT');
        }
        try {
            $info = $this->walletCall(fn () => $wallet->validateToken($token), 'validate', $clientId);
        } catch (\Throwable $e) {
            throw new GameError(401, 'INVALID_TOKEN');
        }
        if (! preg_match(self::PLAYER_ID_RE, (string) ($info['playerId'] ?? ''))) {
            throw new GameError(401, 'INVALID_PLAYER_ID');
        }
        $pk = self::pk($clientId, (string) $info['playerId']);
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
            'key' => self::skey($id), 'player_key' => $pk, 'raw_id' => (string) $info['playerId'], 'client_id' => $clientId, 'brand_id' => ! empty($info['brandId']) ? (string) $info['brandId'] : null,
            'currency' => $currency, 'decimals' => is_int($d) && $d >= 0 && $d <= 4 ? $d : 2, 'balance' => $info['balance'] ?? null, 'return_url' => $returnUrl,
            'limits' => json_encode($this->limitsFor($currency, $info, $client)), 'reality_minutes' => $rm > 0 ? (int) $rm : 0, 's_staked' => 0, 's_paid' => 0,
            'created_at' => $t, 'expires_at' => $t + $this->cfg['session_ttl_ms'], 'refreshed_at' => $t,
        ]);
        $s = DB::table('game_sessions')->where('key', self::skey($id))->first();

        return ['session' => $id, 'playerId' => (string) $info['playerId'], 'returnUrl' => $returnUrl] + $this->sessionView($s);
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
        if ($s->expires_at < $this->now() || ! $this->clientActive($s->client_id)) {          // a disabled client ends its sessions
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

    /** operator / platform: end a player's sessions (all of them) at once */
    public function closeSessions(string $playerKey): int
    {
        $n = DB::table('game_sessions')->where('player_key', $playerKey)->delete();
        if ($n) {
            $this->log(['e' => 'sessions_closed', 'playerId' => $playerKey, 'count' => $n]);
        }

        return $n;
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
                    'currency' => $s->currency, 'brand_id' => $s->brand_id, 'placed_at' => $at, 'client_id' => $s->client_id]);
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
        [$cid, $raw] = self::splitPk($playerKey);
        $wallet = $this->walletFor($cid);
        if (! $wallet) {
            throw new GameError(502, 'WALLET_UNAVAILABLE');
        }
        for ($attempt = 0; $attempt < 2; $attempt++) {
            try {
                return $this->walletCall(fn () => $wallet->debit($raw, $amount, $txId, $meta), 'debit', $cid);
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
        if ($r->status === 'void') {
            return 'results';
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

    /**
     * The parts of /api/public that only change when the round loop moves a race on (open, draw, settle): kept in the cache and dropped by bust(), so
     * thousands of browsers polling every 1.5 s cost one cache read each instead of six queries. Use a fast cache (Redis) in production.
     */
    private function publicParts(): array
    {
        return Cache::remember('horse:public-parts', 60, function () {
            $r = $this->current();
            $drawn = $r && $r->order ? $r : DB::table('rounds')->where('status', 'settled')->orderByDesc('race_no')->first();
            $round = null;
            if ($r) {
                $tb = $this->tableOf($r);
                $round = ['race_no' => (int) $r->race_no, 'status' => $r->status, 'open_at' => (int) $r->open_at, 'bet_close_at' => (int) $r->bet_close_at, 'start_at' => $r->start_at === null ? null : (int) $r->start_at,
                    'commit' => $r->commit, 'odds' => $this->odds($r), 'rtp' => (float) $r->rtp, 'cheapRtp' => $tb['cheapRtp'], 'cheapPairs' => $tb['cheap']];
            }

            return [
                'round' => $round,
                'drawn' => $drawn ? ['race_no' => (int) $drawn->race_no, 'start_at' => (int) $drawn->start_at, 'anim_seed' => (int) $drawn->anim_seed, 'order' => json_decode($drawn->order, true)] : null,
                'history' => DB::table('rounds')->where('status', 'settled')->orderByDesc('race_no')->limit(8)->get()->reverse()->values()->map(fn ($x) => ['raceNo' => (int) $x->race_no, 'order' => json_decode($x->order, true)])->all(),
                'reveals' => DB::table('rounds')->where('status', 'settled')->orderByDesc('race_no')->limit(5)->get()->reverse()->values()->map(fn ($x) => [
                    'raceNo' => (int) $x->race_no, 'seed' => $x->seed, 'commit' => $x->commit, 'combo' => $x->combo, 'order' => json_decode($x->order, true), 'odds' => $this->odds($x), 'rtp' => (float) $x->rtp])->all(),
            ];
        });
    }

    /** the round loop changed a race: the browsers must see it on their next poll */
    private function bust(): void
    {
        Cache::forget('horse:public-parts');
    }

    /** what every browser polls (GET /api/public) */
    public function publicState(): array
    {
        $t = $this->now();
        $p = $this->publicParts();
        $c = $p['round'];
        $round = null;
        if ($c) {
            $r = (object) ['status' => $c['status'], 'start_at' => $c['start_at']];
            $round = ['raceNo' => $c['race_no'], 'phase' => $this->phase($r, $t), 'openAt' => $c['open_at'], 'betCloseAt' => $c['bet_close_at'], 'startAt' => $c['start_at'], 'commit' => $c['commit'], 'odds' => $c['odds'],
                'rtp' => $c['rtp'], 'cheapRtp' => $c['cheapRtp'], 'cheapPairs' => $c['cheapPairs']];
        }
        $st = [
            'mode' => 'live', 'serverNow' => $t, 'nextRaceNo' => $c ? $c['race_no'] + ($c['status'] === 'betting' ? 0 : 1) : 1,
            'timings' => ['countdown' => $this->cfg['countdown_ms'], 'race' => $this->cfg['race_ms'], 'results' => $this->cfg['results_ms'], 'bet' => $this->cfg['bet_ms']],
            'rules' => $this->rules(), 'round' => $round, 'race' => null, 'history' => $p['history'], 'reveals' => $p['reveals'],
        ];
        if ($p['drawn']) {
            $d = $p['drawn'];
            $st['race'] = ['raceNo' => $d['race_no'], 'startAt' => $d['start_at'], 'seed' => $d['anim_seed'], 'order' => $t >= $d['start_at'] - 2000 ? $d['order'] : null];
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
                $w = $this->walletFor($s->client_id) ?? throw new \RuntimeException('no wallet');
                $bal = $this->walletCall(fn () => $w->balance($s->raw_id), 'balance', $s->client_id);
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

        [$cid, $raw] = self::splitPk($playerKey);

        return ['ok' => true, 'playerId' => $raw, 'clientId' => $cid, 'rounds' => array_slice(array_values($rounds), 0, $limit)];
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

    /* ---------- back office: audit log, races, players ---------- */

    /** back-office actions are kept in the ledger and in a short list per client */
    public function audit(string $clientId, array $entry): void
    {
        $at = $this->now();
        DB::table('audit_log')->insert(['client' => $clientId, 'at' => $at, 'entry' => json_encode($entry, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE)]);
        $this->log(['e' => 'bo_action', 'clientId' => $clientId] + $entry);
    }

    public function auditFor(string $clientId, mixed $limit = 100): array
    {
        $limit = max(1, min(500, (int) $limit ?: 100));
        $rows = DB::table('audit_log')->where('client', $clientId)->orderByDesc('id')->limit($limit)->get();

        return ['ok' => true, 'entries' => $rows->map(fn ($r) => ['at' => (int) $r->at] + json_decode($r->entry, true))->all()];
    }

    /** one line per settled race for a client: its own bets, players, staked and paid */
    public function rounds(string $clientId, mixed $limit = 50): array
    {
        $limit = max(1, min(300, (int) $limit ?: 50));
        $agg = DB::table('bets')->where('client_id', $clientId)->whereIn('status', ['won', 'lost'])->groupBy('race_no')
            ->select(['race_no', DB::raw('count(distinct player_key) as players'), DB::raw('count(*) as bets'), DB::raw('sum(stake) as staked'), DB::raw('sum(payout) as paid')]);
        $rows = DB::query()->fromSub($agg, 'a')->join('rounds', 'rounds.race_no', '=', 'a.race_no')->where('rounds.status', 'settled')->orderByDesc('a.race_no')->limit($limit)
            ->get(['a.race_no', 'a.players', 'a.bets', 'a.staked', 'a.paid', 'rounds.combo', 'rounds.order as ord', 'rounds.odds', 'rounds.settled_at']);

        return ['ok' => true, 'rounds' => $rows->map(fn ($x) => ['raceNo' => (int) $x->race_no, 'combo' => $x->combo, 'odds' => json_decode($x->odds, true)[$x->combo] ?? null, 'order' => json_decode($x->ord, true),
            'at' => (int) $x->settled_at, 'players' => (int) $x->players, 'bets' => (int) $x->bets, 'staked' => (int) $x->staked, 'paid' => (int) $x->paid])->all()];
    }

    /** the players of a client that the game knows from their bets, sessions and the block list */
    public function players(string $clientId, array $opts = []): array
    {
        $q = strtolower((string) ($opts['query'] ?? ''));
        $by = [];
        $get = function (string $pk) use (&$by) {
            return $by[$pk] ??= ['playerId' => self::splitPk($pk)[1], 'bets' => 0, 'staked' => 0, 'paid' => 0, 'lastBetAt' => null, 'online' => false, 'blocked' => false];
        };
        $match = fn (string $pk) => $q === '' || str_contains(strtolower(self::splitPk($pk)[1]), $q);
        foreach (DB::table('bets')->where('client_id', $clientId)->where('status', '!=', 'refunded')->groupBy('player_key')->selectRaw('player_key, count(*) as n, sum(stake) as s, sum(payout) as p, max(placed_at) as last')->get() as $r) {
            if ($match($r->player_key)) {
                $x = &$by[$r->player_key];
                $x = $get($r->player_key);
                $x['bets'] = (int) $r->n;
                $x['staked'] = (int) $r->s;
                $x['paid'] = (int) $r->p;
                $x['lastBetAt'] = (int) $r->last;
                unset($x);
            }
        }
        foreach ($this->ofClient(DB::table('game_sessions')->where('expires_at', '>', $this->now()), $clientId)->pluck('player_key') as $pk) {
            if ($match($pk)) {
                $by[$pk] = $get($pk);
                $by[$pk]['online'] = true;
            }
        }
        foreach ($this->ofClient(DB::table('blocked_players'), $clientId)->pluck('player_key') as $pk) {
            if ($match($pk)) {
                $by[$pk] = $get($pk);
                $by[$pk]['blocked'] = true;
            }
        }
        $all = array_values($by);
        usort($all, fn ($a, $b) => ($b['lastBetAt'] ?? 0) <=> ($a['lastBetAt'] ?? 0));

        return ['ok' => true, 'total' => count($all), 'players' => array_slice($all, 0, max(1, min(500, (int) ($opts['limit'] ?? 100) ?: 100)))];
    }

    public function playerDetail(string $clientId, string $playerId): array
    {
        $pk = $this->playerKey($clientId, $playerId);
        $h = $this->historyFor($pk, 100);
        $sessions = DB::table('game_sessions')->where('player_key', $pk)->get()->map(fn ($s) => ['since' => (int) $s->created_at, 'currency' => $s->currency, 'balance' => $s->balance === null ? null : (int) $s->balance,
            'limits' => json_decode($s->limits, true), 'staked' => (int) $s->s_staked, 'paid' => (int) $s->s_paid])->all();
        $totals = ['bets' => 0, 'staked' => 0, 'paid' => 0];
        foreach ($h['rounds'] as $r) {
            foreach ($r['bets'] as $b) {
                if ($b['status'] !== 'refunded') {
                    $totals['bets']++;
                    $totals['staked'] += $b['stake'];
                    $totals['paid'] += $b['payout'];
                }
            }
        }

        return ['ok' => true, 'playerId' => $playerId, 'clientId' => $clientId, 'blocked' => DB::table('blocked_players')->where('player_key', $pk)->exists(), 'sessions' => $sessions,
            'dailyNetLoss' => max(0, $this->dayNet($pk)), 'totals' => $totals, 'rounds' => $h['rounds']];
    }

    /** what the operator's overview and the controller show under "Health and alerts" */
    public function ops(): array
    {
        $h = $this->health();
        $tick = Cache::get('horse:tick');
        $started = Cache::get('horse:started');
        $dir = storage_path();

        $alerts = app(AlertManager::class);

        return ['role' => $h['ok'] ? 'active' : 'down', 'health' => $h, 'alerts' => $alerts->current(), 'recentAlerts' => $alerts->recent(10), 'snapshot' => $this->opsSnapshot(), 'wallet' => $this->walletWindow(300000),
            'clients' => ['count' => $this->clients ? $this->clients->count() : 0, 'error' => null], 'tickAge' => $tick === null ? null : max(0, ($this->now() - $tick) / 1000), 'lease' => null,
            'uptime' => $started ? max(0, (int) round(($this->now() - $started) / 1000)) : null, 'diskFreeMb' => (int) round((@disk_free_space($dir) ?: 0) / 1048576)];
    }

    /** the queues and the ledger, for the operator's overview and /metrics */
    public function opsSnapshot(): array
    {
        $t = $this->now();
        $q = function (string $kind) use ($t) {
            $c = DB::table('pending_ops')->where('kind', $kind);
            $min = (clone $c)->min('since');

            return ['count' => (int) $c->count(), 'oldestSeconds' => $min ? max(0, ($t - (int) $min) / 1000) : 0];
        };
        $l = $this->ledger->verify();
        $cur = $this->current();
        $st = $this->report();

        return ['round' => $cur ? (int) $cur->race_no : 0, 'rounds' => $st['rounds'], 'bets' => $st['bets'], 'byCurrency' => $st['byCurrency'], 'rtpSetting' => $this->rtp(), 'rtpActual' => $st['actualRtp'] ?? 0, 'rtpZ' => $this->rtpZ(),
            'sessions' => $st['activeSessions'], 'pending' => ['credits' => $q('credit'), 'rollbacks' => $q('rollback'), 'webhooks' => $q('webhook')],
            'ledger' => ['ok' => $l['ok'], 'lines' => $l['lines'], 'head' => $l['head'], 'broken' => $l['broken']]];
    }

    /** numbers for one client (its own client API / back office) */
    public function clientReport(string $clientId): array
    {
        $q = fn () => DB::table('bets')->where('client_id', $clientId)->whereIn('status', ['won', 'lost']);
        $staked = (int) $q()->sum('stake');
        $paid = (int) $q()->sum('payout');
        $byCurrency = [];
        foreach ($q()->selectRaw('currency, sum(stake) as s, sum(payout) as p')->groupBy('currency')->get() as $c) {
            $byCurrency[$c->currency] = ['staked' => (int) $c->s, 'paid' => (int) $c->p];
        }
        $cur = $this->current();

        return ['ok' => true, 'clientId' => $clientId, 'bets' => (int) $q()->count(), 'staked' => $staked, 'paid' => $paid, 'ggr' => $staked - $paid, 'byCurrency' => (object) $byCurrency,
            'rtp' => $staked ? $paid / $staked : null, 'activeSessions' => (int) DB::table('game_sessions')->where('client_id', $clientId)->where('expires_at', '>', $this->now())->count(),
            'pendingCredits' => (int) $this->ofClient(DB::table('pending_ops')->where('kind', 'credit'), $clientId)->count(),
            'pendingRollbacks' => (int) $this->ofClient(DB::table('pending_ops')->where('kind', 'rollback'), $clientId)->count(),
            'blockedPlayers' => (int) $this->ofClient(DB::table('blocked_players'), $clientId)->count(), 'currentRound' => $cur ? (int) $cur->race_no : null, 'rtpSetting' => $this->rtp()];
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
            'pendingWebhooks' => (int) DB::table('pending_ops')->where('kind', 'webhook')->count(), 'blockedPlayers' => (int) DB::table('blocked_players')->count(), 'byCurrency' => (object) $byCurrency, 'byClient' => (object) [],
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
