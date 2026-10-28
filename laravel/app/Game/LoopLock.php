<?php

namespace App\Game;

use Illuminate\Support\Facades\Cache;

/**
 * The one-round-loop-per-database lock. Laravel's Cache::lock() cannot be renewed by its owner on every store (a second get() on the Redis store
 * fails even for the owner), so this keeps an owner token under a key that expires after $ttl seconds: acquire() takes it when free, renew()
 * pushes the expiry while it is still ours, release() gives it up. A crashed loop frees the lock by itself after $ttl seconds.
 */
final class LoopLock
{
    private string $owner;

    public function __construct(private string $key, private int $ttl)
    {
        $this->owner = bin2hex(random_bytes(8));
    }

    public function acquire(): bool
    {
        return Cache::add($this->key, $this->owner, $this->ttl);
    }

    /** true while the lock is still ours (and extends it) */
    public function renew(): bool
    {
        if (Cache::get($this->key) !== $this->owner) {
            return false;
        }
        Cache::put($this->key, $this->owner, $this->ttl);

        return true;
    }

    public function release(): void
    {
        if (Cache::get($this->key) === $this->owner) {
            Cache::forget($this->key);
        }
    }
}
