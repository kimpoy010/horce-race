<?php

namespace App\Providers;

use App\Game\AlertManager;
use App\Game\Clients\ClientRegistry;
use App\Game\Engine;
use App\Game\House\House;
use App\Game\House\PlayerApi;
use App\Game\Staff\AdminRoutes;
use App\Game\Staff\BackOffice;
use App\Game\Staff\UserStore;
use App\Game\Ledger;
use App\Games\BingoPinball\BingoPinballService;
use App\Games\BingoPinball16\Bingo16Service;
use App\Games\BingoPinball16\JackpotPool;
use App\Games\BingoPinball16\Rules as Rules16;
use App\Games\BingoPinball\SeedService;
use App\Platform\Games\Games;
use App\Game\Wallet\HttpWallet;
use App\Game\Wallet\MockWallet;
use App\Game\Wallet\Wallet;
use App\Game\Webhook;
use Illuminate\Support\ServiceProvider;

class AppServiceProvider extends ServiceProvider
{
    /**
     * Register any application services.
     */
    public function register(): void
    {
        // the implicit "default" client's wallet (null with HORSE_WALLET=none: registry clients only)
        $this->app->singleton('horse.default_wallet', function (): ?Wallet {
            $c = config('horse');
            if ($c['wallet'] === 'none') {
                return null;
            }
            if ($c['wallet'] === 'http') {
                if (! $c['wallet_url'] || strlen((string) $c['wallet_key']) < 16) {
                    throw new \RuntimeException('HORSE_WALLET=http needs HORSE_WALLET_URL and HORSE_WALLET_KEY (at least 16 random characters: openssl rand -hex 32)');
                }

                return new HttpWallet($c['wallet_url'], $c['wallet_key'], $c['wallet_key_id'], $c['wallet_auth'], $c['wallet_timeout_ms'], $c['currency'], $c['game_id']);
            }
            if ($this->app->environment('production')) {
                throw new \RuntimeException('The mock wallet gives free play money and is not allowed in production: set HORSE_WALLET=http (or none).');
            }

            return new MockWallet($c['mock_start_balance'], $c['currency']);
        });
        $this->app->singleton('horse.default_webhook', function (): ?Webhook {
            $c = config('horse');
            if (! $c['webhook_url']) {
                return null;
            }
            $key = $c['webhook_key'] ?: $c['wallet_key'];
            if (strlen((string) $key) < 16) {
                throw new \RuntimeException('HORSE_WEBHOOK_URL needs HORSE_WEBHOOK_KEY (or HORSE_WALLET_KEY), at least 16 characters');
            }

            return new Webhook($c['webhook_url'], $key, (string) ($c['webhook_key_id'] ?: $c['wallet_key_id']), $c['webhook_events']);
        });
        $this->app->singleton(ClientRegistry::class, function () {
            $mock = config('horse.allow_mock_wallet') && ! $this->app->environment('production');

            return new ClientRegistry((string) config('horse.clients_key'), $mock, (bool) config('horse.allow_http_wallet'));
        });
        $this->app->singleton(UserStore::class, fn () => new UserStore((string) config('horse.clients_key'), null, (array) config('horse.argon')));
        $secure = fn () => config('horse.cookie_secure') ?? $this->app->environment('production');
        // the clients' back office (/bo) and the operator's admin console (/admin): the same engine, two cookies, two sets of routes
        $this->app->singleton('horse.backoffice', fn ($app) => new BackOffice($app->make(UserStore::class), $app->make(ClientRegistry::class), $app->make(Engine::class), 'bo', null, (bool) $secure()));
        $this->app->singleton('horse.admin', fn ($app) => new BackOffice($app->make(UserStore::class), $app->make(ClientRegistry::class), $app->make(Engine::class), 'admin', '_operator', (bool) $secure(),
            AdminRoutes::make($app->make(ClientRegistry::class), $app->make(UserStore::class), fn () => $app->make('horse.backoffice'), $app->make(House::class))));
        $this->app->singleton(House::class, fn ($app) => new House($app->make(Engine::class), (array) config('horse.argon')));
        $this->app->singleton(PlayerApi::class, fn ($app) => new PlayerApi($app->make(House::class), $app->make(Engine::class), (bool) $secure()));
        $this->app->singleton(Games::class, fn ($app) => new Games($app, (array) config('games')));
        // Bingo Pinball: an instant game on the shared platform services of the Engine
        $this->app->singleton(SeedService::class, fn ($app) => new SeedService($app->make(Engine::class)->journal(), fn () => $app->make(Engine::class)->now(), (string) config('horse.clients_key'), (int) config('games.settings.bingo-pinball.rotate_every', 1000)));
        $this->app->singleton(BingoPinballService::class, function ($app) {
            $e = $app->make(Engine::class);

            return new BingoPinballService($e->sessions(), $e->gateway(), $e->limits(), $e->directory(), $e->journal(), $e->webhooks(), $app->make(SeedService::class), $app->make(Games::class), fn () => $e->now(),
                (array) config('games.settings.bingo-pinball'), (int) $e->cfg('big_win_min'));
        });
        // Bingo Pinball 16: its own seed pairs (game id), the jackpot pool and the play service
        $this->app->singleton('bingo16.seeds', fn ($app) => new SeedService($app->make(Engine::class)->journal(), fn () => $app->make(Engine::class)->now(), (string) config('horse.clients_key'),
            (int) config('games.settings.bingo-pinball-16.rotate_every', 1000), Rules16::ID));
        $this->app->singleton(JackpotPool::class, fn ($app) => new JackpotPool($app->make(Engine::class)->journal(), fn () => $app->make(Engine::class)->now(), (array) config('games.settings.bingo-pinball-16')));
        $this->app->singleton(Bingo16Service::class, function ($app) {
            $e = $app->make(Engine::class);

            return new Bingo16Service($e->sessions(), $e->gateway(), $e->limits(), $e->directory(), $e->journal(), $e->webhooks(), $app->make('bingo16.seeds'), $app->make(JackpotPool::class),
                $app->make(Games::class), fn () => $e->now(), (array) config('games.settings.bingo-pinball-16'), (int) $e->cfg('big_win_min'));
        });
        $this->app->singleton(AlertManager::class, fn ($app) => new AlertManager($app->make(Engine::class), (array) config('horse.alerts'), config('horse.alert_webhook_url')));
        $this->app->singleton(Ledger::class);
        $this->app->singleton(Engine::class, fn ($app) => new Engine($app->make('horse.default_wallet'), $app->make(Ledger::class), config('horse'), null, $app->make(ClientRegistry::class), $app->make('horse.default_webhook')));
    }

    /**
     * Bootstrap any application services.
     */
    public function boot(): void
    {
        //
    }
}
