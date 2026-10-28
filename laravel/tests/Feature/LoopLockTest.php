<?php

namespace Tests\Feature;

use App\Game\LoopLock;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\Cache;
use PHPUnit\Framework\Attributes\DataProvider;
use Tests\TestCase;

class LoopLockTest extends TestCase
{
    use RefreshDatabase;

    #[DataProvider('stores')]
    public function test_one_owner_at_a_time_and_the_owner_can_renew_on_every_store(string $store): void
    {
        config(['cache.default' => $store]);
        Cache::flush();
        $a = new LoopLock('horse:test-loop', 10);
        $b = new LoopLock('horse:test-loop', 10);
        $this->assertTrue($a->acquire());
        $this->assertFalse($b->acquire(), 'a second loop waits');
        $this->assertTrue($a->renew(), 'the owner keeps it (the Redis store refuses a second get() of its own lock)');
        $this->assertTrue($a->renew());
        $this->assertFalse($b->renew(), 'a non-owner cannot renew');
        Carbon::setTestNow(Carbon::now()->addSeconds(11));                 // the owner died: the lock frees itself
        $this->assertTrue($b->acquire());
        $this->assertFalse($a->renew(), 'the old owner finds out it lost the lock');
        $b->release();
        $this->assertTrue($a->acquire(), 'released at once');
        Carbon::setTestNow();
    }

    public static function stores(): array
    {
        return ['array' => ['array'], 'database' => ['database'], 'file' => ['file']];
    }
}
