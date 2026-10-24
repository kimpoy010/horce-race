<?php

namespace App\Console\Commands;

use App\Game\Ledger;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;

/**
 * The audit ledger from the command line.
 *   php artisan ledger verify                 checks the hash chain (exit code 0 = intact, 1 = broken)
 *   php artisan ledger export <file>          writes the lines as ledger.jsonl, the Node server's file format (an audit copy, or to go back to Node)
 */
class LedgerCommand extends Command
{
    protected $signature = 'ledger {action : verify|export} {file?}';

    protected $description = 'Verify the audit ledger hash chain or export it as ledger.jsonl';

    public function handle(Ledger $ledger): int
    {
        if ($this->argument('action') === 'verify') {
            $r = $ledger->verify();
            $this->line('lines: '.$r['lines'].' ('.$r['chained'].' chained, '.$r['legacy'].' from before the chain started)');
            if ($r['ok']) {
                $this->info('INTACT, head hash '.$r['head']);

                return self::SUCCESS;
            }
            $this->error('BROKEN at line '.$r['broken']['line'].': '.$r['broken']['reason']);

            return self::FAILURE;
        }
        if ($this->argument('action') !== 'export' || ! $this->argument('file')) {
            $this->error('usage: ledger verify | ledger export <file>');

            return self::FAILURE;
        }
        $r = $ledger->verify();
        if (! $r['ok']) {
            $this->error('the ledger is broken at line '.$r['broken']['line'].'; not exporting a broken chain');

            return self::FAILURE;
        }
        $f = fopen((string) $this->argument('file'), 'w');
        DB::table('ledger')->orderBy('seq')->chunk(2000, function ($rows) use ($f) {
            foreach ($rows as $row) {
                fwrite($f, $row->line."\n");
            }
        });
        fclose($f);
        $this->info($r['lines'].' lines written, head '.$r['head'].' (check with: node scripts/verify-ledger.js '.$this->argument('file').')');

        return self::SUCCESS;
    }
}
