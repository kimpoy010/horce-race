<?php

namespace App\Console\Commands;

use App\Games\BingoPinball\CertPack;
use Illuminate\Console\Command;

/** Writes the certification pack for the testing lab, or checks a pack against the installed code. */
class BingoCertPack extends Command
{
    protected $signature = 'bingo:cert-pack {--out= : the folder to write the pack into (default storage/app/bingo-cert-pack)} {--verify= : check this pack against itself and against the installed code instead}';

    protected $description = 'Bingo Pinball: write the certification pack (rules, PAR sheets, RNG description, verifiers, source, hashes) or verify a pack against the installed code';

    public function handle(): int
    {
        $pack = new CertPack(base_path());
        if ($dir = $this->option('verify')) {
            $problems = $pack->verify(rtrim($dir, '/'));
            foreach ($problems as $p) {
                $this->error($p);
            }
            $problems ? $this->error(count($problems).' problem(s): the installed code is NOT the certified code') : $this->info('OK: the pack is intact and the installed source and browser build are the certified ones');

            return $problems ? self::FAILURE : self::SUCCESS;
        }
        $dir = rtrim($this->option('out') ?: storage_path('app/bingo-cert-pack'), '/');
        $m = $pack->build($dir);
        $this->info('pack written to '.$dir);
        $this->line('commit '.($m['commit'] ?? 'unknown').($m['workingTreeClean'] ? '' : ' (working tree NOT clean: do not certify this)'));
        $this->line(count($m['source']).' source files, '.count($m['browserBuild']).' browser build files, '.count($m['paytables']).' paytables');

        return self::SUCCESS;
    }
}
