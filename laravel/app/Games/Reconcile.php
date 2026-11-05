<?php

namespace App\Games;

use Illuminate\Support\Facades\DB;

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
        DB::table('ledger')->orderBy('seq')->chunkById(5000, function ($rows) use (&$horse, &$bp) {
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
                    case 'credit_due':
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
