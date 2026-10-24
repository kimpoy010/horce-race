<?php

namespace App\Console\Commands;

use App\Game\Engine;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\Cache;

/**
 * The round loop: the only process that moves rounds forward (opens betting, draws, settles, delivers queued wallet calls).
 * Run exactly one of them (a second one waits as a standby: it takes over when the lock is free). Keep it alive with
 * Supervisor / systemd; on SIGTERM it finishes the current tick and releases the lock.
 *
 *   php artisan game:run
 */
class RunGame extends Command
{
    protected $signature = 'game:run {--once : run a single tick and stop (for tests and cron-style setups)}';

    protected $description = 'Run the horse race round loop (open betting, draw, settle, deliver wallet calls)';

    private bool $stop = false;

    public function handle(Engine $engine): int
    {
        $ttl = (int) config('horse.lock_ttl_seconds');
        $lock = Cache::lock('horse:game-loop', $ttl);
        if ($this->option('once')) {
            $engine->tick();

            return self::SUCCESS;
        }
        if (function_exists('pcntl_async_signals')) {
            pcntl_async_signals(true);
            foreach ([SIGTERM, SIGINT] as $sig) {
                pcntl_signal($sig, fn () => $this->stop = true);
            }
        }
        $this->info('game:run: waiting for the round-loop lock');
        while (! $this->stop && ! $lock->get()) {
            usleep(1000000);
        }
        if ($this->stop) {
            return self::SUCCESS;
        }
        $this->info('game:run: running (tick every '.config('horse.tick_ms').' ms)');
        $every = max(50, (int) config('horse.tick_ms')) * 1000;
        $renewAt = 0;
        while (! $this->stop) {
            $t0 = microtime(true);
            try {
                if ($t0 >= $renewAt) {                       // keep the lock; losing it means somebody else runs the game: stop at once
                    if (! $lock->get()) {
                        $this->error('game:run: the lock was lost, stopping');

                        return self::FAILURE;
                    }
                    $renewAt = $t0 + $ttl / 3;
                }
                $engine->tick();
            } catch (\Throwable $e) {
                $this->error('tick failed: '.$e->getMessage());
                report($e);
            }
            $left = $every - (int) ((microtime(true) - $t0) * 1000000);
            if ($left > 0) {
                usleep($left);
            }
        }
        $lock->release();
        $this->info('game:run: stopped');

        return self::SUCCESS;
    }
}
