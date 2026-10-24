<?php

namespace Tests\Feature;

use App\Game\Clients\ClientRegistry;
use App\Game\Engine;
use App\Game\Ledger;
use App\Game\Staff\AdminRoutes;
use App\Game\Staff\BackOffice;
use App\Game\Staff\UserStore;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

/** shared set-up of the back office and admin console tests: a clock, cheap password hashing, two clients */
abstract class StaffTestCase extends TestCase
{
    use RefreshDatabase;

    protected int $t = 1_800_000_000_000;

    protected ClientRegistry $reg;

    protected Engine $engine;

    protected UserStore $users;

    protected const PW = 'correct horse battery staple';

    protected function setUp(): void
    {
        parent::setUp();
        config(['horse.controller_key' => 'ctl-key-for-tests', 'horse.wallet' => 'none', 'horse.clients_key' => 'clients-key-for-tests-1234', 'horse.cookie_secure' => false,
            'horse.argon' => ['memory_cost' => 1024, 'time_cost' => 1, 'threads' => 1]]);
        $this->reg = new ClientRegistry('clients-key-for-tests-1234', allowMock: true, clock: fn () => $this->t, cacheMs: 0);
        $this->app->instance(ClientRegistry::class, $this->reg);
        $this->engine = new Engine(null, new Ledger, config('horse'), fn () => $this->t, $this->reg, null);
        $this->app->instance(Engine::class, $this->engine);
        $this->users = new UserStore('clients-key-for-tests-1234', fn () => $this->t, config('horse.argon'));
        $this->app->instance(UserStore::class, $this->users);
        $clock = fn () => $this->t;
        $bo = new BackOffice($this->users, $this->reg, $this->engine, 'bo', null, false, null, $clock);
        $this->app->instance('horse.backoffice', $bo);
        $this->app->instance('horse.admin', new BackOffice($this->users, $this->reg, $this->engine, 'admin', '_operator', false, AdminRoutes::make($this->reg, $this->users, fn () => $bo), $clock));
        foreach (['acme', 'zeta'] as $id) {
            $this->reg->create(['id' => $id, 'name' => ucfirst($id), 'wallet' => ['type' => 'mock']]);
        }
        $this->engine->tick();
    }

    /** a staff member with a password of their own (no forced change) */
    protected function staff(string $client, string $user, string $role = 'admin'): void
    {
        $this->users->create($client, ['username' => $user, 'role' => $role, 'password' => self::PW], 'test');
    }

    /** signs in and returns [cookie header, csrf token] */
    protected function signIn(string $area, ?string $client, string $user, ?string $otp = null, string $pw = self::PW): array
    {
        $base = $area === 'admin' ? '/admin/api/' : '/bo/api/';
        $r = $this->postJson($base.'login', array_filter(['client' => $client, 'username' => $user, 'password' => $pw, 'otp' => $otp]), ['Origin' => rtrim(config('app.url'), '/')])->assertOk();
        $cookie = collect($r->headers->all('set-cookie'))->first();
        preg_match('/^(\w+)=([0-9a-f]{64});/', $cookie, $m);

        return [['Cookie' => $m[1].'='.$m[2], 'X-CSRF-Token' => $r->json('csrf'), 'Origin' => rtrim(config('app.url'), '/')], $r];
    }

    protected function player(string $client, string $who): string
    {
        return $this->postJson('/api/auth', ['client' => $client, 'token' => 'demo-'.$who])->assertOk()->json('session');
    }
}
