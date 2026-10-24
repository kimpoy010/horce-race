<?php

namespace Tests\Feature;

use App\Game\Clients\ClientRegistry;
use App\Game\Clients\SecretBox;
use App\Game\Engine;
use App\Game\GameError;
use App\Game\Ledger;
use App\Game\Odds;
use App\Game\Wallet\HttpWallet;
use App\Game\Wallet\MockWallet;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Http;
use Tests\TestCase;

class ClientsTest extends TestCase
{
    use RefreshDatabase;

    private int $t = 1_800_000_000_000;

    private ClientRegistry $reg;

    private Engine $engine;

    private const KEY = 'clients-key-for-tests-1234';

    protected function setUp(): void
    {
        parent::setUp();
        config(['horse.controller_key' => 'ctl-key-for-tests', 'horse.wallet' => 'none', 'horse.clients_key' => self::KEY]);
        $this->reg = new ClientRegistry(self::KEY, allowMock: true, allowHttp: false, clock: fn () => $this->t, cacheMs: 0);
        $this->app->instance(ClientRegistry::class, $this->reg);
        $this->engine = new Engine(null, new Ledger, config('horse'), fn () => $this->t, $this->reg, null);     // registry clients only (HORSE_WALLET=none)
        $this->app->instance(Engine::class, $this->engine);
    }

    private function mockClient(string $id, array $extra = []): array
    {
        return $this->reg->create(['id' => $id, 'name' => ucfirst($id), 'wallet' => ['type' => 'mock']] + $extra);
    }

    private function login(string $client, string $who = 'p1'): string
    {
        return $this->postJson('/api/auth', ['client' => $client, 'token' => 'demo-'.$who])->assertOk()->json('session');
    }

    private function h(string $s): array { return ['Authorization' => 'Bearer '.$s]; }

    public function test_node_encrypted_secrets_and_clients_are_readable_here(): void
    {
        $p = json_decode(file_get_contents(__DIR__.'/../fixtures/parity.json'), true)['clients'];
        $this->assertSame($p['plain'], SecretBox::decrypt($p['enc'], $p['key']), 'a secret encrypted by Node');
        $again = SecretBox::encrypt($p['plain'], $p['key']);
        $this->assertStringStartsWith('enc:v1:', $again);
        $this->assertNotSame($again, SecretBox::encrypt($p['plain'], $p['key']), 'a fresh IV every time');
        $this->assertSame($p['plain'], SecretBox::decrypt($again, $p['key']));
        $this->expectException(\RuntimeException::class);
        SecretBox::decrypt($p['enc'], 'the wrong key');
    }

    public function test_the_node_clients_file_can_be_imported_and_its_api_key_still_works(): void
    {
        $p = json_decode(file_get_contents(__DIR__.'/../fixtures/parity.json'), true)['clients'];
        $f = tempnam(sys_get_temp_dir(), 'clients');
        file_put_contents($f, $p['file']);
        $this->artisan('clients', ['action' => 'import', 'id' => $f])->assertSuccessful();
        unlink($f);
        $c = $this->reg->get('acme');
        $this->assertSame('wallet-secret-acme-1234567890', $c['wallet']['secret']);
        $this->assertStringNotContainsString('wallet-secret-acme', DB::table('clients')->where('id', 'acme')->value('data'), 'stored encrypted');
        $this->assertSame(['minBet' => 200, 'maxBet' => 50000], $c['limits']);
        $this->assertNotNull($this->reg->authenticate($p['apiKey'], '203.0.113.7'), 'the key made by Node works');
        $this->assertNull($this->reg->authenticate($p['apiKey'], '198.51.100.1'), 'outside the allowed IP range');
    }

    public function test_validation_refuses_bad_settings_with_a_message(): void
    {
        $bad = fn (array $c) => $this->postJson('/api/clients', $c, ['X-Controller-Key' => 'ctl-key-for-tests']);
        $bad(['id' => 'A', 'wallet' => ['type' => 'mock']])->assertStatus(400)->assertJsonPath('error', 'BAD_CLIENT');
        $bad(['id' => 'acme', 'wallet' => ['url' => 'http://example.com/x', 'secret' => str_repeat('s', 20)]])->assertStatus(400)->assertJsonPath('message', 'wallet.url must be https (http only for localhost)');
        $bad(['id' => 'acme', 'wallet' => ['url' => 'https://example.com/x', 'secret' => 'short']])->assertStatus(400);
        $bad(['id' => 'acme', 'wallet' => ['type' => 'mock'], 'limits' => ['minBet' => 500, 'maxBet' => 100]])->assertStatus(400);
        $bad(['id' => 'acme', 'wallet' => ['type' => 'mock'], 'allowedIps' => ['not-an-ip']])->assertStatus(400);
        $bad(['id' => 'acme', 'wallet' => ['type' => 'mock'], 'currency' => 'php'])->assertStatus(400);
        $this->postJson('/api/clients', ['id' => 'acme'])->assertStatus(401);
        $this->assertSame(0, $this->reg->count());
    }

    public function test_the_operator_manages_a_client_and_every_change_is_in_the_ledger(): void
    {
        $k = ['X-Controller-Key' => 'ctl-key-for-tests'];
        $made = $this->postJson('/api/clients', ['client' => ['id' => 'acme', 'name' => 'Acme', 'currency' => 'PHP', 'wallet' => ['url' => 'https://platform.acme.example/horse-api'],
            'webhook' => ['url' => 'https://platform.acme.example/events']]], $k)->assertOk()->json();
        $this->assertMatchesRegularExpression('/^hrk_acme_[0-9a-f]{48}$/', $made['apiKey']);
        $this->assertMatchesRegularExpression('/^[0-9a-f]{64}$/', $made['walletSecret'], 'generated once and returned once');
        $this->assertStringStartsWith('***', $made['client']['wallet']['secret']);
        $this->assertArrayNotHasKey('hash', $made['client']['apiKeys'][0]);
        $this->postJson('/api/clients', ['id' => 'acme', 'wallet' => ['type' => 'mock']], $k)->assertStatus(409)->assertJsonPath('error', 'CLIENT_EXISTS');
        $this->getJson('/api/clients', $k)->assertOk()->assertJsonPath('clients.0.id', 'acme')->assertJsonPath('clients.0.stats.bets', 0)->assertJsonPath('defaultClient', false);
        $this->getJson('/api/clients/acme', $k)->assertOk()->assertJsonPath('client.name', 'Acme');
        $this->postJson('/api/clients/acme', ['client' => ['name' => 'Acme Casino', 'limits' => ['maxBet' => 2000]]], $k)->assertOk()->assertJsonPath('client.name', 'Acme Casino');
        $this->postJson('/api/clients/acme/status', ['status' => 'disabled'], $k)->assertOk()->assertJsonPath('client.status', 'disabled');
        $this->postJson('/api/clients/acme/delete', [], $k)->assertStatus(400)->assertJsonPath('error', 'CONFIRM_REQUIRED');
        $this->postJson('/api/clients/acme/delete', ['confirm' => 'acme'], $k)->assertOk();
        $this->getJson('/api/clients/acme', $k)->assertStatus(404);
        $actions = DB::table('ledger')->orderBy('seq')->pluck('line')->map(fn ($l) => json_decode($l, true))->where('e', 'client_admin')->pluck('action')->all();
        $this->assertSame(['created', 'updated', 'disabled', 'deleted'], array_values($actions));
    }

    public function test_players_of_two_clients_do_not_meet_and_use_their_own_wallets(): void
    {
        $this->mockClient('acme');
        $this->mockClient('zeta');
        $this->engine->tick();
        $this->postJson('/api/auth', ['token' => 'demo-p1'])->assertStatus(400)->assertJsonPath('error', 'CLIENT_REQUIRED');
        $this->postJson('/api/auth', ['client' => 'nope-co', 'token' => 'demo-p1'])->assertStatus(400)->assertJsonPath('error', 'INVALID_CLIENT');
        $a = $this->login('acme');
        $z = $this->login('zeta');
        $this->postJson('/api/bet', ['bets' => [['combo' => '1-2', 'stake' => 1000]]], $this->h($a))->assertOk()->assertJsonPath('balance', 999000);
        $this->assertSame(1000000, (new MockWallet(scope: 'zeta'))->balance('p1'), 'the same player id at another client is untouched');
        $this->postJson('/api/bet', ['bets' => [['combo' => '1-2', 'stake' => 3000]]], $this->h($z))->assertOk()->assertJsonPath('balance', 997000);
        $this->assertEqualsCanonicalizing(['acme:p1', 'zeta:p1'], DB::table('bets')->pluck('player_key')->all());
        $this->assertSame(1000, (int) DB::table('bets')->where('player_key', 'acme:p1')->sum('stake'));
        $this->assertSame(3000, (int) DB::table('bets')->where('player_key', 'zeta:p1')->sum('stake'));
        // a launch with a single client may leave the client out
        $this->reg->remove('zeta');
        $this->postJson('/api/auth', ['token' => 'demo-p2'])->assertOk()->assertJsonPath('playerId', 'p2');
        // the zeta session ended with its client
        $this->getJson('/api/me', $this->h($z))->assertStatus(401);
        $this->getJson('/api/me', $this->h($a))->assertOk();
    }

    public function test_a_disabled_client_cannot_launch_and_its_sessions_end(): void
    {
        $this->mockClient('acme');
        $this->engine->tick();
        $s = $this->login('acme');
        $this->reg->setStatus('acme', 'disabled');
        $this->getJson('/api/me', $this->h($s))->assertStatus(401);
        $this->postJson('/api/auth', ['client' => 'acme', 'token' => 'demo-p1'])->assertStatus(403)->assertJsonPath('error', 'CLIENT_DISABLED');
    }

    public function test_client_limits_currency_and_return_link_apply(): void
    {
        $this->mockClient('acme', ['currency' => 'USD', 'limits' => ['minBet' => 500, 'maxBet' => 2000, 'maxRoundStake' => 3000], 'returnUrlHosts' => ['lobby.acme.example'], 'realityCheckMinutes' => 30]);
        $this->engine->tick();
        $r = $this->postJson('/api/auth', ['client' => 'acme', 'token' => 'demo-p1'])->assertOk()->json();
        $this->assertSame('USD', $r['currency']);
        $this->assertSame(['minBet' => 500, 'maxBet' => 2000, 'maxRoundStake' => 3000, 'dailyLossLimit' => 0], $r['limits']);
        $this->assertSame(30, $r['responsible']['realityCheckMinutes']);
        $h = $this->h($r['session']);
        $this->postJson('/api/bet', ['bets' => [['combo' => '1-2', 'stake' => 400]]], $h)->assertStatus(400)->assertJsonPath('error', 'BAD_BET');
        $this->postJson('/api/bet', ['bets' => [['combo' => '1-2', 'stake' => 2000], ['combo' => '1-3', 'stake' => 2000]]], $h)->assertStatus(400)->assertJsonPath('error', 'MAX_ROUND_STAKE_EXCEEDED');
        $this->postJson('/api/bet', ['bets' => [['combo' => '1-2', 'stake' => 2000]]], $h)->assertOk();
    }

    public function test_the_client_api_is_limited_to_the_clients_own_players_and_its_key(): void
    {
        $acme = $this->mockClient('acme');
        $zeta = $this->mockClient('zeta');
        $this->engine->tick();
        $sa = $this->login('acme', 'ann');
        $this->login('zeta', 'ann');
        $this->postJson('/api/bet', ['bets' => [['combo' => '1-2', 'stake' => 1000]]], $this->h($sa))->assertOk();
        $ka = $this->h($acme['apiKey']);
        $this->getJson('/api/client/info')->assertStatus(401)->assertJsonPath('error', 'INVALID_API_KEY');
        $this->getJson('/api/client/info', ['Authorization' => 'Bearer hrk_acme_'.str_repeat('0', 48)])->assertStatus(401);
        $this->getJson('/api/client/info', $ka)->assertOk()->assertJsonPath('client.id', 'acme')->assertJsonMissingPath('client.apiKeys.0.hash');
        $rep = $this->getJson('/api/client/report', $ka)->assertOk()->json();
        $this->assertSame('acme', $rep['clientId']);
        $this->assertSame(1, $rep['activeSessions']);
        $this->assertSame(0, $this->getJson('/api/client/report', $this->h($zeta['apiKey']))->json('bets'));
        $hist = $this->getJson('/api/client/history?playerId=ann', $ka)->assertOk()->json();
        $this->assertSame('ann', $hist['playerId']);
        $this->assertSame('acme', $hist['clientId']);
        $this->assertCount(1, $hist['rounds']);
        $this->getJson('/api/client/history?playerId=bad:id', $ka)->assertStatus(400)->assertJsonPath('error', 'BAD_REQUEST');
        // block, which ends the sessions and refuses new launches; unblock
        $this->postJson('/api/client/players/block', ['playerId' => 'ann'], $ka)->assertOk()->assertJsonPath('closed', 1);
        $this->postJson('/api/auth', ['client' => 'acme', 'token' => 'demo-ann'])->assertStatus(403)->assertJsonPath('error', 'PLAYER_BLOCKED');
        $this->assertSame(0, $this->getJson('/api/client/report', $this->h($zeta['apiKey']))->json('blockedPlayers'));
        $this->postJson('/api/client/players/unblock', ['playerId' => 'ann'], $ka)->assertOk();
        $s2 = $this->login('acme', 'ann');
        $this->postJson('/api/client/players/close-sessions', ['playerId' => 'ann'], $ka)->assertOk()->assertJsonPath('closed', 1);
        $this->getJson('/api/me', $this->h($s2))->assertStatus(401);
        $this->getJson('/api/client/nothing', $ka)->assertStatus(404);
    }

    public function test_key_rotation_with_a_grace_time_and_revocation(): void
    {
        $c = $this->mockClient('acme');
        $old = $c['apiKey'];
        $new = $this->reg->rotateKey('acme', 3600_000)['apiKey'];
        $this->assertNotNull($this->reg->authenticate($old, '1.1.1.1'));
        $this->assertNotNull($this->reg->authenticate($new, '1.1.1.1'));
        $this->t += 3600_001;
        $this->assertNull($this->reg->authenticate($old, '1.1.1.1'), 'the old key ended with its grace time');
        $this->assertNotNull($this->reg->authenticate($new, '1.1.1.1'));
        $this->reg->rotateKey('acme', 0);
        $this->assertNull($this->reg->authenticate($new, '1.1.1.1'), 'grace 0 revokes at once');
        $keys = $this->reg->get('acme')['apiKeys'];
        $this->assertCount(3, $keys);
        $this->reg->revokeKey('acme', 'k3');
        $this->assertCount(2, $this->reg->get('acme')['apiKeys']);
    }

    public function test_ten_wrong_keys_block_the_address(): void
    {
        $c = $this->mockClient('acme');
        Cache::flush();
        for ($i = 0; $i < 10; $i++) {
            $this->assertNull($this->reg->authenticate('hrk_acme_'.str_repeat('a', 48), '9.9.9.9'));
        }
        $this->assertNull($this->reg->authenticate($c['apiKey'], '9.9.9.9'), 'blocked even with the right key');
        $this->assertNotNull($this->reg->authenticate($c['apiKey'], '8.8.8.8'), 'other addresses are not affected');
        $this->t += 300_001;
        $this->assertNotNull($this->reg->authenticate($c['apiKey'], '9.9.9.9'), 'free again after five minutes');
    }

    public function test_ip_allow_list_matches_exact_addresses_and_cidr(): void
    {
        $this->assertTrue(ClientRegistry::ipAllowed([], '1.2.3.4'));
        $this->assertTrue(ClientRegistry::ipAllowed(['10.0.0.0/8'], '10.200.1.1'));
        $this->assertFalse(ClientRegistry::ipAllowed(['10.0.0.0/8'], '11.0.0.1'));
        $this->assertTrue(ClientRegistry::ipAllowed(['203.0.113.5'], '203.0.113.5'));
        $this->assertTrue(ClientRegistry::ipAllowed(['203.0.113.0/24'], '::ffff:203.0.113.99'));
        $this->assertFalse(ClientRegistry::ipAllowed(['203.0.113.5'], '203.0.113.6'));
        $this->assertTrue(ClientRegistry::ipAllowed(['2001:db8::1'], '2001:db8::1'));
    }

    public function test_each_client_gets_its_own_webhooks_with_its_own_figures(): void
    {
        $zetaUp = false;
        Http::fake(function ($req) use (&$zetaUp) {
            return str_contains($req->url(), 'zeta') && ! $zetaUp ? Http::response('', 500) : Http::response('ok', 200);
        });
        $hook = fn ($host) => ['url' => 'https://hook.'.$host.'.example/events', 'secret' => str_repeat('k', 24), 'events' => 'round.settled,big.win'];
        $this->mockClient('acme', ['webhook' => $hook('acme'), 'bigWinMin' => 1000]);
        $this->mockClient('zeta', ['webhook' => $hook('zeta')]);
        $this->engine->tick();
        $a = $this->login('acme', 'ann');
        $z = $this->login('zeta', 'zed');
        $bets = array_map(fn ($c) => ['combo' => $c, 'stake' => 1000], Odds::combos());
        $this->postJson('/api/bet', ['bets' => $bets], $this->h($a))->assertOk();
        $this->postJson('/api/bet', ['bets' => [['combo' => '1-2', 'stake' => 500]]], $this->h($z))->assertOk();
        $this->t += 25000;
        $this->engine->tick();
        $this->t += 36000;
        $this->engine->tick();

        Http::assertSent(function ($req) {
            if ($req->url() !== 'https://hook.acme.example/events') {
                return false;
            }
            $b = $req->data();

            return $b['type'] === 'round.settled' && $b['clientId'] === 'acme' && $b['id'] === 'horse-race:acme:round:1' && $b['data']['bets'] === 15 && $b['data']['staked'] === 15000
                && $req->hasHeader('X-Signature') && $req->hasHeader('X-Nonce') && $req->hasHeader('X-Timestamp') && $b['data']['seed'] !== '';
        });
        $bigWins = DB::table('pending_ops')->where('kind', 'webhook')->get();
        $this->assertTrue($bigWins->contains(fn ($o) => str_contains($o->tx_id, 'zeta:round:1')), 'zeta answered 500: the webhook waits and is retried');
        $this->assertFalse($bigWins->contains(fn ($o) => str_contains($o->tx_id, 'acme:round:1')), 'acme confirmed: nothing left to deliver');
        $this->t += 10000;
        $zetaUp = true;
        $this->engine->tick();
        $this->assertSame(0, DB::table('pending_ops')->where('kind', 'webhook')->count(), 'delivered after the platform recovered');
        $types = DB::table('ledger')->orderBy('seq')->pluck('line')->map(fn ($l) => json_decode($l, true))->whereIn('e', ['webhook_due', 'webhook_ok'])->pluck('e')->countBy()->all();
        $this->assertGreaterThanOrEqual(2, $types['webhook_ok']);
    }

    public function test_http_wallet_calls_are_signed_like_node_and_use_the_clients_secret(): void
    {
        Http::fake(['https://platform.acme.example/*' => Http::response(['ok' => true, 'playerId' => 'p9', 'currency' => 'PHP', 'balance' => 5000, 'returnUrl' => 'https://evil.example/x'], 200)]);
        $this->reg->create(['id' => 'acme', 'wallet' => ['url' => 'https://platform.acme.example/horse-api', 'secret' => 'wallet-secret-acme-1234567890', 'keyId' => 'w1'], 'returnUrlHosts' => ['lobby.acme.example']]);
        $this->engine->tick();
        $r = $this->postJson('/api/auth', ['client' => 'acme', 'token' => 'launch-token'])->assertOk()->json();
        $this->assertSame('p9', $r['playerId']);
        $this->assertNull($r['returnUrl'], 'a return link outside returnUrlHosts is dropped');
        $this->assertSame(5000, $r['balance']);
        Http::assertSent(function ($req) {
            $text = $req->body();
            $path = '/horse-api/session/validate';
            $sig = \App\Game\Wallet\Signer::signature('wallet-secret-acme-1234567890', $req->header('X-Timestamp')[0], $req->header('X-Nonce')[0], 'POST', $path, $text);

            return str_ends_with($req->url(), $path) && $req->header('X-Signature')[0] === $sig && $req->header('X-Key-Id')[0] === 'w1' && json_decode($text, true) === ['token' => 'launch-token'];
        });
    }
}
