<?php

namespace App\Platform\Wallet;

use App\Game\GameError;
use App\Game\Wallet\Wallet;
use App\Game\Wallet\WalletException;
use App\Platform\PlayerKey;
use Closure;
use Illuminate\Support\Facades\DB;

/**
 * Everything the game does with a platform's wallet, for every game: the timed and counted call, the debit (two tries, then a rollback of a debit whose outcome is
 * unknown), the queue of credits and rollbacks still owed to the platform (table pending_ops) and its retry with back-off, and the numbers /metrics and the overview read.
 *
 * Moved out of the Engine without changing what it does (the horse-race golden baseline, tests/Feature/HorseBaselineTest.php, must stay identical). Rows of the horse
 * race have no round_ref and game_id 'horse-race'; a game that has no race number (an instant round) queues its credits and rollbacks with its game id and a round_ref.
 */
final class WalletGateway
{
    public const HORSE_RACE = 'horse-race';

    /**
     * @param  Closure(): int  $now  the clock in milliseconds
     * @param  Closure(array): void  $log  writes a line to the ledger (the "t" time is added by the caller's closure)
     * @param  Closure(string): ?Wallet  $walletFor  the wallet of a client
     */
    public function __construct(private Closure $now, private Closure $log, private Closure $walletFor) {}

    private function now(): int
    {
        return ($this->now)();
    }

    private function log(array $ev): void
    {
        ($this->log)($ev);
    }

    private function walletFor(string $clientId): ?Wallet
    {
        return ($this->walletFor)($clientId);
    }

    private static function isHorse(?string $gameId): bool
    {
        return $gameId === null || $gameId === self::HORSE_RACE;
    }

    /* ---------- the queue of credits and rollbacks that still have to reach the platform ---------- */

    /**
     * @param  int|null  $raceNo  the race of the horse race (null for a game without one)
     * @param  string|null  $gameId  null or 'horse-race' for the horse race
     * @param  string|null  $roundRef  the round of a game that has no race number
     */
    public function queueCredit(string $txId, string $playerKey, int $amount, ?int $raceNo, string $kind, array $extra = [], ?string $gameId = null, ?string $roundRef = null): void
    {
        if ($amount <= 0 || DB::table('pending_ops')->where('tx_id', $txId)->exists()) {
            return;
        }
        if (self::isHorse($gameId)) {
            $this->log(['e' => 'credit_due', 'txId' => $txId, 'playerId' => $playerKey, 'amount' => $amount, 'raceNo' => $raceNo, 'kind' => $kind, 'extra' => $extra ?: new \stdClass]);
            DB::table('pending_ops')->insert(['tx_id' => $txId, 'kind' => 'credit', 'player_key' => $playerKey, 'amount' => $amount, 'race_no' => $raceNo, 'tx_kind' => $kind,
                'extra' => json_encode($extra ?: new \stdClass), 'since' => $this->now(), 'tries' => 0, 'next_at' => 0]);

            return;
        }
        $this->log(['e' => 'credit_due', 'game' => $gameId, 'txId' => $txId, 'playerId' => $playerKey, 'amount' => $amount, 'roundRef' => $roundRef, 'kind' => $kind, 'extra' => $extra ?: new \stdClass]);
        DB::table('pending_ops')->insert(['tx_id' => $txId, 'kind' => 'credit', 'player_key' => $playerKey, 'amount' => $amount, 'race_no' => null, 'tx_kind' => $kind,
            'extra' => json_encode($extra ?: new \stdClass), 'since' => $this->now(), 'tries' => 0, 'next_at' => 0, 'game_id' => $gameId, 'round_ref' => $roundRef]);
    }

    /** a debit that timed out twice may or may not have been applied: ask the wallet to cancel it (and refuse it if it arrives late) */
    public function queueRollback(string $txId, string $playerKey, int $amount, array $meta): void
    {
        if (DB::table('pending_ops')->where('tx_id', 'rb:'.$txId)->exists()) {
            return;
        }
        $extra = array_filter(['currency' => $meta['currency'] ?? null, 'brandId' => $meta['brandId'] ?? null, 'betId' => $meta['betId'] ?? null, 'betIds' => $meta['betIds'] ?? null], fn ($v) => $v !== null);
        $gameId = $meta['gameId'] ?? null;
        if (self::isHorse($gameId)) {
            $this->log(['e' => 'rollback_due', 'txId' => $txId, 'playerId' => $playerKey, 'amount' => $amount, 'raceNo' => $meta['raceNo'] ?? null, 'extra' => $extra ?: new \stdClass]);
            DB::table('pending_ops')->insert(['tx_id' => 'rb:'.$txId, 'kind' => 'rollback', 'player_key' => $playerKey, 'amount' => $amount, 'race_no' => $meta['raceNo'] ?? null,
                'extra' => json_encode($extra ?: new \stdClass), 'since' => $this->now(), 'tries' => 0, 'next_at' => 0]);

            return;
        }
        $this->log(['e' => 'rollback_due', 'game' => $gameId, 'txId' => $txId, 'playerId' => $playerKey, 'amount' => $amount, 'roundRef' => $meta['roundRef'] ?? null, 'extra' => $extra ?: new \stdClass]);
        DB::table('pending_ops')->insert(['tx_id' => 'rb:'.$txId, 'kind' => 'rollback', 'player_key' => $playerKey, 'amount' => $amount, 'race_no' => null,
            'extra' => json_encode($extra ?: new \stdClass), 'since' => $this->now(), 'tries' => 0, 'next_at' => 0, 'game_id' => $gameId, 'round_ref' => $meta['roundRef'] ?? null]);
    }

    /** the next try of a queued operation: 2 s, 4 s, 8 s ... at most 60 s later */
    public function backoff(object $p, int $t): void
    {
        $tries = $p->tries + 1;
        DB::table('pending_ops')->where('tx_id', $p->tx_id)->update(['tries' => $tries, 'next_at' => $t + min(60000, 1000 * (2 ** min($tries, 6)))]);
    }

    /** what a queued row says about its round, for the wallet call and the ledger: the race number of the horse race, or the game and round of another game */
    private function roundMeta(object $p): array
    {
        return ($p->round_ref ?? null) === null ? ['raceNo' => $p->race_no, 'roundId' => (string) $p->race_no] : ['roundId' => $p->round_ref, 'gameId' => $p->game_id ?? self::HORSE_RACE];
    }

    public function flushCredits(): void
    {
        $t = $this->now();
        foreach (DB::table('pending_ops')->where('kind', 'credit')->where('next_at', '<=', $t)->orderBy('since')->limit(200)->get() as $p) {
            try {
                $extra = json_decode($p->extra ?? '{}', true) ?: [];
                [$cid, $raw] = PlayerKey::split($p->player_key);
                $w = $this->walletFor($cid) ?? throw new \RuntimeException('no wallet for client '.$cid);
                $res = $this->call(fn () => $w->credit($raw, $p->amount, $p->tx_id, $this->roundMeta($p) + ['kind' => $p->tx_kind] + $extra), 'credit', $cid);
                DB::table('pending_ops')->where('tx_id', $p->tx_id)->delete();
                $this->log(($p->round_ref ?? null) === null ? ['e' => 'credit_ok', 'txId' => $p->tx_id, 'raceNo' => $p->race_no] : ['e' => 'credit_ok', 'game' => $p->game_id, 'txId' => $p->tx_id, 'roundRef' => $p->round_ref]);
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
                [$cid, $raw] = PlayerKey::split($p->player_key);
                $w = $this->walletFor($cid) ?? throw new \RuntimeException('no wallet for client '.$cid);
                $res = $this->call(fn () => $w->rollback($raw, $p->amount, $orig, $this->roundMeta($p) + ['kind' => 'rollback', 'refTxId' => $orig] + $extra), 'rollback', $cid);
                DB::table('pending_ops')->where('tx_id', $p->tx_id)->delete();
                $this->log(['e' => 'rollback_ok', 'txId' => $orig, 'status' => $res['status'] ?? null] + (($p->round_ref ?? null) === null ? [] : ['game' => $p->game_id]));
                if (isset($res['balance'])) {
                    DB::table('game_sessions')->where('player_key', $p->player_key)->update(['balance' => $res['balance']]);
                }
            } catch (WalletException $e) {
                if ($e->unsupported) {                      // the platform has no rollback: reconcile by hand
                    DB::table('pending_ops')->where('tx_id', $p->tx_id)->delete();
                    $this->log(['e' => 'rollback_unsupported', 'txId' => $orig] + (($p->round_ref ?? null) === null ? [] : ['game' => $p->game_id]));

                    continue;
                }
                $this->backoff($p, $t);
            } catch (\Throwable $e) {
                $this->backoff($p, $t);
            }
        }
    }

    /* ---------- the debit ---------- */

    /**
     * Takes the stake from the player's wallet. Two tries with the same transaction id (the wallet is idempotent); when neither gets an answer the outcome is
     * unknown, so a rollback is queued and the caller gets WALLET_UNAVAILABLE. A refusal is an answer: INSUFFICIENT_FUNDS (402) or WALLET_REJECTED (502).
     *
     * @return array the wallet's answer (it has the new "balance")
     *
     * @throws GameError
     */
    public function debit(string $playerKey, int $amount, string $txId, array $meta): array
    {
        [$cid, $raw] = PlayerKey::split($playerKey);
        $wallet = $this->walletFor($cid);
        if (! $wallet) {
            throw new GameError(502, 'WALLET_UNAVAILABLE');
        }
        for ($attempt = 0; $attempt < 2; $attempt++) {
            try {
                return $this->call(fn () => $wallet->debit($raw, $amount, $txId, $meta), 'debit', $cid);
            } catch (WalletException $e) {
                if ($e->getMessage() === 'INSUFFICIENT_FUNDS') {
                    throw new GameError(402, 'INSUFFICIENT_FUNDS');
                }
                if ($e->definitive) {
                    throw new GameError(502, 'WALLET_REJECTED');
                }
                if ($attempt === 1) {
                    $this->log(['e' => 'debit_unknown', 'playerId' => $playerKey, 'amount' => $amount, 'txId' => $txId] + (self::isHorse($meta['gameId'] ?? null) ? [] : ['game' => $meta['gameId']]));
                    $this->queueRollback($txId, $playerKey, $amount, $meta);
                    throw new GameError(502, 'WALLET_UNAVAILABLE');
                }
                usleep(250000);                          // the same txId again: the wallet is idempotent
            }
        }
        throw new GameError(502, 'WALLET_UNAVAILABLE');
    }

    /* ---------- timing and counting ---------- */

    /** every wallet call goes through here: timing and failures feed the overview and /metrics. A normal refusal is an answer; no answer, a server error or a rejected signature is a failure. */
    public function call(Closure $fn, string $op = 'call', string $clientId = 'default'): mixed
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
                $this->countCall($clientId, $op, $ms, $ok);
            } catch (\Throwable $e) {
                // metrics must never break a bet
            }
        }
    }

    /** running totals for /metrics (counters only go up, so they are kept apart from the hour of detailed calls) */
    private function countCall(string $clientId, string $op, int $ms, bool $ok): void
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
    public function window(int $windowMs, ?string $client = null): array
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
}
