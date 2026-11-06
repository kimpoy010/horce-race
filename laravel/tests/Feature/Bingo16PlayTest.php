<?php

namespace Tests\Feature;

use App\Game\Clients\ClientRegistry;
use App\Game\Engine;
use App\Game\Ledger;
use App\Games\BingoPinball16\Draw;
use App\Games\BingoPinball16\Evaluator;
use App\Game\Clients\SecretBox;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\Client\ConnectionException;
use Illuminate\Http\Client\Request;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Http;
use Tests\TestCase;

require_once __DIR__.'/../../bin/bingo16-verify.php';

/**
 * Bingo Pinball, the play flow (Phase 3): a whole play, every way it can fail, and what is left behind each time. The platform is a fake HTTP wallet that can
 * refuse, lose answers and fail credits.
 */
class Bingo16PlayTest extends TestCase
{
    use RefreshDatabase;

    private int $t = 1_800_000_000_000;

    private ClientRegistry $reg;

    private Engine $engine;

    /* the fake platform */
    private int $balance = 100000;

    private string $currency = 'PHP';

    private int $refuseDebits = 0;        // answers 4xx: certainly not applied

    private int $insufficient = 0;        // answers 402 INSUFFICIENT_FUNDS

    private int $loseDebitAnswers = 0;    // applies the debit, answer lost

    private int $failCredits = 0;         // no answer to a credit

    private bool $hookDown = false;

    private array $debited = [];

    private array $credited = [];

    private array $rolledBack = [];

    protected function setUp(): void
    {
        parent::setUp();
        config(['horse.clients_key' => 'bingo-test-clients-key-0123456789', 'horse.controller_key' => 'ctl', 'horse.wallet' => 'none', 'horse.big_win_min' => 1000000,
            'games.settings.bingo-pinball-16.lock_wait_seconds' => 0, 'games.settings.bingo-pinball-16.min_interval_ms' => 3000]);
        $this->platform();
        $this->reg = new ClientRegistry('bingo-test-clients-key-0123456789', allowMock: false, allowHttp: false, clock: fn () => $this->t, cacheMs: 0);
        $this->app->instance(ClientRegistry::class, $this->reg);
        $this->engine = new Engine(null, new Ledger, config('horse'), fn () => $this->t, $this->reg, null);
        $this->app->instance(Engine::class, $this->engine);
        $this->client('acme', ['games' => ['horse-race', 'bingo-pinball-16']]);
    }

    private function client(string $id, array $extra = []): array
    {
        return $this->reg->create(['id' => $id, 'name' => ucfirst($id), 'currency' => 'PHP', 'wallet' => ['url' => "https://wallet.$id.test/api", 'secret' => 'wallet-secret-'.$id.'-0123456789', 'keyId' => 'w1'],
            'webhook' => ['url' => "https://hook.$id.test/events", 'secret' => 'hook-secret-'.$id.'-0123456789', 'events' => 'round.settled,big.win']] + $extra);
    }

    private function platform(): void
    {
        Http::fake(function (Request $req) {
            $host = (string) parse_url($req->url(), PHP_URL_HOST);
            $path = (string) parse_url($req->url(), PHP_URL_PATH);
            $b = json_decode($req->body(), true) ?: [];
            if (str_starts_with($host, 'hook.')) {
                return $this->hookDown ? Http::response('', 500) : Http::response('ok', 200);
            }
            switch ($path) {
                case '/api/session/validate':
                    return Http::response(['ok' => true, 'playerId' => preg_replace('/^launch-/', '', $b['token']), 'currency' => $this->currency, 'balance' => $this->balance, 'brandId' => 'brand-a'], 200);
                case '/api/wallet/balance':
                    return Http::response(['ok' => true, 'balance' => $this->balance], 200);
                case '/api/wallet/debit':
                    if ($this->refuseDebits > 0) {
                        $this->refuseDebits--;

                        return Http::response(['ok' => false, 'error' => 'REJECTED'], 400);
                    }
                    if ($this->insufficient > 0) {
                        $this->insufficient--;

                        return Http::response(['ok' => false, 'error' => 'INSUFFICIENT_FUNDS'], 402);
                    }
                    if (! isset($this->debited[$b['txId']]) && ! isset($this->rolledBack[$b['txId']])) {
                        $this->debited[$b['txId']] = $b['amount'];
                        $this->balance -= $b['amount'];
                    }
                    if ($this->loseDebitAnswers > 0) {
                        $this->loseDebitAnswers--;
                        throw new ConnectionException('timeout');
                    }

                    return Http::response(['ok' => true, 'balance' => $this->balance], 200);
                case '/api/wallet/credit':
                    if ($this->failCredits > 0) {
                        $this->failCredits--;
                        throw new ConnectionException('timeout');
                    }
                    if (! isset($this->credited[$b['txId']])) {
                        $this->credited[$b['txId']] = $b['amount'];
                        $this->balance += $b['amount'];
                    }

                    return Http::response(['ok' => true, 'balance' => $this->balance], 200);
                case '/api/wallet/rollback':
                    if (isset($this->debited[$b['txId']]) && ! isset($this->rolledBack[$b['txId']])) {
                        $this->balance += $this->debited[$b['txId']];
                    }
                    $this->rolledBack[$b['txId']] = true;

                    return Http::response(['ok' => true, 'status' => 'rolled_back', 'balance' => $this->balance], 200);
            }

            return Http::response(['ok' => false, 'error' => 'NOT_FOUND'], 404);
        });
    }

    /* ---------- helpers ---------- */

    private const BASE = '/api/games/bingo-pinball-16';

    private function auth(string $who = 'p1', string $client = 'acme'): string
    {
        return $this->postJson(self::BASE.'/auth', ['token' => 'launch-'.$who, 'client' => $client])->assertOk()->json('session');
    }

    private function bearer(string $s): array
    {
        return ['Authorization' => 'Bearer '.$s];
    }

    private function play(string $s, int $stake = 1000, ?string $requestId = null)
    {
        static $n = 0;

        return $this->postJson(self::BASE.'/play', ['stake' => $stake, 'requestId' => $requestId ?? 'req-'.(++$n).'-'.bin2hex(random_bytes(3))], $this->bearer($s));
    }

    /** plays one game and moves the clock on past the minimum interval */
    private function next(string $s, int $stake = 1000)
    {
        $this->t += 3500;

        return $this->play($s, $stake);
    }

    private function ledger(): array
    {
        return array_map(fn ($l) => json_decode($l, true), DB::table('ledger')->orderBy('seq')->pluck('line')->all());
    }

    private function sent(string $pathEnd): array
    {
        return collect(Http::recorded())->filter(fn ($x) => str_ends_with((string) parse_url($x[0]->url(), PHP_URL_PATH), $pathEnd))->map(fn ($x) => json_decode($x[0]->body(), true))->values()->all();
    }

    /** plays until a game wins (about 4 in 10 do); returns the response */
    private function playUntilWin(string $s)
    {
        for ($i = 0; $i < 60; $i++) {
            $r = $this->next($s);
            if ($r->json('round.payout') > 0) {
                return $r;
            }
        }
        $this->fail('no win in 60 plays');
    }

    private function pool(): ?object
    {
        return DB::table('jackpot_pools')->where('id', 'bingo-pinball-16:PHP')->first();
    }

    /** puts a known-answer play (docs/bingo16/test-vectors.json) under the player's next nonce: the play that follows is that vector */
    private function rigNextPlay(string $who, array $v): void
    {
        $this->auth($who);                                                                          // creates the player's seed pair
        $pk = 'acme:'.$who;
        DB::table('player_seeds')->where('player_key', $pk)->where('game_id', 'bingo-pinball-16')->where('status', 'active')->update([
            'server_seed' => SecretBox::encrypt($v['serverSeed'], 'bingo-test-clients-key-0123456789'), 'commit' => $v['commit'], 'client_seed' => $v['clientSeed'], 'next_nonce' => $v['nonce']]);
    }

    private function vector(callable $want): array
    {
        foreach (json_decode(file_get_contents(__DIR__.'/../../docs/bingo16/test-vectors.json'), true) as $v) {
            if ($want($v)) {
                return $v;
            }
        }
        $this->fail('no such vector');
    }

    public function test_a_whole_play_from_the_launch_to_the_proof(): void
    {
        $s = $this->auth();
        $st = $this->getJson(self::BASE.'/state', $this->bearer($s))->assertOk()->json();
        $this->assertSame(['PHP', 100000, 'b16-v90-1', 16, 16], [$st['currency'], $st['balance'], $st['paytable']['id'], $st['paytable']['balls'], $st['paytable']['slots']]);
        $this->assertSame(10000, $st['jackpot']['amount'], 'the pool starts at its seed');
        $this->assertNull($st['last']);
        $r = $this->play($s, 1000)->assertOk()->json();
        $round = $r['round'];
        $ref = 'b16:'.$round['id'];
        $this->assertSame('settled', $round['status']);
        $this->assertCount(16, $round['balls']);
        $this->assertCount(5, $round['jackpotNumbers']);
        $e = Evaluator::evaluate($round['balls'], $round['jackpotNumbers']);
        $this->assertSame([$e['pattern'], $e['multiple'] * 1000 + $round['jackpotPaid']], [$round['pattern'], $round['payout']]);
        $this->assertSame([$ref.':bet'], array_column($this->sent('/wallet/debit'), 'txId'));
        $this->assertSame(['b16.play', 'b16.settled'], array_values(array_filter(array_column($this->ledger(), 'e'), fn ($x) => str_starts_with($x, 'b16.'))));
        $this->assertSame(10014, $this->pool()->amount, 'a 1.48% share of the stake (14 of 1,000) went into the pool unless the play won it');
        // after the seed pair is revealed the play can be re-run, here and with the standalone verifier
        $this->getJson(self::BASE.'/proof/'.$round['id'], $this->bearer($s))->assertStatus(409)->assertJsonPath('error', 'SEED_NOT_REVEALED');
        $this->postJson(self::BASE.'/seed/rotate', [], $this->bearer($s))->assertOk();
        $p = $this->getJson(self::BASE.'/proof/'.$round['id'], $this->bearer($s))->assertOk()->json('proof');
        $d = Draw::play($p['serverSeed'], $p['clientSeed'], $p['nonce']);
        $this->assertSame([$round['balls'], $round['jackpotNumbers']], [$d['balls'], $d['jackpotNumbers']]);
        $this->assertSame(hash('sha256', $p['serverSeed']), $p['commit']);
        [$vb] = b16_draw($p['serverSeed'], $p['clientSeed'], $p['nonce']);
        $this->assertSame($round['balls'], $vb);
        $this->postJson(self::BASE.'/round/'.$round['id'].'/seen', [], $this->bearer($s))->assertOk();
        $this->assertCount(1, $this->getJson(self::BASE.'/history', $this->bearer($s))->json('rounds'));
    }

    public function test_a_jackpot_pays_the_whole_pool_on_top_of_the_pattern_and_the_pool_restarts_from_its_seed(): void
    {
        $v = $this->vector(fn ($x) => $x['jackpot'] && $x['multiple'] > 0);
        $this->rigNextPlay('p1', $v);
        $s = $this->auth('p1');
        $r = $this->play($s, 2000)->assertOk()->json('round');
        $this->assertSame($v['balls'], $r['balls']);
        $this->assertTrue($r['jackpot']);
        $contribution = intdiv(2000 * 148, 10000);
        $this->assertSame(10000 + $contribution, $r['jackpotPaid'], 'the whole pool, including this stake\'s share');
        $this->assertSame(2000 * $v['multiple'] + 10000 + $contribution, $r['payout']);
        $this->assertSame(10000, $this->pool()->amount, 'the pool restarts from the seed');
        $p = $this->pool();
        $this->assertSame((int) $p->amount, (int) $p->seeded + (int) $p->contributed - (int) $p->paid, 'pool = seed money + contributions - jackpots paid');
        $this->assertSame([1, 10000 + $contribution, 20000], [(int) $p->wins, (int) $p->paid, (int) $p->seeded]);
        $events = array_column($this->ledger(), 'e');
        foreach (['jackpot.seed', 'jackpot.add', 'jackpot.win'] as $e) {
            $this->assertContains($e, $events);
        }
        $this->assertSame([$r['payout']], array_column($this->sent('/wallet/credit'), 'amount'), 'one credit for pattern and jackpot together');
    }

    public function test_the_pool_grows_by_every_stake_and_what_it_holds_is_always_accounted_for(): void
    {
        $s = $this->auth('p2');
        $paid = 0;
        for ($i = 0; $i < 12; $i++) {
            $r = $this->next($s, 1000 + $i * 100)->json('round');
            $paid += $r['jackpotPaid'];
        }
        $p = $this->pool();
        $this->assertSame((int) $p->amount, (int) $p->seeded + (int) $p->contributed - (int) $p->paid);
        $this->assertSame($paid, (int) $p->paid);
        $this->assertSame(array_sum(array_map(fn ($i) => intdiv((1000 + $i * 100) * 148, 10000), range(0, 11))), (int) $p->contributed);
    }

    public function test_a_refused_or_lost_debit_leaves_no_round_and_no_trace_in_the_pool(): void
    {
        $s = $this->auth();
        $this->refuseDebits = 1;
        $this->play($s, 1000)->assertStatus(502)->assertJsonPath('error', 'WALLET_REJECTED');
        $this->insufficient = 1;
        $this->next($s, 1000)->assertStatus(402)->assertJsonPath('error', 'INSUFFICIENT_FUNDS');
        $this->assertSame(0, DB::table('instant_rounds')->where('game_id', 'bingo-pinball-16')->count());
        $this->loseDebitAnswers = 2;
        $this->next($s, 1000)->assertStatus(502)->assertJsonPath('error', 'WALLET_UNAVAILABLE');
        $this->assertSame('void', DB::table('instant_rounds')->where('game_id', 'bingo-pinball-16')->value('status'));
        $this->assertSame(10000, $this->pool()->amount, 'no stake was kept, so nothing went into the pool');
        $this->assertSame(0, (int) $this->pool()->contributed);
    }

    public function test_a_repeated_request_id_is_the_same_play_and_the_stake_is_taken_once(): void
    {
        $s = $this->auth();
        $a = $this->play($s, 1000, 'same-request-id-1')->assertOk()->json();
        $b = $this->play($s, 1000, 'same-request-id-1')->assertOk()->json();
        $this->assertSame([false, true, $a['round']['id']], [$a['repeat'], $b['repeat'], $b['round']['id']]);
        $this->assertCount(1, $this->sent('/wallet/debit'));
        $this->assertSame(1, (int) DB::table('instant_rounds')->where('game_id', 'bingo-pinball-16')->count());
    }

    public function test_other_currencies_play_without_the_jackpot(): void
    {
        $this->currency = 'USD';
        $s = $this->auth('p3');
        $st = $this->getJson(self::BASE.'/state', $this->bearer($s))->assertOk()->json();
        $this->assertNull($st['jackpot']);
        $r = $this->play($s, 1000)->assertOk()->json('round');
        $this->assertSame(0, $r['jackpotPaid']);
        $this->assertNull(DB::table('jackpot_pools')->where('id', 'bingo-pinball-16:USD')->first());
        $this->assertSame($r['patternPay'], $r['payout']);
    }

    public function test_the_game_is_off_unless_the_client_has_it_and_the_launch_token_is_kept(): void
    {
        $this->client('plain');                                                                      // no list of its own: the defaults, and this game is not in them
        $this->postJson(self::BASE.'/auth', ['token' => 'launch-p1', 'client' => 'plain'])->assertStatus(403)->assertJsonPath('error', 'GAME_NOT_ENABLED');
        $this->assertCount(0, $this->sent('/session/validate'), 'the launch token was not used up');
        $s = $this->auth();
        $this->reg->update('acme', ['games' => ['horse-race']]);
        $this->play($s)->assertStatus(403)->assertJsonPath('error', 'GAME_NOT_ENABLED');
    }

    public function test_a_session_of_another_game_cannot_play_it_and_limits_apply(): void
    {
        $s = $this->auth();
        $this->play($s, 1)->assertStatus(400)->assertJsonPath('error', 'BAD_BET');
        $this->play($s, 99999999)->assertStatus(400)->assertJsonPath('error', 'BAD_BET');
        $this->postJson(self::BASE.'/play', ['stake' => 1000, 'requestId' => 'x'], $this->bearer($s))->assertStatus(400)->assertJsonPath('error', 'BAD_REQUEST');
        $this->getJson(self::BASE.'/state')->assertStatus(401);
        $this->play($s, 1000, 'too-fast-test-1')->assertOk();
        $this->play($s, 1000, 'too-fast-test-2')->assertStatus(429)->assertJsonPath('error', 'TOO_FAST');
    }

    public function test_a_platform_sees_the_game_in_its_list_when_it_has_it(): void
    {
        $key = $this->reg->rotateKey('acme', 0)['apiKey'];
        $g = $this->getJson('/api/client/games', ['Authorization' => 'Bearer '.$key])->assertOk()->json('games');
        $this->assertContains('bingo-pinball-16', array_column($g, 'id'));
        $one = collect($g)->firstWhere('id', 'bingo-pinball-16');
        $this->assertSame(rtrim(config('app.url'), '/').'/games/bingo-pinball-16?client=acme', $one['launchUrl']);
    }
}
