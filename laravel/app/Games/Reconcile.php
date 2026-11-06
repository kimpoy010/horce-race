<?php

namespace App\Games;

use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * Checks each game's report (what the consoles and /metrics show, read from the database) against the hash-chained ledger (what was written as it happened).
 * They are two records of the same money; any difference is a bug or tampering and must be explained before the game is certified or paid out on.
 * Reads the whole ledger in pieces: meant for the command (`php artisan games:reconcile`), not for a web request.
 */
final class Reconcile
{
    /** @return array{ok:bool,games:array<string,array{ok:bool,checks:list<array{name:string,db:int,ledger:int,ok:bool}>}>} */
    public function run(): array
    {
        $horse = ['settled' => 0, 'staked' => 0, 'paid' => 0];
        $bp = ['plays' => [], 'settled' => [], 'credits' => 0, 'voided' => []];
        $b16 = ['plays' => [], 'settled' => [], 'jackpotPaid' => 0, 'credits' => 0, 'add' => 0, 'win' => 0, 'seed' => 0];
        $fr = ['plays' => [], 'settled' => [], 'voided' => [], 'doubles' => 0, 'credits' => 0];
        DB::table('ledger')->orderBy('seq')->chunkById(5000, function ($rows) use (&$horse, &$bp, &$b16, &$fr) {
            foreach ($rows as $row) {
                $ev = json_decode($row->line, true);
                switch ($ev['e'] ?? '') {
                    case 'settled':
                        $horse['settled']++;
                        $horse['staked'] += (int) $ev['staked'];
                        $horse['paid'] += (int) $ev['paid'];
                        break;
                    case 'bp.play':
                        $bp['plays'][$ev['roundId']] = (int) $ev['stake'];
                        break;
                    case 'bp.settled':
                        $bp['settled'][$ev['roundId']] = (int) $ev['payout'];
                        break;
                    case 'bp.void':
                        $bp['voided'][$ev['roundId']] = true;
                        break;
                    case 'b16.play':
                        $b16['plays'][$ev['roundId']] = (int) $ev['stake'];
                        break;
                    case 'b16.settled':
                        $b16['settled'][$ev['roundId']] = (int) $ev['payout'];
                        $b16['jackpotPaid'] += (int) $ev['jackpotPaid'];
                        break;
                    case 'fr.play':
                        $fr['plays'][$ev['roundId']] = (int) $ev['stake'];
                        break;
                    case 'fr.double':
                        $fr['doubles']++;
                        break;
                    case 'fr.settled':
                        $fr['settled'][$ev['roundId']] = (int) $ev['payout'];
                        break;
                    case 'fr.void':
                        $fr['voided'][$ev['roundId']] = true;
                        break;
                    case 'jackpot.add':
                        $b16['add'] += (int) $ev['amount'];
                        break;
                    case 'jackpot.win':
                        $b16['win'] += (int) $ev['amount'];
                        break;
                    case 'jackpot.seed':
                        $b16['seed'] += (int) $ev['amount'];
                        break;
                    case 'credit_due':
                        if (($ev['game'] ?? null) === GameReports::BINGO16 && str_ends_with((string) $ev['txId'], ':win')) {
                            $b16['credits'] += (int) $ev['amount'];
                        }
                        if (($ev['game'] ?? null) === GameReports::FRUIT && (str_ends_with((string) $ev['txId'], ':win') || str_contains((string) $ev['txId'], ':take'))) {
                            $fr['credits'] += (int) $ev['amount'];
                        }
                        if (($ev['game'] ?? null) === GameReports::BINGO && str_ends_with((string) $ev['txId'], ':win')) {
                            $bp['credits'] += (int) $ev['amount'];
                        }
                        break;
                }
            }
        }, 'seq');

        $rounds = DB::table('rounds')->where('status', 'settled');
        $bets = fn () => DB::table('bets')->whereIn('status', ['won', 'lost']);
        $settled = DB::table('instant_rounds')->where('game_id', GameReports::BINGO)->where('status', 'settled');
        $bpStake = 0;
        foreach ($bp['settled'] as $ref => $pay) {
            $bpStake += $bp['plays'][$ref] ?? 0;
        }

        $settled16 = DB::table('instant_rounds')->where('game_id', GameReports::BINGO16)->where('status', 'settled');
        $b16Stake = 0;
        foreach ($b16['settled'] as $ref => $pay) {
            $b16Stake += $b16['plays'][$ref] ?? 0;
        }
        $settledF = DB::table('instant_rounds')->where('game_id', GameReports::FRUIT)->where('status', 'settled');
        $openF = DB::table('instant_rounds')->where('game_id', GameReports::FRUIT)->where('status', 'open')->count();
        $frStake = 0;
        foreach ($fr['settled'] as $ref => $pay) {
            $frStake += $fr['plays'][$ref] ?? 0;
        }
        $frOpenLedger = count(array_diff_key($fr['plays'], $fr['settled'], $fr['voided']));         // spins that have a stake line but no settlement and no void: the wins still held
        $frDoubles = Schema::hasColumn('instant_rounds', 'doubles') ? (int) DB::table('instant_rounds')->where('game_id', GameReports::FRUIT)->sum('doubles') : $fr['doubles'];
        $pools = Schema::hasTable('jackpot_pools') ? DB::table('jackpot_pools')->where('game_id', GameReports::BINGO16)->get() : collect();
        $unbalanced = $pools->filter(fn ($p) => (int) $p->amount !== (int) $p->seeded + (int) $p->contributed - (int) $p->paid)->count();

        $games = [
            GameReports::HORSE => ['checks' => [
                self::check('settled races', (int) (clone $rounds)->count(), $horse['settled']),
                self::check('staked in settled races (rounds)', (int) (clone $rounds)->sum('staked'), $horse['staked']),
                self::check('paid in settled races (rounds)', (int) (clone $rounds)->sum('paid'), $horse['paid']),
                self::check('staked (bets)', (int) $bets()->sum('stake'), $horse['staked']),
                self::check('paid (bets)', (int) $bets()->sum('payout'), $horse['paid']),
            ]],
            GameReports::BINGO => ['checks' => [
                self::check('settled plays', (int) (clone $settled)->count(), count($bp['settled'])),
                self::check('staked', (int) (clone $settled)->sum('stake'), $bpStake),
                self::check('paid', (int) (clone $settled)->sum('payout'), array_sum($bp['settled'])),
                self::check('wins queued for the wallet (credit_due)', (int) (clone $settled)->sum('payout'), $bp['credits']),
                self::check('plays settled without a stake line', 0, count(array_diff_key($bp['settled'], $bp['plays']))),
            ]],
            GameReports::BINGO16 => ['checks' => [
                self::check('settled plays', (int) (clone $settled16)->count(), count($b16['settled'])),
                self::check('staked', (int) (clone $settled16)->sum('stake'), $b16Stake),
                self::check('paid (pattern pays and jackpots)', (int) (clone $settled16)->sum('payout'), array_sum($b16['settled'])),
                self::check('jackpots paid (plays) against the ledger', (int) (clone $settled16)->sum('jackpot_paid'), $b16['jackpotPaid']),
                self::check('wins queued for the wallet (credit_due)', (int) (clone $settled16)->sum('payout'), $b16['credits']),
                self::check('jackpot contributions (pool) against the ledger', (int) $pools->sum('contributed'), $b16['add']),
                self::check('jackpots paid (pool) against the ledger', (int) $pools->sum('paid'), $b16['win']),
                self::check('jackpots paid (pool) against the plays', (int) $pools->sum('paid'), (int) (clone $settled16)->sum('jackpot_paid')),
                self::check('seed money (pool) against the ledger', (int) $pools->sum('seeded'), $b16['seed']),
                self::check('pools that do not balance (pool = seed money + contributions - jackpots paid)', 0, $unbalanced),
                self::check('plays settled without a stake line', 0, count(array_diff_key($b16['settled'], $b16['plays']))),
            ]],
            GameReports::FRUIT => ['checks' => [
                self::check('settled plays', (int) (clone $settledF)->count(), count($fr['settled'])),
                self::check('staked', (int) (clone $settledF)->sum('stake'), $frStake),
                self::check('paid (after double-ups)', (int) (clone $settledF)->sum('payout'), array_sum($fr['settled'])),
                self::check('wins queued for the wallet (credit_due)', (int) (clone $settledF)->sum('payout'), $fr['credits']),
                self::check('wins held (open rounds) against the ledger', (int) $openF, $frOpenLedger),
                self::check('double-ups (rounds) against the ledger', $frDoubles, $fr['doubles']),
                self::check('plays settled without a stake line', 0, count(array_diff_key($fr['settled'], $fr['plays']))),
            ]],
        ];
        $all = true;
        foreach ($games as &$g) {
            $g['ok'] = ! in_array(false, array_column($g['checks'], 'ok'), true);
            $all = $all && $g['ok'];
        }

        return ['ok' => $all, 'games' => $games];
    }

    private static function check(string $name, int $db, int $ledger): array
    {
        return ['name' => $name, 'db' => $db, 'ledger' => $ledger, 'ok' => $db === $ledger];
    }
}
