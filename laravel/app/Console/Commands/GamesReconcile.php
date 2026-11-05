<?php

namespace App\Console\Commands;

use App\Games\Reconcile;
use Illuminate\Console\Command;

/** Compares every game's report with the ledger (Phase 5 gate: they must match). Exit code 1 when they do not. */
class GamesReconcile extends Command
{
    protected $signature = 'games:reconcile {--json : machine-readable}';

    protected $description = 'Check that each game\'s stakes, payouts and plays in the database equal what the ledger recorded';

    public function handle(Reconcile $reconcile): int
    {
        $res = $reconcile->run();
        if ($this->option('json')) {
            $this->line(json_encode($res, JSON_UNESCAPED_SLASHES));

            return $res['ok'] ? self::SUCCESS : self::FAILURE;
        }
        foreach ($res['games'] as $id => $g) {
            $this->line(($g['ok'] ? 'OK   ' : 'FAIL ').$id);
            foreach ($g['checks'] as $c) {
                $this->line(sprintf('     %s %-44s database %d, ledger %d', $c['ok'] ? 'ok  ' : 'DIFF', $c['name'], $c['db'], $c['ledger']));
            }
        }
        $res['ok'] ? $this->info('every game matches the ledger') : $this->error('the reports and the ledger differ');

        return $res['ok'] ? self::SUCCESS : self::FAILURE;
    }
}
