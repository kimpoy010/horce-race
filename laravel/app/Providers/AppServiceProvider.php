<?php

namespace App\Providers;

use App\Game\Engine;
use App\Game\Ledger;
use App\Game\Wallet\HttpWallet;
use App\Game\Wallet\MockWallet;
use App\Game\Wallet\Wallet;
use Illuminate\Support\ServiceProvider;

class AppServiceProvider extends ServiceProvider
{
    /**
     * Register any application services.
     */
    public function register(): void
    {
        $this->app->singleton(Wallet::class, function () {
            $c = config('horse');
            if ($c['wallet'] === 'http') {
                if (! $c['wallet_url'] || strlen((string) $c['wallet_key']) < 16) {
                    throw new \RuntimeException('HORSE_WALLET=http needs HORSE_WALLET_URL and HORSE_WALLET_KEY (at least 16 random characters: openssl rand -hex 32)');
                }

                return new HttpWallet($c['wallet_url'], $c['wallet_key'], $c['wallet_key_id'], $c['wallet_auth'], $c['wallet_timeout_ms'], $c['currency'], $c['game_id']);
            }
            if ($this->app->environment('production')) {
                throw new \RuntimeException('The mock wallet gives free play money and is not allowed in production: set HORSE_WALLET=http.');
            }

            return new MockWallet($c['mock_start_balance'], $c['currency']);
        });
        $this->app->singleton(Ledger::class);
        $this->app->singleton(Engine::class, fn ($app) => new Engine($app->make(Wallet::class), $app->make(Ledger::class), config('horse')));
    }

    /**
     * Bootstrap any application services.
     */
    public function boot(): void
    {
        //
    }
}
