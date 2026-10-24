<?php

namespace Tests\Feature;

use App\Game\Odds;
use Illuminate\Support\Facades\DB;

class AdminConsoleTest extends StaffTestCase
{
    private function operator(string $role = 'admin', string $name = 'olga'): array
    {
        $this->staff('_operator', $name, $role);

        return $this->signIn('admin', null, $name)[0];
    }

    public function test_the_overview_shows_health_game_numbers_rtp_and_every_client(): void
    {
        $h = $this->operator('viewer');
        $s = $this->player('acme', 'pat');
        $this->postJson('/api/bet', ['bets' => [['combo' => '1-2', 'stake' => 1000]]], ['Authorization' => 'Bearer '.$s])->assertOk();
        $o = $this->getJson('/admin/api/overview', $h)->assertOk()->json();
        $this->assertSame(['acme', 'zeta'], array_column($o['clients'], 'id'));
        $this->assertSame('mock wallet', $o['clients'][0]['wallet']);
        $this->assertSame(1, $o['game']['sessions']);
        $this->assertTrue($o['game']['ledger']['ok']);
        $this->assertEquals(0.9, $o['game']['rtpSetting']);
        $this->assertCount(15, array_filter($o['rtp']['rows'], fn ($r) => $r['odds'] > 0) + array_fill(0, 0, null));
        $this->assertFalse($o['defaultClient']);
        $this->assertArrayHasKey('p95', $o['wallet']);
        $this->assertSame([], $o['alerts']);
        $this->assertSame(0, $o['game']['pending']['credits']['count']);
        $this->assertTrue($o['health']['ok'] === false || $o['health']['ok'] === true);
    }

    public function test_wallet_calls_are_timed_and_counted_per_client(): void
    {
        $this->player('acme', 'pat');
        $this->player('zeta', 'zed');
        $this->assertSame(1, $this->engine->walletWindow(60000, 'acme')['calls']);
        $this->assertSame(2, $this->engine->walletWindow(60000)['calls']);
        $this->assertSame(0, $this->engine->walletWindow(60000, 'acme')['failures']);
        $this->t += 120000;
        $this->assertSame(0, $this->engine->walletWindow(60000)['calls'], 'older calls fall out of the window');
        $h = $this->operator();
        $o = $this->getJson('/admin/api/overview', $h)->json();
        $this->assertSame(1, $o['clients'][0]['walletHealth']['calls'], 'the overview looks at the last five minutes');
    }

    public function test_the_rtp_is_set_by_admins_only_and_previewed_by_everyone(): void
    {
        $viewer = $this->operator('viewer', 'vic');
        $admin = $this->operator('admin', 'ada');
        $this->getJson('/admin/api/rtp/preview?value=95', $viewer)->assertOk()->assertJsonCount(15, 'rows');
        $this->getJson('/admin/api/rtp/preview?value=50', $viewer)->assertStatus(400);
        $this->postJson('/admin/api/rtp', ['rtp' => 95], $viewer)->assertStatus(403)->assertJsonPath('error', 'FORBIDDEN');
        $this->postJson('/admin/api/rtp', ['rtp' => 40], $admin)->assertStatus(400)->assertJsonPath('message', 'The RTP must be between 88% and 99%.');
        $this->postJson('/admin/api/rtp', ['rtp' => 95], $admin)->assertOk()->assertJsonPath('rtp', 0.95);
        $this->assertSame(0.95, $this->engine->rtp());
        $this->assertContains('rtp_set', collect($this->engine->auditFor('_operator', 20)['entries'])->pluck('action')->all());
    }

    public function test_clients_are_created_changed_suspended_and_deleted_from_the_console(): void
    {
        $admin = $this->operator('admin', 'ada');
        $made = $this->postJson('/admin/api/clients', ['client' => ['id' => 'newco', 'name' => 'New Co', 'wallet' => ['url' => 'https://pf.newco.example/api'], 'webhook' => ['url' => 'https://pf.newco.example/events']]], $admin)->assertOk()->json();
        $this->assertMatchesRegularExpression('/^hrk_newco_/', $made['apiKey']);
        $this->assertNotEmpty($made['walletSecret']);
        $this->assertStringContainsString('Shown once', $made['note']);
        $detail = $this->getJson('/admin/api/clients/newco', $admin)->assertOk()->json();
        $this->assertStringStartsWith('***', $detail['client']['wallet']['secret']);
        $before = $this->reg->get('newco')['wallet']['secret'];
        // an empty secret field keeps the secret
        $this->postJson('/admin/api/clients/newco', ['client' => ['name' => 'New Co Ltd', 'wallet' => ['url' => 'https://pf.newco.example/api2', 'secret' => ''], 'limits' => ['maxBet' => 5000]]], $admin)->assertOk();
        $this->assertSame($before, $this->reg->get('newco')['wallet']['secret']);
        $this->assertSame('https://pf.newco.example/api2', $this->reg->get('newco')['wallet']['url']);
        $this->postJson('/admin/api/clients/newco', ['client' => ['wallet' => ['url' => 'http://insecure.example']]], $admin)->assertStatus(400)->assertJsonPath('error', 'BAD_CLIENT');
        $rot = $this->postJson('/admin/api/clients/newco/rotate-key', ['graceHours' => 0], $admin)->assertOk()->json();
        $this->assertNotSame($made['apiKey'], $rot['apiKey']);
        $this->assertNull($this->reg->authenticate($made['apiKey'], '1.1.1.1'));
        $ws = $this->postJson('/admin/api/clients/newco/rotate-wallet-secret', [], $admin)->assertOk()->json('walletSecret');
        $this->assertSame($ws, $this->reg->get('newco')['wallet']['secret']);
        $this->postJson('/admin/api/clients/newco/rotate-webhook-secret', [], $admin)->assertOk();
        $this->postJson('/admin/api/clients/newco/revoke-key', ['keyId' => 'k1'], $admin)->assertOk();
        $this->postJson('/admin/api/clients/nope-co/status', ['status' => 'disabled'], $admin)->assertStatus(404);
        $this->postJson('/admin/api/clients/newco/delete', ['confirm' => 'wrong'], $admin)->assertStatus(400)->assertJsonPath('error', 'CONFIRM');
        $this->postJson('/admin/api/clients/newco/delete', ['confirm' => 'newco'], $admin)->assertOk();
        $this->assertNull($this->reg->get('newco'));
        $actions = collect($this->engine->auditFor('_operator', 50)['entries'])->pluck('action')->all();
        foreach (['client_created', 'client_updated', 'api_key_rotated', 'wallet_secret_rotated', 'webhook_secret_rotated', 'api_key_revoked', 'client_deleted'] as $a) {
            $this->assertContains($a, $actions);
        }
    }

    public function test_support_may_suspend_a_client_which_ends_its_players_and_staff_sessions(): void
    {
        $support = $this->operator('support', 'sam');
        $this->staff('acme', 'ann');
        [$ann] = $this->signIn('bo', 'acme', 'ann');
        $s = $this->player('acme', 'pat');
        $this->postJson('/admin/api/clients/acme/rotate-key', [], $support)->assertStatus(403);
        $this->postJson('/admin/api/clients/acme/status', ['status' => 'disabled'], $support)->assertOk()->assertJsonPath('client.status', 'disabled');
        $this->getJson('/api/me', ['Authorization' => 'Bearer '.$s])->assertStatus(401);
        $this->getJson('/bo/api/me', $ann)->assertStatus(401);
        $this->postJson('/admin/api/clients/acme/status', ['status' => 'active'], $support)->assertOk();
        $this->postJson('/api/auth', ['client' => 'acme', 'token' => 'demo-pat'])->assertOk();
    }

    public function test_the_operator_manages_the_back_office_users_of_a_client(): void
    {
        $admin = $this->operator('admin', 'ada');
        $this->postJson('/admin/api/clients/acme/users', ['username' => 'first.admin', 'role' => 'admin'], $admin)->assertOk()->assertJsonPath('user.role', 'admin');
        $temp = DB::table('staff_users')->where('username', 'first.admin')->first();
        $this->assertTrue((bool) $temp->must_change);
        $this->getJson('/admin/api/clients/acme/users', $admin)->assertOk()->assertJsonCount(1, 'users');
        $this->staff('acme', 'ann');
        [$ann] = $this->signIn('bo', 'acme', 'ann');
        $r = $this->postJson('/admin/api/clients/acme/users/ann/reset-password', [], $admin)->assertOk()->json();
        $this->assertNotEmpty($r['tempPassword']);
        $this->getJson('/bo/api/me', $ann)->assertStatus(401);                    // the reset ended her sessions
        $this->postJson('/admin/api/clients/acme/users/ann/status', ['status' => 'disabled'], $admin)->assertOk();
        $this->postJson('/admin/api/clients/acme/users/ann/delete', [], $admin)->assertOk();
        $this->getJson('/admin/api/clients/acme/users', $admin)->assertJsonCount(1, 'users');
        $this->getJson('/admin/api/clients/acme', $admin)->assertOk()->assertJsonStructure(['client', 'report', 'users', 'walletHealth', 'rounds', 'audit']);
    }

    public function test_the_operator_staff_manage_themselves_with_the_same_rules(): void
    {
        $admin = $this->operator('admin', 'ada');
        $made = $this->postJson('/admin/api/users', ['username' => 'sam', 'role' => 'support'], $admin)->assertOk()->json();
        $this->assertTrue($made['user']['mustChange']);
        $this->getJson('/admin/api/users', $admin)->assertOk()->assertJsonCount(2, 'users');
        $this->postJson('/admin/api/users/ada/role', ['role' => 'viewer'], $admin)->assertStatus(400)->assertJsonPath('error', 'SELF');
        $this->getJson('/admin/api/audit', $admin)->assertOk()->assertJsonPath('ok', true);
        $this->getJson('/admin/api/nothing', $admin)->assertStatus(404);
        $this->getJson('/admin/api/overview')->assertStatus(401);
    }

    public function test_a_client_users_cookie_cannot_use_the_console_and_a_wrong_login_is_refused(): void
    {
        $this->staff('acme', 'ann');
        $this->postJson('/admin/api/login', ['username' => 'ann', 'password' => self::PW])->assertStatus(401)->assertJsonPath('error', 'BAD_LOGIN');     // ann belongs to acme, not to the operator
        $this->postJson('/admin/api/login', ['client' => 'acme', 'username' => 'ann', 'password' => self::PW])->assertStatus(401);
    }

    public function test_the_controller_key_manages_client_users_too(): void
    {
        $k = ['X-Controller-Key' => 'ctl-key-for-tests'];
        $this->postJson('/api/clients/acme/users', ['username' => 'ann', 'role' => 'admin'], $k)->assertOk()->assertJsonPath('user.mustChange', true);
        $this->postJson('/api/clients/acme/users', ['username' => 'bob', 'role' => 'viewer', 'password' => 'a-fine-long-password'], $k)->assertOk()->assertJsonPath('user.mustChange', false);
        $this->postJson('/api/clients/acme/users', ['username' => 'cat', 'role' => 'viewer', 'password' => 'weak'], $k)->assertStatus(400)->assertJsonPath('error', 'WEAK_PASSWORD');
        $this->getJson('/api/clients/acme/users', $k)->assertOk()->assertJsonCount(2, 'users');
        $this->getJson('/api/clients/nope-co/users', $k)->assertStatus(404);
        $this->postJson('/api/clients/acme/users/bob/status', ['status' => 'disabled'], $k)->assertOk()->assertJsonPath('user.status', 'disabled');
        $this->postJson('/api/clients/acme/users/bob/delete', [], $k)->assertOk();
        $this->getJson('/api/clients/acme/users')->assertStatus(401);
    }

    public function test_the_staff_command_manages_logins_from_the_command_line(): void
    {
        config(['horse.argon' => ['memory_cost' => 1024, 'time_cost' => 1, 'threads' => 1]]);
        $this->artisan('staff add-operator olga --role=admin')->expectsOutputToContain('Temporary password')->assertSuccessful();
        $this->artisan('staff add-user acme ann --role=support')->assertSuccessful();
        $this->artisan('staff add-user nope-co ann')->assertFailed();
        $this->artisan('staff list-users acme')->expectsOutputToContain('ann')->assertSuccessful();
        $this->artisan('staff reset-password acme ann')->expectsOutputToContain('Temporary password for ann')->assertSuccessful();
        $this->artisan('staff disable-user acme ann')->assertSuccessful();
        $this->assertSame('disabled', DB::table('staff_users')->where('username', 'ann')->value('status'));
        $this->artisan('staff remove-user acme ann')->assertFailed();
        $this->artisan('staff remove-user acme ann --yes')->assertSuccessful();
        $this->assertSame(1, DB::table('staff_users')->count());
    }

    public function test_rtp_tracking_reports_how_far_the_payouts_are_from_what_the_odds_predict(): void
    {
        $s = $this->player('acme', 'pat');
        $bets = array_map(fn ($c) => ['combo' => $c, 'stake' => 1000], Odds::combos());
        $this->postJson('/api/bet', ['bets' => $bets], ['Authorization' => 'Bearer '.$s])->assertOk();
        $this->t += 25000;
        $this->engine->tick();
        $this->t += 36000;
        $this->engine->tick();
        $this->assertNotSame(0.0, $this->engine->rtpZ());
        $this->assertLessThan(5, abs($this->engine->rtpZ()));
        $snap = $this->engine->opsSnapshot();
        $this->assertTrue($snap['ledger']['ok']);
        $this->assertSame(1, $snap['rounds']);
    }
}
