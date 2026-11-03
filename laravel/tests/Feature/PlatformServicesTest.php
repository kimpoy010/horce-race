<?php

namespace Tests\Feature;

use App\Game\Clients\ClientRegistry;
use App\Game\GameError;
use App\Game\Ledger;
use App\Game\Wallet\MockWallet;
use App\Platform\Clients\ClientDirectory;
use App\Platform\Limits\Limits;
use App\Platform\PlayerKey;
use App\Platform\Sessions\Sessions;
use App\Platform\Wallet\WalletGateway;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Tests\TestCase;

/** The platform services every game uses (Phase 1): player keys, the client directory, limits and sessions */
class PlatformServicesTest extends TestCase
{
    use RefreshDatabase;

    private int $t = 1_800_000_000_000;

    private array $cfg;

    private ClientRegistry $reg;

    private ClientDirectory $dir;

    private Sessions $sessions;

    protected function setUp(): void
    {
        parent::setUp();
        $this->cfg = ['min_bet' => 100, 'max_bet' => 100000, 'max_round_stake' => 500000, 'daily_loss_limit' => 0, 'currency' => 'PHP', 'reality_check_minutes' => 0, 'currency_limits' => [], 'session_ttl_ms' => 3600000];
        $this->reg = new ClientRegistry('platform-test-key-0123456789', allowMock: true, clock: fn () => $this->t, cacheMs: 0);
        $this->dir = new ClientDirectory(new MockWallet(10000, 'PHP'), null, $this->reg);
        $limits = new Limits(fn () => $this->t, $this->cfg);
        $ledger = new Ledger;
        $log = fn (array $ev) => $ledger->append($ev + ['t' => $this->t]);
        $gateway = new WalletGateway(fn () => $this->t, $log, fn (string $id) => $this->dir->walletFor($id));
        $this->sessions = new Sessions(fn () => $this->t, $log, $this->cfg, $this->dir, $gateway, $limits);
    }

    public function test_player_keys(): void
    {
        $this->assertSame('alice', PlayerKey::make(null, 'alice'));
        $this->assertSame('alice', PlayerKey::make('default', 'alice'));
        $this->assertSame('acme:alice', PlayerKey::make('acme', 'alice'));
        $this->assertSame(['default', 'alice'], PlayerKey::split('alice'));
        $this->assertSame(['acme', 'alice:with:colons'], PlayerKey::split('acme:alice:with:colons'));
    }

    public function test_the_directory_resolves_clients_wallets_and_state(): void
    {
        $this->reg->create(['id' => 'acme', 'wallet' => ['type' => 'mock']]);
        $this->reg->create(['id' => 'zeta', 'wallet' => ['type' => 'mock'], 'status' => 'disabled']);
        $this->assertSame('default', $this->dir->resolve(null), 'with a default wallet, an unnamed launch is the default client');
        $this->assertSame('acme', $this->dir->resolve('acme'));
        foreach ([['zeta', 403, 'CLIENT_DISABLED'], ['nobody', 400, 'INVALID_CLIENT'], ['Bad Id!', 400, 'INVALID_CLIENT']] as [$id, $status, $code]) {
            try {
                $this->dir->resolve($id);
                $this->fail($code);
            } catch (GameError $e) {
                $this->assertSame([$status, $code], [$e->status, $e->errorCode]);
            }
        }
        $this->assertTrue($this->dir->isActive('acme'));
        $this->assertFalse($this->dir->isActive('zeta'));
        $this->assertTrue($this->dir->isActive('default'));
        $this->assertNotNull($this->dir->walletFor('acme'));
        $this->assertNull($this->dir->walletFor('nobody'));
        $this->assertSame('acme', $this->dir->config('acme')['id']);
        $this->assertSame(['id' => 'x', 'status' => 'active', 'limits' => [], 'currencyLimits' => []], $this->dir->config('x'));
        $none = new ClientDirectory(null, null, $this->reg);
        $this->assertFalse($none->isActive('default'));
        $this->assertSame('acme', $none->resolve(null), 'no default wallet and exactly one active client: an unnamed launch is that client');
        $this->reg->create(['id' => 'beta', 'wallet' => ['type' => 'mock']]);
        $this->expectException(GameError::class);
        $none->resolve(null);                                                       // two active clients, no default: the launch has to name one
    }

    public function test_the_directory_filters_a_query_to_one_clients_players(): void
    {
        foreach (['alice', 'acme:bob', 'zeta:cy'] as $pk) {
            DB::table('blocked_players')->insert(['player_key' => $pk]);
        }
        $this->assertSame(['alice'], ClientDirectory::ofClient(DB::table('blocked_players'), 'default')->pluck('player_key')->all());
        $this->assertSame(['acme:bob'], ClientDirectory::ofClient(DB::table('blocked_players'), 'acme')->pluck('player_key')->all());
    }

    public function test_limits_are_layered_and_only_valid_numbers_count(): void
    {
        $l = new Limits(fn () => $this->t, array_merge($this->cfg, ['currency_limits' => ['PHP' => ['maxBet' => 50000]]]));
        $this->assertSame(['minBet' => 100, 'maxBet' => 100000, 'maxRoundStake' => 500000, 'dailyLossLimit' => 0], (new Limits(fn () => $this->t, $this->cfg))->for('PHP', null));
        $this->assertSame(50000, $l->for('PHP', null)['maxBet'], 'the server table of the currency');
        $client = ['limits' => ['maxBet' => 40000, 'minBet' => 200], 'currencyLimits' => ['PHP' => ['maxBet' => 30000]]];
        $this->assertSame([200, 30000], [$l->for('PHP', null, $client)['minBet'], $l->for('PHP', null, $client)['maxBet']], 'the client, then its table of the currency');
        $x = $l->for('PHP', ['limits' => ['maxBet' => 20000, 'dailyLossLimit' => 5000]], $client);
        $this->assertSame([20000, 5000], [$x['maxBet'], $x['dailyLossLimit']], 'what the platform sends for the player wins');
        $bad = $l->for('PHP', ['limits' => ['maxBet' => -5, 'minBet' => 'x', 'dailyLossLimit' => -1]]);
        $this->assertSame([50000, 100, 0], [$bad['maxBet'], $bad['minBet'], $bad['dailyLossLimit']], 'invalid numbers are ignored');
        $this->assertGreaterThanOrEqual($l->for('PHP', ['limits' => ['minBet' => 90000, 'maxBet' => 1000]])['minBet'], $l->for('PHP', ['limits' => ['minBet' => 90000, 'maxBet' => 1000]])['maxBet'], 'the maximum is never below the minimum');
    }

    public function test_the_daily_loss_figures_count_today_utc_and_skip_refunds(): void
    {
        $l = new Limits(fn () => $this->t, $this->cfg);
        $now = $this->t;
        $row = fn (string $id, int $stake, int $pay, string $status, int $at) => DB::table('bets')->insert(['id' => $id, 'race_no' => 1, 'player_key' => 'alice', 'combo' => '1-2', 'stake' => $stake, 'status' => $status, 'payout' => $pay,
            'currency' => 'PHP', 'brand_id' => null, 'placed_at' => $at, 'client_id' => 'default']);
        $row('a', 1000, 0, 'lost', $now);
        $row('b', 500, 1500, 'won', $now);
        $row('c', 700, 0, 'refunded', $now);
        $row('d', 9999, 0, 'lost', $now - 2 * 86400000);                          // two days ago
        $this->assertSame(['staked' => 1500, 'paid' => 1500], $l->today('alice'));
        $this->assertSame(0, $l->dayNet('alice'));
        $this->assertSame(['staked' => 0, 'paid' => 0], $l->today('nobody'));
    }

    public function test_a_session_is_made_found_expired_and_belongs_to_a_game(): void
    {
        $a = $this->sessions->auth('demo-alice');
        $this->assertSame(['alice', 'PHP', 10000], [$a['playerId'], $a['currency'], $a['balance']]);
        $row = DB::table('game_sessions')->first();
        $this->assertSame(Sessions::key($a['session']), $row->key, 'only the hash of the session id is stored');
        $this->assertSame('horse-race', $row->game_id, 'the horse race by default');
        $this->assertNotNull($this->sessions->find($a['session']));
        $this->assertNull($this->sessions->find(''));
        $this->assertNull($this->sessions->find('unknown'));

        $b = $this->sessions->auth('demo-bob', null, 'bingo-pinball');
        $this->assertSame('bingo-pinball', DB::table('game_sessions')->where('key', Sessions::key($b['session']))->value('game_id'));
        $this->assertNotNull($this->sessions->find($b['session']), 'any game finds its session the same way');

        $this->t += $this->cfg['session_ttl_ms'] + 1;
        $this->assertNull($this->sessions->find($a['session']));
        $this->assertSame(1, DB::table('game_sessions')->count(), 'the expired session was deleted when it was looked up');
    }

    public function test_auth_refuses_bad_launches_and_blocked_players(): void
    {
        foreach ([['nope', 401, 'INVALID_TOKEN'], ['demo-Bad Name', 401, 'INVALID_TOKEN']] as [$token, $status, $code]) {
            try {
                $this->sessions->auth($token);
                $this->fail($code);
            } catch (GameError $e) {
                $this->assertSame([$status, $code], [$e->status, $e->errorCode]);
            }
        }
        $s = $this->sessions->auth('demo-carl');
        $r = $this->sessions->blockPlayer('carl', 'tester');
        $this->assertSame(['ok' => true, 'blocked' => true, 'closed' => 1], $r);
        $this->assertNull($this->sessions->find($s['session']), 'blocking ends the sessions');
        try {
            $this->sessions->auth('demo-carl');
            $this->fail('blocked');
        } catch (GameError $e) {
            $this->assertSame([403, 'PLAYER_BLOCKED'], [$e->status, $e->errorCode]);
        }
        $this->assertSame(['ok' => true, 'blocked' => false], $this->sessions->unblockPlayer('carl', 'tester'));
        $this->assertSame('carl', $this->sessions->auth('demo-carl')['playerId']);
        $this->assertSame(1, $this->sessions->closeSessions('carl'));
        $this->assertSame(0, $this->sessions->closeSessions('carl'));
    }

    public function test_a_disabled_client_ends_its_sessions(): void
    {
        $this->reg->create(['id' => 'acme', 'wallet' => ['type' => 'mock']]);
        $s = $this->sessions->auth('demo-dee', 'acme');
        $this->assertSame('acme:dee', DB::table('game_sessions')->value('player_key'));
        $this->assertNotNull($this->sessions->find($s['session']));
        $this->reg->setStatus('acme', 'disabled');
        $this->assertNull($this->sessions->find($s['session']));
    }
}
