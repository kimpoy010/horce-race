<?php

namespace App\Console\Commands;

use App\Game\AlertManager;
use Illuminate\Console\Command;

/** Evaluates the alert rules once. The round loop does this every 5 seconds; this command (every minute, from the scheduler) also reports a loop that is not running at all. */
class CheckAlerts extends Command
{
    protected $signature = 'alerts:check';

    protected $description = 'Evaluate the alert rules once and send what changed';

    public function handle(AlertManager $alerts): int
    {
        $active = $alerts->evaluate();
        foreach ($active as $a) {
            $this->line(strtoupper($a['severity']).' '.$a['name'].': '.$a['message']);
        }
        $this->info(count($active) ? count($active).' alert(s) active' : 'no alerts');

        return $active ? self::FAILURE : self::SUCCESS;
    }
}
