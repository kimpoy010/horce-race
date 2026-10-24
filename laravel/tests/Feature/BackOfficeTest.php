<?php

namespace Tests\Feature;

use App\Game\Staff\BackOffice;
use App\Game\Staff\Totp;
use Illuminate\Support\Facades\DB;

class BackOfficeTest extends StaffTestCase
{
    public function test_totp_matches_the_rfc_6238_vector(): void
    {
        $secret = Totp::b32encode('12345678901234567890');
        $this->assertSame('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', $secret);
        $this->assertSame('287082', Totp::at($secret, 1));            // RFC 6238, T = 59 s (the 8-digit code 94287082)
        $this->assertSame('081804', Totp::at($secret, 37037036));      // RFC 6238, T = 1111111109 s (8-digit code 07081804)
        $this->assertSame('050471', Totp::at($secret, 37037037));      // T = 1111111111 s (8-digit code 14050471)
        $this->assertSame($secret, Totp::b32encode(Totp::b32decode($secret)));
    }

    public function test_the_cookie_is_http_only_strict_and_scoped_and_wrong_logins_are_refused(): void
    {
        $this->staff('acme', 'ann');
        $this->postJson('/bo/api/login', ['client' => 'acme', 'username' => 'ann', 'password' => 'wrong wrong wrong'])->assertStatus(401)->assertJsonPath('error', 'BAD_LOGIN');
        $this->postJson('/bo/api/login', ['client' => 'nope-co', 'username' => 'ann', 'password' => self::PW])->assertStatus(401)->assertJsonPath('error', 'BAD_LOGIN');
        $this->postJson('/bo/api/login', ['client' => 'zeta', 'username' => 'ann', 'password' => self::PW])->assertStatus(401);
        $r = $this->postJson('/bo/api/login', ['client' => 'acme', 'username' => 'ANN', 'password' => self::PW])->assertOk()->assertJsonPath('role', 'admin')->assertJsonPath('client', 'acme');
        $cookie = $r->headers->get('set-cookie');
        $cookie = strtolower($cookie);
        $this->assertStringContainsString('httponly', $cookie);
        $this->assertStringContainsString('samesite=strict', $cookie);
        $this->assertStringContainsString('path=/bo', $cookie);
        $this->assertStringNotContainsString('secure', $cookie, 'plain http in this test');
        $this->assertStringContainsString('no-store', $r->headers->get('cache-control'));
        $this->assertNotEmpty($r->json('csrf'));
    }

    public function test_every_change_needs_the_csrf_token_and_the_same_origin(): void
    {
        $this->staff('acme', 'ann');
        [$h] = $this->signIn('bo', 'acme', 'ann');
        $this->getJson('/bo/api/me', ['Cookie' => $h['Cookie']])->assertOk()->assertJsonPath('user.username', 'ann');
        $this->postJson('/bo/api/players/p1/block', [], ['Cookie' => $h['Cookie']])->assertStatus(403)->assertJsonPath('error', 'BAD_CSRF');
        $this->postJson('/bo/api/players/p1/block', [], ['Cookie' => $h['Cookie'], 'X-CSRF-Token' => 'nope'])->assertStatus(403)->assertJsonPath('error', 'BAD_CSRF');
        $this->postJson('/bo/api/players/p1/block', [], ['Origin' => 'https://evil.example'] + $h)->assertStatus(403)->assertJsonPath('error', 'BAD_ORIGIN');
        $this->postJson('/bo/api/players/p1/block', [], $h)->assertOk();
        $this->getJson('/bo/api/me')->assertStatus(401)->assertJsonPath('error', 'NOT_LOGGED_IN');
        $this->getJson('/bo/api/me', ['Cookie' => 'bo_session='.str_repeat('a', 64)])->assertStatus(401);
    }

    public function test_the_admin_cookie_does_not_open_the_client_back_office_and_the_other_way_round(): void
    {
        $this->staff('acme', 'ann');
        $this->staff('_operator', 'olga');
        [$bo] = $this->signIn('bo', 'acme', 'ann');
        [$ad] = $this->signIn('admin', null, 'olga');
        $this->getJson('/admin/api/me', ['Cookie' => str_replace('bo_session', 'admin_session', $bo['Cookie'])])->assertStatus(401);
        $this->getJson('/bo/api/me', ['Cookie' => str_replace('admin_session', 'bo_session', $ad['Cookie'])])->assertStatus(401);
        $this->getJson('/admin/api/me', $ad)->assertOk()->assertJsonPath('client', '_operator');
    }

    public function test_roles_viewer_reads_support_handles_players_admin_manages_staff(): void
    {
        foreach (['vic' => 'viewer', 'sue' => 'support', 'ann' => 'admin'] as $u => $role) {
            $this->staff('acme', $u, $role);
        }
        [$vic] = $this->signIn('bo', 'acme', 'vic');
        [$sue] = $this->signIn('bo', 'acme', 'sue');
        [$ann] = $this->signIn('bo', 'acme', 'ann');
        $this->getJson('/bo/api/report', $vic)->assertOk();
        $this->getJson('/bo/api/players', $vic)->assertOk();
        $this->postJson('/bo/api/players/p1/block', [], $vic)->assertStatus(403)->assertJsonPath('error', 'FORBIDDEN');
        $this->getJson('/bo/api/users', $sue)->assertStatus(403);
        $this->postJson('/bo/api/players/p1/block', ['reason' => 'asked to stop'], $sue)->assertOk();
        $this->getJson('/bo/api/audit', $sue)->assertStatus(403);
        $this->getJson('/bo/api/users', $ann)->assertOk()->assertJsonCount(3, 'users');
        $this->getJson('/bo/api/audit', $ann)->assertOk();
        $this->getJson('/bo/api/nothing', $ann)->assertStatus(404);
    }

    public function test_a_back_office_sees_only_its_own_clients_players(): void
    {
        $this->staff('acme', 'ann');
        $sa = $this->player('acme', 'pat');
        $this->player('zeta', 'zed');
        $this->postJson('/api/bet', ['bets' => [['combo' => '1-2', 'stake' => 1000]]], ['Authorization' => 'Bearer '.$sa])->assertOk();
        $sz = $this->player('zeta', 'zed');
        $this->postJson('/api/bet', ['bets' => [['combo' => '1-3', 'stake' => 2000]]], ['Authorization' => 'Bearer '.$sz])->assertOk();
        [$h] = $this->signIn('bo', 'acme', 'ann');
        $list = $this->getJson('/bo/api/players', $h)->assertOk()->json('players');
        $this->assertSame(['pat'], array_column($list, 'playerId'));
        $this->assertTrue($list[0]['online']);
        $this->assertSame(1000, $list[0]['staked']);
        $this->getJson('/bo/api/players/zed', $h)->assertOk()->assertJsonPath('totals.bets', 0);                  // not acme's player: nothing
        $this->getJson('/bo/api/players/pat', $h)->assertOk()->assertJsonPath('totals.staked', 1000);
        $this->getJson('/bo/api/players?query=ZE', $h)->assertOk()->assertJsonPath('total', 0);
        $this->assertSame(1, $this->getJson('/bo/api/report', $h)->json('activeSessions'));
    }

    public function test_block_unblock_and_close_sessions_from_the_back_office_are_audited(): void
    {
        $this->staff('acme', 'sue', 'support');
        $s = $this->player('acme', 'pat');
        [$h] = $this->signIn('bo', 'acme', 'sue');
        $this->postJson('/bo/api/players/pat/close-sessions', [], $h)->assertOk()->assertJsonPath('closed', 1);
        $this->getJson('/api/me', ['Authorization' => 'Bearer '.$s])->assertStatus(401);
        $this->postJson('/bo/api/players/pat/block', ['reason' => 'self exclusion'], $h)->assertOk();
        $this->postJson('/api/auth', ['client' => 'acme', 'token' => 'demo-pat'])->assertStatus(403)->assertJsonPath('error', 'PLAYER_BLOCKED');
        $this->postJson('/bo/api/players/pat/unblock', [], $h)->assertOk();
        $this->postJson('/api/auth', ['client' => 'acme', 'token' => 'demo-pat'])->assertOk();
        $actions = collect($this->engine->auditFor('acme', 50)['entries'])->pluck('action')->all();
        foreach (['login', 'player_close_sessions', 'player_block', 'player_unblock'] as $a) {
            $this->assertContains($a, $actions);
        }
        $ledger = DB::table('ledger')->orderBy('seq')->pluck('line')->map(fn ($l) => json_decode($l, true))->where('e', 'bo_action')->pluck('action')->all();
        $this->assertContains('player_block', $ledger, 'also in the tamper-evident ledger');
    }

    public function test_a_temporary_password_must_be_changed_before_anything_else(): void
    {
        $this->staff('acme', 'ann');
        [$ann] = $this->signIn('bo', 'acme', 'ann');
        $made = $this->postJson('/bo/api/users', ['username' => 'new.person', 'role' => 'viewer'], $ann)->assertOk()->json();
        $temp = $made['tempPassword'];
        $this->assertMatchesRegularExpression('/^[a-z2-9]{4}(-[a-z2-9]{4}){3}$/', $temp);
        $this->assertTrue($made['user']['mustChange']);
        [$h] = $this->signIn('bo', 'acme', 'new.person', null, $temp);
        $this->getJson('/bo/api/report', $h)->assertStatus(403)->assertJsonPath('error', 'MUST_CHANGE_PASSWORD');
        $this->postJson('/bo/api/password', ['current' => 'wrong', 'next' => 'a-very-long-new-password'], $h)->assertStatus(403)->assertJsonPath('error', 'BAD_PASSWORD');
        $this->postJson('/bo/api/password', ['current' => $temp, 'next' => 'short'], $h)->assertStatus(400)->assertJsonPath('error', 'WEAK_PASSWORD');
        $this->postJson('/bo/api/password', ['current' => $temp, 'next' => 'new.person-is-in-it-password'], $h)->assertStatus(400)->assertJsonPath('message', 'The password must not contain the username.');
        $this->postJson('/bo/api/password', ['current' => $temp, 'next' => 'a-very-long-new-password'], $h)->assertOk();
        $this->getJson('/bo/api/report', $h)->assertOk();
        $this->postJson('/bo/api/login', ['client' => 'acme', 'username' => 'new.person', 'password' => $temp])->assertStatus(401);
    }

    public function test_five_wrong_passwords_lock_the_account_for_a_while(): void
    {
        $this->staff('acme', 'ann');
        for ($i = 0; $i < 5; $i++) {
            $this->postJson('/bo/api/login', ['client' => 'acme', 'username' => 'ann', 'password' => 'wrong wrong wrong'])->assertStatus(401);
        }
        $this->postJson('/bo/api/login', ['client' => 'acme', 'username' => 'ann', 'password' => self::PW])->assertStatus(429)->assertJsonPath('error', 'TOO_MANY_ATTEMPTS');
        $this->t += 10 * 60000 + 1;
        $this->postJson('/bo/api/login', ['client' => 'acme', 'username' => 'ann', 'password' => self::PW])->assertOk();
        $this->assertContains('login_locked', collect($this->engine->auditFor('acme', 50)['entries'])->pluck('action')->all());
    }

    public function test_idle_sessions_expire_and_disabled_users_or_clients_are_out_at_once(): void
    {
        $this->staff('acme', 'ann');
        $this->staff('acme', 'bob');
        [$h] = $this->signIn('bo', 'acme', 'ann');
        [$b] = $this->signIn('bo', 'acme', 'bob');
        $this->t += BackOffice::IDLE_MS + 1;
        $this->getJson('/bo/api/me', $h)->assertStatus(401)->assertJsonPath('error', 'SESSION_EXPIRED');
        [$h] = $this->signIn('bo', 'acme', 'ann');
        $this->users->setStatus('acme', 'ann', 'disabled');
        $this->getJson('/bo/api/me', $h)->assertStatus(401);
        $this->users->setStatus('acme', 'ann', 'active');
        [$h] = $this->signIn('bo', 'acme', 'ann');
        $this->reg->setStatus('acme', 'disabled');
        $this->getJson('/bo/api/me', $h)->assertStatus(401);
        $this->postJson('/bo/api/login', ['client' => 'acme', 'username' => 'ann', 'password' => self::PW])->assertStatus(401);
    }

    public function test_two_step_sign_in_with_an_authenticator_app(): void
    {
        $this->staff('acme', 'ann');
        [$h] = $this->signIn('bo', 'acme', 'ann');
        $setup = $this->postJson('/bo/api/totp/setup', [], $h)->assertOk()->json();
        $this->assertStringStartsWith('otpauth://totp/', $setup['otpauth']);
        $this->assertStringNotContainsString($setup['secret'], DB::table('staff_users')->value('totp'), 'the secret is stored encrypted');
        $this->postJson('/bo/api/totp/enable', ['otp' => '000000'], $h)->assertStatus(400)->assertJsonPath('error', 'BAD_OTP');
        $code = Totp::at($setup['secret'], intdiv($this->t, 30000));
        $this->postJson('/bo/api/totp/enable', ['otp' => $code], $h)->assertOk();
        $this->assertTrue($this->getJson('/bo/api/me', $h)->json('user.totp'));
        // from now on a code is needed, and the same code works only once
        $this->postJson('/bo/api/login', ['client' => 'acme', 'username' => 'ann', 'password' => self::PW])->assertStatus(401)->assertJsonPath('error', 'OTP_REQUIRED');
        $this->postJson('/bo/api/login', ['client' => 'acme', 'username' => 'ann', 'password' => self::PW, 'otp' => '123456'])->assertStatus(401)->assertJsonPath('error', 'BAD_LOGIN');
        $this->postJson('/bo/api/login', ['client' => 'acme', 'username' => 'ann', 'password' => self::PW, 'otp' => $code])->assertStatus(401);             // the enabling code is used up
        $this->t += 30000;
        $next = Totp::at($setup['secret'], intdiv($this->t, 30000));
        $this->postJson('/bo/api/login', ['client' => 'acme', 'username' => 'ann', 'password' => self::PW, 'otp' => $next])->assertOk();
        $this->postJson('/bo/api/login', ['client' => 'acme', 'username' => 'ann', 'password' => self::PW, 'otp' => $next])->assertStatus(401);
        [$h2] = $this->signIn('bo', 'acme', 'ann', Totp::at($setup['secret'], intdiv($this->t + 30000, 30000)));
        $this->postJson('/bo/api/totp/disable', ['password' => 'wrong'], $h2)->assertStatus(403);
        $this->postJson('/bo/api/totp/disable', ['password' => self::PW], $h2)->assertOk();
        $this->assertFalse($this->getJson('/bo/api/me', $h2)->json('user.totp'));
    }

    public function test_user_management_guards_the_last_administrator_and_ends_sessions(): void
    {
        $this->staff('acme', 'ann');
        $this->staff('acme', 'bob', 'support');
        [$ann] = $this->signIn('bo', 'acme', 'ann');
        [$bob] = $this->signIn('bo', 'acme', 'bob');
        $this->postJson('/bo/api/users/ann/role', ['role' => 'viewer'], $ann)->assertStatus(400)->assertJsonPath('error', 'SELF');
        $this->postJson('/bo/api/users/ann/status', ['status' => 'disabled'], $ann)->assertStatus(400)->assertJsonPath('error', 'SELF');
        $this->postJson('/bo/api/users/ann/delete', [], $ann)->assertStatus(400)->assertJsonPath('error', 'SELF');
        $this->postJson('/bo/api/users', ['username' => 'Bad Name', 'role' => 'viewer'], $ann)->assertStatus(400)->assertJsonPath('error', 'BAD_USER');
        $this->postJson('/bo/api/users', ['username' => 'bob', 'role' => 'viewer'], $ann)->assertStatus(409)->assertJsonPath('error', 'USER_EXISTS');
        $this->postJson('/bo/api/users/bob/role', ['role' => 'admin'], $ann)->assertOk();
        $this->getJson('/bo/api/me', $bob)->assertStatus(401);                             // a role change ends the person's sessions
        [$bob] = $this->signIn('bo', 'acme', 'bob');
        $this->postJson('/bo/api/users/ann/status', ['status' => 'disabled'], $bob)->assertOk();                  // two admins: one may go
        $this->getJson('/bo/api/me', $ann)->assertStatus(401);
        $this->postJson('/bo/api/users/ann/role', ['role' => 'viewer'], $bob)->assertOk();
        $reset = $this->postJson('/bo/api/users/ann/reset-password', [], $bob)->assertOk()->json();
        $this->assertTrue($reset['user']['mustChange']);
        $this->postJson('/bo/api/users/ann/delete', [], $bob)->assertOk();
        $this->postJson('/bo/api/users/ghost/delete', [], $bob)->assertStatus(404);
    }

    public function test_exports_are_csv_and_formula_text_is_neutralised(): void
    {
        $this->staff('acme', 'ann');
        $s = $this->player('acme', 'pat');
        $this->postJson('/api/bet', ['bets' => [['combo' => '1-2', 'stake' => 1000]]], ['Authorization' => 'Bearer '.$s])->assertOk();
        [$h] = $this->signIn('bo', 'acme', 'ann');
        $r = $this->get('/bo/api/export/players.csv', $h)->assertOk();
        $this->assertStringStartsWith('text/csv', $r->headers->get('content-type'));
        $this->assertStringContainsString('attachment; filename="players.csv"', $r->headers->get('content-disposition'));
        $csv = $r->getContent();
        $this->assertStringStartsWith("player,bets,staked,paid,net_for_player,last_bet,online,blocked\r\n", $csv);
        $this->assertStringContainsString("\r\npat,1,1000,0,-1000,", $csv);
        $this->get('/bo/api/export/rounds.csv', $h)->assertOk();
        $this->assertContains('export', collect($this->engine->auditFor('acme', 50)['entries'])->pluck('action')->all());
        // text that starts like a spreadsheet formula is made harmless; quotes and commas are escaped; numbers stay numbers
        $this->assertSame("x\r\n'@sum,\"b,c\",'=1+1,-5,'+cmd\r\n", BackOffice::csv(['x'], [['@sum', 'b,c', '=1+1', '-5', '+cmd']]));
    }

    public function test_the_client_can_rotate_its_own_api_key_from_the_back_office(): void
    {
        $this->staff('acme', 'ann');
        $old = $this->reg->rotateKey('acme', 0)['apiKey'];
        [$h] = $this->signIn('bo', 'acme', 'ann');
        $new = $this->postJson('/bo/api/apikey/rotate', ['graceHours' => 1], $h)->assertOk()->json('apiKey');
        $this->assertMatchesRegularExpression('/^hrk_acme_/', $new);
        $this->getJson('/api/client/info', ['Authorization' => 'Bearer '.$new])->assertOk();
        $this->getJson('/api/client/info', ['Authorization' => 'Bearer '.$old])->assertOk();           // still inside its grace hour
        $info = $this->getJson('/bo/api/client', $h)->assertOk()->json('client');
        $this->assertSame('acme', $info['id']);
        $this->assertArrayNotHasKey('secret', $info['wallet']);
    }

    public function test_the_pages_carry_the_security_headers(): void
    {
        foreach (['/backoffice', '/admin', '/controller'] as $page) {
            $r = $this->get($page)->assertOk();
            $this->assertSame('DENY', $r->headers->get('x-frame-options'));
            $this->assertStringContainsString("frame-ancestors 'none'", $r->headers->get('content-security-policy'));
        }
    }
}
