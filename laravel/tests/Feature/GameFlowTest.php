<?php

namespace Tests\Feature;

use App\Game\Engine;
use App\Game\Ledger;
use App\Game\Odds;
use App\Game\Rng;
use App\Game\Wallet\MockWallet;
use App\Game\Wallet\Wallet;
use App\Game\Wallet\WalletException;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Tests\TestCase;

/** a mock wallet that can be told to lose the answer of the next calls */
class FlakyWallet implements Wallet
{
    public int $failDebits = 0;

    public int $failCredits = 0;

    public function __construct(public MockWallet $inner) {}

    public function validateToken(string $token): array { return $this->inner->validateToken($token); }

    public function balance(string $playerId): int { return $this->inner->balance($playerId); }

    public function debit(string $playerId, int $amount, string $txId, array $meta = []): array
    {
        if ($this->failDebits > 0) {
            $this->failDebits--;
            $this->inner->debit($playerId, $amount, $txId, $meta);          // the platform applied it ...
            throw new WalletException('NO_ANSWER');                           // ... but the answer was lost
        }

        return $this->inner->debit($playerId, $amount, $txId, $meta);
    }

    public function credit(string $playerId, int $amount, string $txId, array $meta = []): array
    {
        if ($this->failCredits > 0) {
            $this->failCredits--;
            throw new WalletException('NO_ANSWER');
        }

        return $this->inner->credit($playerId, $amount, $txId, $meta);
    }

    public function rollback(string $playerId, int $amount, string $txId, array $meta = []): array { return $this->inner->rollback($playerId, $amount, $txId, $meta); }
}

class GameFlowTest extends TestCase
{
    use RefreshDatabase;

    private int $t = 1_800_000_000_000;

    private Engine $engine;

    private FlakyWallet $wallet;

    protected function setUp(): void
    {
        parent::setUp();
        config(['horse.controller_key' => 'ctl-key-for-tests', 'horse.bet_ms' => 25000]);
        $this->wallet = new FlakyWallet(new MockWallet(1000000, 'PHP'));
        $this->engine = new Engine($this->wallet, new Ledger, config('horse'), fn () => $this->t);
        $this->app->instance(Engine::class, $this->engine);
    }

    private function login(string $who = 'alice'): string
    {
        $r = $this->postJson('/api/auth', ['token' => 'demo-'.$who])->assertOk()->assertJsonPath('ok', true);

        return $r->json('session');
    }

    private function h(string $s): array { return ['Authorization' => 'Bearer '.$s]; }

    public function test_round_opens_with_a_commit_and_the_public_state_is_what_the_browser_expects(): void
    {
        $this->engine->tick();
        $p = $this->getJson('/api/public')->assertOk()->json();
        $this->assertSame('live', $p['mode']);
        $this->assertSame('betting', $p['round']['phase']);
        $this->assertSame(1, $p['round']['raceNo']);
        $this->assertSame(hash('sha256', DB::table('rounds')->value('seed')), $p['round']['commit']);
        $this->assertSame(['countdown' => 6000, 'race' => 30000, 'results' => 10000, 'bet' => 25000], $p['timings']);
        $this->assertCount(15, $p['round']['odds']);
        $this->assertSame(Odds::combos(), $p['rules']['combos']);
        $this->assertNull($p['race']);
        $this->assertSame([], $p['history']);
    }

    public function test_bad_tokens_and_missing_sessions_are_refused_like_node(): void
    {
        $this->postJson('/api/auth', ['token' => 'nope'])->assertStatus(401)->assertExactJson(['ok' => false, 'error' => 'INVALID_TOKEN']);
        $this->getJson('/api/me')->assertStatus(401)->assertJsonPath('error', 'SESSION_EXPIRED');
        $this->postJson('/api/bet', ['bets' => []])->assertStatus(401);
        $this->getJson('/api/nothing')->assertStatus(404)->assertJsonPath('ok', false);
    }

    public function test_full_race_win_settles_pays_and_can_be_verified(): void
    {
        $this->engine->tick();
        $s = $this->login();
        $bets = array_map(fn ($c) => ['combo' => $c, 'stake' => 1000], Odds::combos());           // all 15 pairs: exactly one wins
        $res = $this->postJson('/api/bet', ['bets' => $bets], $this->h($s))->assertOk()->json();
        $this->assertSame(1000000 - 15000, $res['balance']);
        $this->assertCount(15, $res['bets']);
        $me = $this->getJson('/api/me', $this->h($s))->assertOk()->json();
        $this->assertCount(15, $me['bets']);
        $this->assertSame(1, $me['raceNo']);

        // betting closes: draw, countdown, race, settlement
        $this->t += 25000;
        $this->engine->tick();
        $this->assertSame('racing', DB::table('rounds')->value('status'));
        $this->postJson('/api/bet', ['bets' => [['combo' => '1-2', 'stake' => 100]]], $this->h($s))->assertStatus(409)->assertJsonPath('error', 'BETTING_CLOSED');
        $pub = $this->getJson('/api/public')->json();
        $this->assertNull($pub['race']['order'], 'the order is hidden until two seconds before the start');
        $this->t += 4500;
        $this->assertNotNull($this->getJson('/api/public')->json('race.order'));
        $this->t += 1500 + 30000;
        $this->engine->tick();

        $r = DB::table('rounds')->first();
        $this->assertSame('settled', $r->status);
        $odds = json_decode($r->odds, true);
        $win = Engine::payoutFor(1000, $odds[$r->combo]);
        $this->assertSame(15000, (int) $r->staked);
        $this->assertSame($win, (int) $r->paid);
        $this->assertSame(1000000 - 15000 + $win, $this->wallet->balance('alice'), 'the winner was paid once');
        $this->assertSame(0, DB::table('pending_ops')->count());

        // anyone can verify the draw after the race
        $proof = $this->getJson('/api/round/1')->assertOk()->json();
        $this->assertSame(hash('sha256', $proof['seed']), $proof['commit']);
        $again = Rng::draw($proof['seed'], 1, Odds::buildForRtp($proof['odds'], $proof['rtp'])['weights']);
        $this->assertSame($proof['combo'], $again['combo']);
        $this->assertSame($proof['order'], $again['order']);
        $this->assertEquals(Rng::oddsLayout($proof['seed'], 1, $this->engine->rules()['oddsValues']), $proof['odds'], 'the odds layout is derived from the seed too');
        $this->getJson('/api/round/99')->assertStatus(404);

        $hist = $this->getJson('/api/history', $this->h($s))->assertOk()->json();
        $this->assertSame($r->combo, $hist['rounds'][0]['combo']);
        $this->assertSame(15000, $hist['rounds'][0]['staked']);
        $this->assertSame($win, $hist['rounds'][0]['paid']);
        $me = $this->getJson('/api/me', $this->h($s))->json();
        $this->assertSame($r->combo, $me['last']['combo']);

        // the ledger chain is intact and holds the whole story
        $l = $this->engine->ledger()->verify();
        $this->assertTrue($l['ok']);
        $events = DB::table('ledger')->orderBy('seq')->pluck('line')->map(fn ($x) => json_decode($x, true)['e'])->unique()->values()->all();
        foreach (['open', 'bet', 'draw', 'settled', 'credit_due', 'credit_ok'] as $e) {
            $this->assertContains($e, $events);
        }

        // the next round opens after the results board
        $this->t += 10000;
        $this->engine->tick();
        $this->assertSame(2, (int) DB::table('rounds')->max('race_no'));
    }

    public function test_limits_and_validation(): void
    {
        $this->engine->tick();
        $s = $this->login();
        $this->postJson('/api/bet', ['bets' => [['combo' => '9-9', 'stake' => 1000]]], $this->h($s))->assertStatus(400)->assertJsonPath('error', 'BAD_BET');
        $this->postJson('/api/bet', ['bets' => [['combo' => '1-2', 'stake' => 50]]], $this->h($s))->assertStatus(400)->assertJsonPath('error', 'BAD_BET');
        $this->postJson('/api/bet', ['bets' => [['combo' => '1-2', 'stake' => 10.5]]], $this->h($s))->assertStatus(400)->assertJsonPath('error', 'BAD_BET');
        $this->postJson('/api/bet', ['bets' => []], $this->h($s))->assertStatus(400)->assertJsonPath('error', 'BAD_REQUEST');
        $this->postJson('/api/bet', ['bets' => [['combo' => '1-2', 'stake' => 100000]]], $this->h($s))->assertOk();
        $this->postJson('/api/bet', ['bets' => [['combo' => '1-2', 'stake' => 100]]], $this->h($s))->assertStatus(400)->assertJsonPath('error', 'MAX_BET_EXCEEDED');
        for ($c = ['1-3', '1-4', '1-5', '1-6'], $i = 0; $i < 4; $i++) {
            $this->postJson('/api/bet', ['bets' => [['combo' => $c[$i], 'stake' => 100000]]], $this->h($s))->assertOk();
        }
        $this->postJson('/api/bet', ['bets' => [['combo' => '2-3', 'stake' => 100000]]], $this->h($s))->assertStatus(400)->assertJsonPath('error', 'MAX_ROUND_STAKE_EXCEEDED');
        $poor = $this->login('bob');
        DB::table('mock_accounts')->where('player_id', 'bob')->update(['balance' => 500]);
        $this->postJson('/api/bet', ['bets' => [['combo' => '2-3', 'stake' => 1000]]], $this->h($poor))->assertStatus(402)->assertJsonPath('error', 'INSUFFICIENT_FUNDS');
        $this->assertSame(500, $this->wallet->balance('bob'));
    }

    public function test_daily_loss_limit(): void
    {
        config(['horse.daily_loss_limit' => 5000]);
        $this->engine = new Engine($this->wallet, new Ledger, config('horse'), fn () => $this->t);
        $this->app->instance(Engine::class, $this->engine);
        $this->engine->tick();
        $s = $this->login();
        $this->postJson('/api/bet', ['bets' => [['combo' => '1-2', 'stake' => 4000]]], $this->h($s))->assertOk();
        $this->postJson('/api/bet', ['bets' => [['combo' => '1-3', 'stake' => 1500]]], $this->h($s))->assertStatus(400)->assertJsonPath('error', 'DAILY_LOSS_LIMIT');
    }

    public function test_a_lost_debit_answer_is_rolled_back_and_a_late_debit_is_refused(): void
    {
        $this->engine->tick();
        $s = $this->login();
        $this->wallet->failDebits = 2;                  // the platform debited, but both answers were lost
        $this->postJson('/api/bet', ['bets' => [['combo' => '1-2', 'stake' => 1000]]], $this->h($s))->assertStatus(502)->assertJsonPath('error', 'WALLET_UNAVAILABLE');
        $this->assertSame(0, DB::table('bets')->count(), 'no bet was recorded');
        $this->assertSame(1, DB::table('pending_ops')->where('kind', 'rollback')->count());
        $this->engine->tick();                           // the daemon delivers the rollback
        $this->assertSame(0, DB::table('pending_ops')->count());
        $this->assertSame(1000000, $this->wallet->balance('alice'), 'the player has the money back');
    }

    public function test_a_credit_that_cannot_be_delivered_is_retried_and_applied_once(): void
    {
        $this->engine->tick();
        $s = $this->login();
        $bets = array_map(fn ($c) => ['combo' => $c, 'stake' => 1000], Odds::combos());
        $this->postJson('/api/bet', ['bets' => $bets], $this->h($s))->assertOk();
        $this->t += 25000;
        $this->engine->tick();
        $this->wallet->failCredits = 2;
        $this->t += 6000 + 30000;
        $this->engine->tick();                           // settles; the first delivery fails
        $this->assertSame(1, DB::table('pending_ops')->where('kind', 'credit')->count());
        $this->assertSame(1000000 - 15000, $this->wallet->balance('alice'));
        $this->t += 1000;
        $this->engine->tick();                           // not due yet (it backs off)
        $this->assertSame(1, DB::table('pending_ops')->where('kind', 'credit')->count());
        $this->t += 5000;
        $this->engine->tick();                           // second failure
        $this->assertSame(1, DB::table('pending_ops')->where('kind', 'credit')->count());
        $this->t += 10000;
        $this->engine->tick();                           // delivered
        $this->assertSame(0, DB::table('pending_ops')->count());
        $r = DB::table('rounds')->first();
        $win = Engine::payoutFor(1000, json_decode($r->odds, true)[$r->combo]);
        $this->assertSame(1000000 - 15000 + $win, $this->wallet->balance('alice'));
        $this->engine->flushCredits();                   // nothing left: nothing is paid twice
        $this->assertSame(1000000 - 15000 + $win, $this->wallet->balance('alice'));
    }

    public function test_blocked_players_cannot_start_a_session_and_lose_the_current_one(): void
    {
        $this->engine->tick();
        $s = $this->login();
        $this->postJson('/api/command', ['cmd' => 'blockPlayer', 'playerId' => 'alice'], ['X-Controller-Key' => 'ctl-key-for-tests'])->assertOk()->assertJsonPath('closed', 1);
        $this->getJson('/api/me', $this->h($s))->assertStatus(401);
        $this->postJson('/api/auth', ['token' => 'demo-alice'])->assertStatus(403)->assertJsonPath('error', 'PLAYER_BLOCKED');
        $this->postJson('/api/command', ['cmd' => 'unblockPlayer', 'playerId' => 'alice'], ['X-Controller-Key' => 'ctl-key-for-tests'])->assertOk();
        $this->postJson('/api/auth', ['token' => 'demo-alice'])->assertOk();
    }

    public function test_the_controller_needs_its_key_and_changes_the_rtp_for_the_next_round(): void
    {
        $this->engine->tick();
        $this->postJson('/api/command', ['cmd' => 'setRtp', 'rtp' => 95])->assertStatus(401);
        $this->getJson('/api/report')->assertStatus(401);
        $k = ['X-Controller-Key' => 'ctl-key-for-tests'];
        $this->postJson('/api/command', ['cmd' => 'setRtp', 'rtp' => 50], $k)->assertStatus(400)->assertJsonPath('error', 'RTP_OUT_OF_RANGE');
        $this->postJson('/api/command', ['cmd' => 'setRtp', 'rtp' => 95], $k)->assertOk()->assertJsonPath('rtp', 0.95)->assertJsonPath('appliesFromRace', 2);
        $this->assertEqualsWithDelta(0.9, (float) DB::table('rounds')->value('rtp'), 1e-9, 'the running round keeps its RTP');
        $rep = $this->getJson('/api/report', $k)->assertOk()->json();
        $this->assertSame(0.95, $rep['rtpSetting']);
        $this->assertSame(15, count($rep['wins']));
        $this->t += 25000;
        $this->engine->tick();                           // draw
        $this->t += 36000;
        $this->engine->tick();                           // settle
        $this->t += 10000;
        $this->engine->tick();                           // next round
        $this->assertEqualsWithDelta(0.95, (float) DB::table('rounds')->where('race_no', 2)->value('rtp'), 1e-9);
    }

    public function test_health_needs_the_daemon_and_an_intact_ledger(): void
    {
        $this->getJson('/healthz')->assertStatus(503);
        $this->engine->tick();
        $this->t += 1000;
        $this->getJson('/healthz')->assertOk()->assertJsonPath('ok', true);
        $this->t += 10000;
        $this->getJson('/healthz')->assertStatus(503);
    }

    public function test_the_game_run_command_runs_one_tick(): void
    {
        $this->artisan('game:run --once')->assertSuccessful();
        $this->assertSame(1, DB::table('rounds')->count());
    }

    public function test_ledger_lines_are_byte_identical_to_what_node_writes(): void
    {
        $p = json_decode(file_get_contents(__DIR__.'/../fixtures/parity.json'), true);
        $ledger = new Ledger;
        foreach ($p['ledger']['lines'] as $line) {
            $ev = json_decode(Ledger::stripHash($line), true);
            $this->assertSame($line, $ledger->append($ev));
        }
        $this->assertSame($p['ledger']['head'], $ledger->head());
        $this->assertSame(12, $ledger->lines());
    }
}
