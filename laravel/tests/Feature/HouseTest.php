<?php

namespace Tests\Feature;

use App\Game\House\House;
use App\Game\House\HouseWallet;
use App\Game\House\PlayerApi;
use App\Game\Staff\AdminRoutes;
use App\Game\Staff\BackOffice;
use App\Game\Wallet\WalletException;
use Illuminate\Support\Facades\Artisan;
use Illuminate\Support\Facades\DB;

/** the operator's own site: registration, the built-in wallet, deposits and withdrawals, the cashier in the admin console, and a real bet */
class HouseTest extends StaffTestCase
{
    private House $house;

    protected function setUp(): void
    {
        parent::setUp();
        $this->origin = ['Origin' => rtrim(config('app.url'), '/')];
        $this->house = new House($this->engine, config('horse.argon'));
        $this->app->instance(House::class, $this->house);
        $this->app->instance(PlayerApi::class, new PlayerApi($this->house, $this->engine, false));
        $bo = $this->app->make('horse.backoffice');
        $this->app->instance('horse.admin', new BackOffice($this->users, $this->reg, $this->engine, 'admin', '_operator', false, AdminRoutes::make($this->reg, $this->users, fn () => $bo, $this->house), fn () => $this->t));
        Artisan::call('house:setup');
        $this->house->saveSettings(['methods' => [['id' => 'gcash', 'label' => 'GCash', 'accountName' => 'Karera Ops', 'accountNumber' => '09170000000']], 'minDeposit' => 10000, 'minWithdraw' => 20000]);
    }

    private array $origin = [];

    /** registers a player and returns [headers with cookie and csrf, response json] */
    private function register(string $user = 'maria', string $mobile = '09171234567', array $extra = []): array
    {
        $r = $this->postJson('/player/api/register', $extra + ['username' => $user, 'password' => 'a good password', 'mobile' => $mobile, 'over18' => true, 'terms' => true], $this->origin);
        if ($r->status() !== 200) {
            return [[], $r->json()];
        }

        return [$this->headersOf($r), $r->json()];
    }

    private function headersOf($r): array
    {
        preg_match('/^(\w+)=([0-9a-f]{64});/', collect($r->headers->all('set-cookie'))->first(), $m);

        return ['Cookie' => $m[1].'='.$m[2], 'X-CSRF-Token' => $r->json('csrf')] + $this->origin;
    }

    private function funded(string $user = 'maria', string $mobile = '09171234567', int $amount = 100000): array
    {
        [$h] = $this->register($user, $mobile);
        $pid = (int) DB::table('players')->where('username', $user)->value('id');
        $this->house->adjust($pid, $amount, 'test funds', 'tester');

        return [$h, $pid];
    }

    private function adminHeaders(string $role = 'admin'): array
    {
        $this->staff('_operator', 'olga', $role);

        return $this->signIn('admin', null, 'olga')[0];
    }

    /* ---------- setup, registration, sign-in ---------- */

    public function test_house_setup_creates_the_built_in_client_once(): void
    {
        $this->assertSame('internal', $this->reg->get('house')['wallet']['type']);
        $this->assertSame(0, Artisan::call('house:setup'));
        $this->assertCount(1, array_filter($this->reg->list(), fn ($c) => $c['id'] === 'house'));
        $this->assertSame('internal', $this->reg->update('house', ['wallet' => ['type' => 'http', 'url' => 'https://x.example', 'secret' => str_repeat('a', 20)]])['wallet']['type'], 'the house wallet cannot be pointed elsewhere');
        $this->expectException(\App\Game\GameError::class);
        $this->reg->create(['id' => 'other', 'name' => 'Other', 'wallet' => ['type' => 'internal']]);
    }

    public function test_registration_creates_an_account_signs_in_and_stores_only_a_hash(): void
    {
        [$h, $j] = $this->register('Maria_01', '+63 917 123 4567', ['email' => 'm@example.com']);
        $this->assertTrue($j['ok']);
        $this->assertSame('maria_01', $j['player']['username']);
        $this->assertSame('09171234567', $j['player']['mobile']);
        $this->assertSame(0, $j['player']['balance']);
        $row = DB::table('players')->first();
        $this->assertStringStartsWith('$argon2id$', $row->pass);
        $this->assertNotNull($row->terms_at);
        $this->getJson('/player/api/me', $h)->assertOk()->assertJsonPath('player.username', 'maria_01');
        $this->assertStringContainsString('httponly', strtolower(collect($this->postJson('/player/api/login', ['username' => 'maria_01', 'password' => 'a good password'], $this->origin)->headers->all('set-cookie'))->first()));
    }

    public function test_registration_checks_every_field_and_refuses_duplicates(): void
    {
        $bad = fn (array $over, string $code) => $this->assertSame($code, $this->register('zed_user', '09181111111', $over)[1]['error']);
        $bad(['username' => 'a b'], 'BAD_USERNAME');
        $bad(['username' => '1abc'], 'BAD_USERNAME');
        $bad(['mobile' => '12345'], 'BAD_MOBILE');
        $bad(['email' => 'nope'], 'BAD_EMAIL');
        $bad(['password' => 'short'], 'WEAK_PASSWORD');
        $bad(['password' => 'zed_user'], 'WEAK_PASSWORD');
        $bad(['over18' => false], 'CONSENT_REQUIRED');
        $bad(['terms' => false], 'CONSENT_REQUIRED');
        $this->assertSame(0, DB::table('players')->count());
        \Illuminate\Support\Facades\Cache::flush();                  // the sign-up limit per address is tested below
        $this->register('maria', '09171234567');
        $this->assertSame('USERNAME_TAKEN', $this->register('maria', '09179999999')[1]['error']);
        $this->assertSame('MOBILE_TAKEN', $this->register('other_one', '0917 123 4567')[1]['error']);
        $this->assertSame(1, DB::table('players')->count());
    }

    public function test_registration_can_be_closed_and_is_limited_per_address(): void
    {
        $this->house->saveSettings(['registration' => false]);
        $this->assertSame('REGISTRATION_CLOSED', $this->register()[1]['error']);
        $this->house->saveSettings(['registration' => true]);
        $last = null;
        for ($i = 0; $i < 12; $i++) {
            $last = $this->postJson('/player/api/register', ['username' => 'x'], $this->origin);
        }
        $this->assertSame(429, $last->status());
    }

    public function test_wrong_passwords_are_throttled_and_do_not_reveal_whether_the_user_exists(): void
    {
        $this->register();
        $a = $this->postJson('/player/api/login', ['username' => 'maria', 'password' => 'wrong'], $this->origin);
        $b = $this->postJson('/player/api/login', ['username' => 'nobody', 'password' => 'wrong'], $this->origin);
        $this->assertSame([401, 'BAD_LOGIN'], [$a->status(), $a->json('error')]);
        $this->assertSame([401, 'BAD_LOGIN'], [$b->status(), $b->json('error')]);
        for ($i = 0; $i < 7; $i++) {
            $this->postJson('/player/api/login', ['username' => 'maria', 'password' => 'wrong'], $this->origin);
        }
        $this->assertSame(429, $this->postJson('/player/api/login', ['username' => 'maria', 'password' => 'a good password'], $this->origin)->status(), 'even the right password waits');
        $this->t += 11 * 60000;
        $this->postJson('/player/api/login', ['username' => 'maria', 'password' => 'a good password'], $this->origin)->assertOk();
    }

    public function test_changes_need_the_csrf_token_and_the_right_origin_and_logout_ends_the_session(): void
    {
        [$h] = $this->register();
        $this->postJson('/player/api/launch', [], ['Cookie' => $h['Cookie']] + $this->origin)->assertStatus(403)->assertJsonPath('error', 'BAD_CSRF');
        $this->postJson('/player/api/launch', [], array_merge($h, ['Origin' => 'https://evil.example']))->assertStatus(403)->assertJsonPath('error', 'BAD_ORIGIN');
        $this->postJson('/player/api/launch', [], $h)->assertOk();
        $this->getJson('/player/api/me')->assertStatus(401);
        $this->postJson('/player/api/logout', [], $h)->assertOk();
        $this->getJson('/player/api/me', $h)->assertStatus(401);
    }

    public function test_sessions_expire_when_idle(): void
    {
        [$h] = $this->register();
        $this->t += PlayerApi::IDLE_MS + 1000;
        $this->getJson('/player/api/me', $h)->assertStatus(401)->assertJsonPath('error', 'SESSION_EXPIRED');
    }

    public function test_changing_the_password_checks_the_old_one_and_ends_other_sessions(): void
    {
        [$h] = $this->register();
        $other = $this->headersOf($this->postJson('/player/api/login', ['username' => 'maria', 'password' => 'a good password'], $this->origin));
        $this->postJson('/player/api/password', ['current' => 'nope', 'next' => 'another good one'], $h)->assertStatus(403);
        $this->postJson('/player/api/password', ['current' => 'a good password', 'next' => 'short'], $h)->assertStatus(400);
        $this->postJson('/player/api/password', ['current' => 'a good password', 'next' => 'another good one'], $h)->assertOk();
        $this->getJson('/player/api/me', $other)->assertStatus(401);
        $this->postJson('/player/api/login', ['username' => 'maria', 'password' => 'another good one'], $this->origin)->assertOk();
    }

    /* ---------- the wallet ---------- */

    public function test_the_wallet_is_idempotent_refuses_overdrafts_and_rolls_back_once(): void
    {
        [, $pid] = $this->funded();
        $w = new HouseWallet('PHP');
        $p = 'p'.$pid;
        $this->assertSame(99000, $w->debit($p, 1000, 'tx1')['balance']);
        $this->assertSame(99000, $w->debit($p, 1000, 'tx1')['balance'], 'the same debit twice is applied once');
        $this->assertSame(100000, $w->rollback($p, 1000, 'tx1')['balance']);
        $this->assertSame('already_rolled_back', $w->rollback($p, 1000, 'tx1')['status']);
        $this->assertSame(100000, $w->balance($p));
        $this->assertSame('not_found', $w->rollback($p, 500, 'late')['status']);
        try {
            $w->debit($p, 500, 'late');
            $this->fail('a rolled back debit must be refused');
        } catch (WalletException $e) {
            $this->assertSame('TX_ROLLED_BACK', $e->getMessage());
        }
        $this->assertSame(100000, $w->credit($p, 0, 'c0')['balance']);
        try {
            $w->debit($p, 100001, 'big');
            $this->fail('overdraft');
        } catch (WalletException $e) {
            $this->assertSame('INSUFFICIENT_FUNDS', $e->getMessage());
        }
        $this->assertSame(100250, $w->credit($p, 250, 'win1')['balance']);
    }

    /* ---------- deposits ---------- */

    public function test_a_deposit_waits_for_staff_and_is_credited_once(): void
    {
        [$h, $pid] = $this->register();
        $body = ['method' => 'gcash', 'amount' => 50000, 'senderName' => 'Maria Santos', 'reference' => 'gc-123456'];
        $id = $this->postJson('/player/api/deposit', $body, $h)->assertOk()->json('id');
        $this->assertSame(0, (int) DB::table('players')->value('balance'), 'nothing is credited before approval');
        $this->postJson('/player/api/deposit', $body, $h)->assertStatus(409)->assertJsonPath('error', 'REFERENCE_USED');
        $a = $this->adminHeaders('support');
        $q = $this->getJson('/admin/api/house/queue/deposits', $a)->assertOk()->json('items');
        $this->assertSame([['GC-123456', 50000, 'maria']], array_map(fn ($i) => [$i['reference'], $i['amount'], $i['username']], $q));
        $this->postJson("/admin/api/house/deposits/$id/approve", [], $a)->assertOk()->assertJsonPath('status', 'approved');
        $this->assertSame(50000, (int) DB::table('players')->value('balance'));
        $this->postJson("/admin/api/house/deposits/$id/approve", [], $a)->assertStatus(409);
        $this->postJson("/admin/api/house/deposits/$id/reject", [], $a)->assertStatus(409);
        $this->assertSame(50000, (int) DB::table('players')->value('balance'));
        $this->assertSame(['deposit'], DB::table('wallet_tx')->pluck('type')->all());
        $w = $this->getJson('/player/api/wallet', $h)->assertOk()->json();
        $this->assertSame(50000, $w['balance']);
        $this->assertSame('approved', $w['deposits'][0]['status']);
        $events = array_map(fn ($l) => json_decode($l, true)['e'] ?? '', DB::table('ledger')->orderBy('seq')->pluck('line')->all());
        $this->assertContains('deposit_approved', $events, 'recorded in the hash-chained ledger');
    }

    public function test_a_rejected_deposit_credits_nothing_and_deposit_input_is_checked(): void
    {
        [$h] = $this->register();
        $post = fn (array $o) => $this->postJson('/player/api/deposit', $o + ['method' => 'gcash', 'amount' => 20000, 'senderName' => 'M S', 'reference' => 'REF12345'], $h);
        $post(['method' => 'paypal'])->assertStatus(400)->assertJsonPath('error', 'BAD_METHOD');
        $post(['amount' => 5000])->assertStatus(400)->assertJsonPath('error', 'BAD_AMOUNT');
        $post(['amount' => 'lots'])->assertStatus(400)->assertJsonPath('error', 'BAD_AMOUNT');
        $post(['amount' => 12.5])->assertStatus(400)->assertJsonPath('error', 'BAD_AMOUNT');
        $post(['reference' => 'x'])->assertStatus(400)->assertJsonPath('error', 'BAD_REFERENCE');
        $post(['senderName' => ''])->assertStatus(400)->assertJsonPath('error', 'BAD_SENDER');
        $id = $post([])->assertOk()->json('id');
        $a = $this->adminHeaders('support');
        $this->postJson("/admin/api/house/deposits/$id/reject", ['note' => 'no such payment'], $a)->assertOk();
        $this->assertSame(0, (int) DB::table('players')->value('balance'));
        $this->assertSame('no such payment', $this->getJson('/player/api/wallet', $h)->json('deposits.0.note'));
        for ($i = 0; $i < 3; $i++) {
            $post(['reference' => 'PEND000'.$i])->assertOk();
        }
        $post(['reference' => 'PEND9999'])->assertStatus(429)->assertJsonPath('error', 'TOO_MANY_PENDING');
    }

    /* ---------- withdrawals ---------- */

    public function test_a_withdrawal_holds_the_money_then_is_paid_or_given_back(): void
    {
        [$h, $pid] = $this->funded('maria', '09171234567', 100000);
        $req = fn (int $amount) => $this->postJson('/player/api/withdraw', ['method' => 'gcash', 'amount' => $amount, 'accountName' => 'Maria Santos', 'accountNumber' => '09171234567'], $h);
        $req(10000)->assertStatus(400)->assertJsonPath('error', 'BAD_AMOUNT');
        $req(200000)->assertStatus(402)->assertJsonPath('error', 'INSUFFICIENT_FUNDS');
        $this->assertSame(0, DB::table('withdrawals')->count(), 'a refused request leaves nothing behind');
        $id = $req(60000)->assertOk()->assertJsonPath('balance', 40000)->json('id');
        $req(20000)->assertStatus(429)->assertJsonPath('error', 'PENDING_EXISTS');
        $a = $this->adminHeaders('support');
        $this->postJson("/admin/api/house/withdrawals/$id/pay", [], $a)->assertStatus(400)->assertJsonPath('error', 'REFERENCE_REQUIRED');
        $this->postJson("/admin/api/house/withdrawals/$id/reject", ['note' => 'name does not match'], $a)->assertOk();
        $this->assertSame(100000, (int) DB::table('players')->value('balance'), 'a rejected withdrawal gives the money back');
        $this->postJson("/admin/api/house/withdrawals/$id/reject", [], $a)->assertStatus(409);
        $this->assertSame(100000, (int) DB::table('players')->value('balance'));
        $id2 = $req(30000)->assertOk()->json('id');
        $this->postJson("/admin/api/house/withdrawals/$id2/pay", ['payoutRef' => 'GC-PAYOUT-1'], $a)->assertOk()->assertJsonPath('status', 'paid');
        $this->assertSame(70000, (int) DB::table('players')->value('balance'));
        $this->assertSame('GC-PAYOUT-1', $this->getJson('/player/api/wallet', $h)->json('withdrawals.0.payoutRef'));
        $this->assertSame(0, (int) DB::table('wallet_tx')->sum('amount') - 70000, 'the wallet rows add up to the balance');
    }

    /* ---------- the game ---------- */

    public function test_a_registered_player_launches_the_game_bets_and_the_wallet_follows(): void
    {
        [$h, $pid] = $this->funded('maria', '09171234567', 100000);
        $launch = $this->postJson('/player/api/launch', [], $h)->assertOk()->json();
        $this->assertSame('house', $launch['client']);
        $auth = $this->postJson('/api/auth', ['token' => $launch['token'], 'client' => 'house'])->assertOk()->json();
        $this->assertSame('p'.$pid, $auth['playerId']);
        $this->assertSame(100000, $auth['balance']);
        $this->assertSame('/account', $auth['returnUrl']);
        $this->postJson('/api/auth', ['token' => $launch['token'], 'client' => 'house'])->assertStatus(401);      // a launch token works once
        $bearer = ['Authorization' => 'Bearer '.$auth['session']];
        $this->postJson('/api/bet', ['bets' => [['combo' => '1-2', 'stake' => 1000]]], $bearer)->assertOk();
        $this->assertSame(99000, (int) DB::table('players')->value('balance'));
        for ($i = 0; $i < 8; $i++) {
            $this->t += 10000;
            $this->engine->tick();
        }
        $bet = DB::table('bets')->first();
        $this->assertContains($bet->status, ['won', 'lost']);
        $this->assertSame(99000 + (int) $bet->payout, (int) DB::table('players')->value('balance'), 'the payout is in the balance');
        $this->assertSame(0, (int) DB::table('wallet_tx')->sum('amount') - (int) DB::table('players')->value('balance'));
        $this->assertSame('house', $bet->client_id);
        $this->assertSame('maria', $this->getJson('/admin/api/house/players/'.$pid, $this->adminHeaders('support'))->json('player.username'));
    }

    public function test_a_player_cannot_bet_more_than_the_balance(): void
    {
        [$h] = $this->funded('maria', '09171234567', 1000);
        $token = $this->postJson('/player/api/launch', [], $h)->json('token');
        $s = $this->postJson('/api/auth', ['token' => $token, 'client' => 'house'])->json('session');
        $this->postJson('/api/bet', ['bets' => [['combo' => '1-2', 'stake' => 5000]]], ['Authorization' => 'Bearer '.$s])->assertStatus(402)->assertJsonPath('error', 'INSUFFICIENT_FUNDS');
        $this->assertSame(1000, (int) DB::table('players')->value('balance'));
    }

    public function test_suspending_a_player_ends_the_sessions_and_stops_new_ones(): void
    {
        [$h, $pid] = $this->funded();
        $token = $this->postJson('/player/api/launch', [], $h)->json('token');
        $s = $this->postJson('/api/auth', ['token' => $token, 'client' => 'house'])->json('session');
        $a = $this->adminHeaders('support');
        $this->postJson("/admin/api/house/players/$pid/status", ['status' => 'suspended', 'reason' => 'test'], $a)->assertOk();
        $this->postJson('/api/bet', ['bets' => [['combo' => '1-2', 'stake' => 1000]]], ['Authorization' => 'Bearer '.$s])->assertStatus(401);
        $this->getJson('/player/api/me', $h)->assertStatus(401);
        $this->postJson('/player/api/login', ['username' => 'maria', 'password' => 'a good password'], $this->origin)->assertStatus(403)->assertJsonPath('error', 'ACCOUNT_SUSPENDED');
        $this->postJson("/admin/api/house/players/$pid/status", ['status' => 'active'], $a)->assertOk();
        $this->postJson('/player/api/login', ['username' => 'maria', 'password' => 'a good password'], $this->origin)->assertOk();
    }

    /* ---------- the cashier in the admin console ---------- */

    public function test_the_cashier_endpoints_need_the_right_staff_role(): void
    {
        [, $pid] = $this->funded();
        $viewer = $this->adminHeaders('viewer');
        $this->getJson('/admin/api/house/summary', $viewer)->assertStatus(403);
        $this->getJson('/admin/api/house/players', [])->assertStatus(401);
        $this->staff('_operator', 'sam', 'support');
        $support = $this->signIn('admin', null, 'sam')[0];
        $this->getJson('/admin/api/house/summary', $support)->assertOk()->assertJsonPath('summary.players', 1);
        $this->postJson("/admin/api/house/players/$pid/adjust", ['amount' => 500, 'reason' => 'x'], $support)->assertStatus(403);
        $this->postJson('/admin/api/house/settings', ['registration' => false], $support)->assertStatus(403);
    }

    public function test_admins_adjust_balances_with_a_reason_and_set_the_payment_accounts(): void
    {
        [, $pid] = $this->funded('maria', '09171234567', 5000);
        $a = $this->adminHeaders('admin');
        $this->postJson("/admin/api/house/players/$pid/adjust", ['amount' => 2500, 'reason' => 'promo'], $a)->assertOk()->assertJsonPath('balance', 7500);
        $this->postJson("/admin/api/house/players/$pid/adjust", ['amount' => -9999, 'reason' => 'fix'], $a)->assertStatus(402);
        $this->postJson("/admin/api/house/players/$pid/adjust", ['amount' => 100, 'reason' => ''], $a)->assertStatus(400);
        $this->postJson("/admin/api/house/players/$pid/adjust", ['amount' => 1.5, 'reason' => 'x'], $a)->assertStatus(400);
        $this->postJson('/admin/api/house/settings', ['methods' => [['id' => 'maya', 'label' => 'Maya', 'accountName' => 'Ops', 'accountNumber' => '09180000000'], ['id' => 'maya', 'label' => 'Dup', 'accountNumber' => '1']]], $a)->assertStatus(400);
        $this->postJson('/admin/api/house/settings', ['methods' => [['id' => 'maya', 'label' => 'Maya', 'accountName' => 'Ops', 'accountNumber' => '09180000000']], 'minDeposit' => 20000], $a)->assertOk();
        $pub = $this->getJson('/player/api/config')->assertOk()->json('payment');
        $this->assertSame(['maya'], array_column($pub['methods'], 'id'));
        $this->assertSame(20000, $pub['minDeposit']);
        $audit = $this->getJson('/admin/api/audit', $a)->json('entries') ?? [];
        $this->assertNotEmpty(array_filter($audit, fn ($e) => ($e['action'] ?? '') === 'wallet_adjusted'));
    }

    public function test_staff_reset_a_players_password_and_find_players_by_name_or_mobile(): void
    {
        [$h, $pid] = $this->funded();
        $this->register('juan', '09189998888');
        $a = $this->adminHeaders('support');
        $this->assertSame(['juan'], array_column($this->getJson('/admin/api/house/players?q=9998', $a)->json('players'), 'username'));
        $this->assertSame(['maria'], array_column($this->getJson('/admin/api/house/players?q=MAR', $a)->json('players'), 'username'));
        $temp = $this->postJson("/admin/api/house/players/$pid/reset-password", [], $a)->assertOk()->json('tempPassword');
        $this->getJson('/player/api/me', $h)->assertStatus(401);
        $this->postJson('/player/api/login', ['username' => 'maria', 'password' => $temp], $this->origin)->assertOk();
        $this->postJson("/admin/api/house/players/$pid/note", ['note' => 'called, ok'], $a)->assertOk();
        $this->assertSame('called, ok', $this->getJson("/admin/api/house/players/$pid", $a)->json('player.note'));
    }
}
