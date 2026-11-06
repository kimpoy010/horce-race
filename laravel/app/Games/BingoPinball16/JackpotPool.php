<?php

namespace App\Games\BingoPinball16;

use App\Platform\Ledger\Journal;
use Closure;
use Illuminate\Support\Facades\DB;

/**
 * The progressive jackpot of Bingo Pinball 16: ONE pool for the whole server per currency (this release: PHP only). Every play adds a share of its stake; a play that lights all
 * five jackpot numbers wins the whole pool; the pool then restarts from the seed, which the operator pays. Everything happens inside the play's own database transaction, with
 * the pool row locked, so two plays can never win the same pool and a failed play leaves the pool as it was. Every change is a line of the hash-chained ledger.
 */
final class JackpotPool
{
    /** @param Closure(): int $now the clock in milliseconds  @param array{contribution_bp:int, seed:int, currencies:list<string>} $settings */
    public function __construct(private Journal $journal, private Closure $now, private array $settings) {}

    public function enabledFor(string $currency): bool
    {
        return in_array($currency, $this->settings['currencies'], true);
    }

    private function id(string $currency): string
    {
        return Rules::ID.':'.$currency;
    }

    /** the contribution of a stake: a share in basis points, rounded down to a minor unit */
    public function contributionOf(int $stake): int
    {
        return intdiv($stake * (int) $this->settings['contribution_bp'], 10000);
    }

    /** the pool as the players see it (null when the currency has no jackpot); creates it with its seed the first time */
    public function view(string $currency): ?array
    {
        if (! $this->enabledFor($currency)) {
            return null;
        }
        $p = DB::table('jackpot_pools')->where('id', $this->id($currency))->first() ?? $this->create($currency);

        return ['amount' => (int) $p->amount, 'currency' => $currency, 'wins' => (int) $p->wins, 'contributionBp' => (int) $this->settings['contribution_bp']];
    }

    private function create(string $currency): object
    {
        $seed = (int) $this->settings['seed'];
        $t = ($this->now)();
        DB::table('jackpot_pools')->insertOrIgnore(['id' => $this->id($currency), 'game_id' => Rules::ID, 'currency' => $currency, 'amount' => $seed, 'seed' => $seed, 'seeded' => $seed, 'updated_at' => $t]);
        $this->journal->log(['e' => 'jackpot.seed', 'pool' => $this->id($currency), 'amount' => $seed, 'reason' => 'start'], Rules::ID);

        return DB::table('jackpot_pools')->where('id', $this->id($currency))->first();
    }

    /**
     * Adds the stake's contribution and, when the jackpot was lit, pays the pool out. Call inside the play's transaction.
     *
     * @return array{contribution:int, paid:int, poolBefore:int, poolAfter:int}
     */
    public function settle(string $roundRef, int $stake, string $currency, bool $jackpotLit): array
    {
        if (! $this->enabledFor($currency)) {
            return ['contribution' => 0, 'paid' => 0, 'poolBefore' => 0, 'poolAfter' => 0];
        }
        $id = $this->id($currency);
        $this->view($currency);                                                    // make sure it exists
        $p = DB::table('jackpot_pools')->where('id', $id)->lockForUpdate()->first();
        $contribution = $this->contributionOf($stake);
        $before = (int) $p->amount;
        $level = $before + $contribution;
        $t = ($this->now)();
        if (! $jackpotLit) {
            DB::table('jackpot_pools')->where('id', $id)->update(['amount' => $level, 'contributed' => (int) $p->contributed + $contribution, 'updated_at' => $t]);
            if ($contribution > 0) {
                $this->journal->log(['e' => 'jackpot.add', 'pool' => $id, 'roundId' => $roundRef, 'amount' => $contribution, 'poolAfter' => $level], Rules::ID);
            }

            return ['contribution' => $contribution, 'paid' => 0, 'poolBefore' => $before, 'poolAfter' => $level];
        }
        $seed = (int) $p->seed;                                                    // the whole pool is won; it restarts from the seed
        DB::table('jackpot_pools')->where('id', $id)->update(['amount' => $seed, 'contributed' => (int) $p->contributed + $contribution, 'paid' => (int) $p->paid + $level, 'seeded' => (int) $p->seeded + $seed,
            'wins' => (int) $p->wins + 1, 'last_win_at' => $t, 'updated_at' => $t]);
        $this->journal->log(['e' => 'jackpot.add', 'pool' => $id, 'roundId' => $roundRef, 'amount' => $contribution, 'poolAfter' => $level], Rules::ID);
        $this->journal->log(['e' => 'jackpot.win', 'pool' => $id, 'roundId' => $roundRef, 'amount' => $level], Rules::ID);
        $this->journal->log(['e' => 'jackpot.seed', 'pool' => $id, 'amount' => $seed, 'reason' => 'after_win', 'roundId' => $roundRef], Rules::ID);

        return ['contribution' => $contribution, 'paid' => $level, 'poolBefore' => $before, 'poolAfter' => $seed];
    }
}
