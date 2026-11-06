<?php

namespace Tests\Feature;

use App\Game\Clients\ClientRegistry;
use App\Game\Engine;
use App\Game\Ledger;
use App\Games\FruitRing\Draw;
use App\Games\FruitRing\FruitService;
use App\Games\FruitRing\Rules;
use App\Game\Clients\SecretBox;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\Client\ConnectionException;
use Illuminate\Http\Client\Request;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Http;
use Tests\TestCase;

/**
 * Fruit Game, the play flow (Phase B): a spin, the double-up, the collect, every way it can fail, and what is left behind each time. The platform is a fake HTTP wallet that can
 * refuse, lose answers and fail credits.
 */
class FruitPlayTest extends TestCase
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
            'games.settings.fruit-ring.lock_wait_seconds' => 0, 'games.settings.fruit-ring.min_interval_ms' => 3000]);
        $this->platform();
        $this->reg = new ClientRegistry('bingo-test-clients-key-0123456789', allowMock: false, allowHttp: false, clock: fn () => $this->t, cacheMs: 0);
        $this->app->instance(ClientRegistry::class, $this->reg);
        $this->engine = new Engine(null, new Ledger, config('horse'), fn () => $this->t, $this->reg, null);
        $this->app->instance(Engine::class, $this->engine);
        $this->client('acme', ['games' => ['horse-race', 'fruit-ring']]);
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

    private const BASE = '/api/games/fruit-ring';

    private function auth(string $who = 'p1', string $client = 'acme'): string
    {
        return $this->postJson(self::BASE.'/auth', ['token' => 'launch-'.$who, 'client' => $client])->assertOk()->json('session');
    }

    private function bearer(string $s): array
    {
        return ['Authorization' => 'Bearer '.$s];
    }

    private function spin(string $s, array $bets = ['apple' => 1], int $credit = 100)
    {
        static $n = 0;
        $this->t += 3500;

        return $this->postJson(self::BASE.'/play', ['bets' => $bets, 'credit' => $credit, 'requestId' => 'req-'.(++$n).'-'.bin2hex(random_bytes(3))], $this->bearer($s));
    }

    private function double(string $s, int $id, string $side, int $step)
    {
        return $this->postJson(self::BASE.'/round/'.$id.'/double', ['side' => $side, 'step' => $step], $this->bearer($s));
    }

    private function collect(string $s, int $id)
    {
        return $this->postJson(self::BASE.'/round/'.$id.'/collect', [], $this->bearer($s));
    }

    private function ledger(): array
    {
        return array_map(fn ($l) => json_decode($l, true), DB::table('ledger')->orderBy('seq')->pluck('line')->all());
    }

    private function sent(string $pathEnd): array
    {
        return collect(Http::recorded())->filter(fn ($x) => str_ends_with((string) parse_url($x[0]->url(), PHP_URL_PATH), $pathEnd))->map(fn ($x) => json_decode($x[0]->body(), true))->values()->all();
    }

    /** puts a known seed pair under the player so that the next spin uses $nonce */
    private function rig(string $who, array $v, int $nonce): void
    {
        $this->auth($who);
        DB::table('player_seeds')->where('player_key', 'acme:'.$who)->where('game_id', 'fruit-ring')->where('status', 'active')->update([
            'server_seed' => SecretBox::encrypt($v['serverSeed'], 'bingo-test-clients-key-0123456789'), 'commit' => $v['commit'], 'client_seed' => $v['clientSeed'], 'next_nonce' => $nonce]);
    }

    /** a known-answer vector whose spin pays on its symbol: [vector, symbol, credits paid per credit bet] */
    private function winner(int $skip = 0): array
    {
        foreach (json_decode(file_get_contents(__DIR__.'/../../docs/fruit/test-vectors.json'), true) as $v) {
            foreach ($v['payouts'] as $sym => $pay) {
                if ($pay > 0 && count($v['rounds']) === 1 && $skip-- <= 0) {
                    return [$v, $sym, $pay];
                }
            }
        }
        $this->fail('no winning vector');
    }

    /** the side that wins the double-up drawn at $nonce, and the side that loses it */
    private function sides(array $v, int $nonce): array
    {
        $n = Draw::doubleNumber($v['serverSeed'], $v['clientSeed'], $nonce);

        return $n <= 7 ? ['small', 'big'] : ['big', 'small'];
    }

    public function test_a_spin_without_a_win_is_settled_and_costs_the_stake(): void
    {
        $s = $this->auth();
        $st = $this->getJson(self::BASE.'/state', $this->bearer($s))->assertOk()->json();
        $this->assertSame(['PHP', 100000, 'fr-v90-2', 20, 100], [$st['currency'], $st['balance'], $st['paytable']['id'], $st['limits']['maxCreditsPerSymbol'], $st['limits']['maxCredits']]);
        [$v] = $this->winner();
        $this->rig('p1', $v, $v['nonce']);
        // bet on a symbol that does not pay in this vector
        $lose = collect(Rules::SYMBOLS)->first(fn ($x) => $v['payouts'][$x] === 0);
        $r = $this->spin($s, [$lose => 2], 100)->assertOk();
        $this->assertSame(['settled', 200, 0, false], [$r->json('round.status'), $r->json('round.stake'), $r->json('round.payout'), $r->json('round.canDouble')]);
        $this->assertSame(['fr:'.$r->json('round.id').':bet'], array_column($this->sent('/wallet/debit'), 'txId'));
        $this->assertSame([], $this->sent('/wallet/credit'));
        $this->assertSame(99800, $this->balance);
        $this->assertSame(['fr.play', 'fr.settled'], array_values(array_filter(array_column($this->ledger(), 'e'), fn ($x) => str_starts_with($x, 'fr.'))));
    }

    public function test_a_win_is_held_and_collecting_credits_it_once(): void
    {
        [$v, $sym, $pay] = $this->winner();
        $s = $this->auth();
        $this->rig('p1', $v, $v['nonce']);
        $r = $this->spin($s, [$sym => 3], 100)->assertOk();
        $id = $r->json('round.id');
        $this->assertSame(['open', 3 * $pay * 100, true, 0], [$r->json('round.status'), $r->json('round.held'), $r->json('round.canDouble'), $r->json('round.payout')]);
        $this->assertSame([], $this->sent('/wallet/credit'), 'nothing is credited while the win is held');
        $this->assertSame(99700, $this->balance);
        $c = $this->collect($s, $id)->assertOk();
        $this->assertSame(['settled', 3 * $pay * 100], [$c->json('round.status'), $c->json('round.payout')]);
        $this->assertSame(['fr:'.$id.':win'], array_column($this->sent('/wallet/credit'), 'txId'));
        $this->assertSame(99700 + 3 * $pay * 100, $this->balance);
        $again = $this->collect($s, $id)->assertOk();
        $this->assertSame(1, count($this->sent('/wallet/credit')), 'collecting twice credits once');
        $this->assertSame('settled', $again->json('round.status'));
    }

    public function test_the_double_up_wins_loses_and_a_repeated_step_returns_the_same_answer(): void
    {
        [$v, $sym, $pay] = $this->winner();
        $s = $this->auth();
        $this->rig('p1', $v, $v['nonce']);
        $id = $this->spin($s, [$sym => 1], 100)->assertOk()->json('round.id');
        [$win, $lose] = $this->sides($v, $v['nonce'] + 1);
        $d1 = $this->double($s, $id, $win, 0)->assertOk();
        $this->assertSame(['open', 2 * $pay * 100, true, 1], [$d1->json('round.status'), $d1->json('round.held'), $d1->json('round.canDouble'), count($d1->json('round.doubles'))]);
        $this->assertTrue($d1->json('round.doubles.0.won'));
        $this->assertSame($v['nonce'] + 1, $d1->json('round.doubles.0.nonce'));
        $rep = $this->double($s, $id, $lose, 0)->assertOk();                                        // the same step again, even with the other side
        $this->assertSame($d1->json('round.doubles'), $rep->json('round.doubles'), 'a repeated step draws nothing new');
        [$win2, $lose2] = $this->sides($v, $v['nonce'] + 2);
        $d2 = $this->double($s, $id, $lose2, 1)->assertOk();
        $this->assertSame(['settled', 0, false], [$d2->json('round.status'), $d2->json('round.payout'), $d2->json('round.canDouble')]);
        $this->assertSame([], $this->sent('/wallet/credit'), 'a lost double-up credits nothing');
        $this->double($s, $id, 'big', 2)->assertStatus(409);
    }

    public function test_three_wins_in_a_row_collect_by_themselves(): void
    {
        [$v, $sym, $pay] = $this->winner();
        $s = $this->auth();
        $this->rig('p1', $v, $v['nonce']);
        $id = $this->spin($s, [$sym => 1], 100)->assertOk()->json('round.id');
        for ($i = 1; $i <= 3; $i++) {
            $r = $this->double($s, $id, $this->sides($v, $v['nonce'] + $i)[0], $i - 1)->assertOk();
        }
        $this->assertSame(['settled', 8 * $pay * 100], [$r->json('round.status'), $r->json('round.payout')]);
        $this->assertSame(['fr:'.$id.':win'], array_column($this->sent('/wallet/credit'), 'txId'));
        $this->assertSame(['fr.play', 'fr.double', 'fr.double', 'fr.double', 'fr.settled'], array_values(array_filter(array_column($this->ledger(), 'e'), fn ($x) => str_starts_with($x, 'fr.'))));
    }

    public function test_a_new_spin_collects_the_held_win_and_the_seed_cannot_be_revealed_while_one_is_held(): void
    {
        [$v, $sym, $pay] = $this->winner();
        $s = $this->auth();
        $this->rig('p1', $v, $v['nonce']);
        $id = $this->spin($s, [$sym => 1], 100)->assertOk()->json('round.id');
        $this->postJson(self::BASE.'/seed/rotate', [], $this->bearer($s))->assertStatus(409)->assertJson(['error' => 'ROUND_OPEN']);
        $second = $this->spin($s, ['apple' => 1], 100)->assertOk();
        $this->assertSame('settled', DB::table('instant_rounds')->where('id', $id)->value('status'));
        $this->assertSame($pay * 100, (int) DB::table('instant_rounds')->where('id', $id)->value('payout'));
        $this->assertContains('fr:'.$id.':win', array_column($this->sent('/wallet/credit'), 'txId'));
        if ($second->json('round.status') === 'open') {
            $this->collect($s, $second->json('round.id'))->assertOk();
        }
        $this->postJson(self::BASE.'/seed/rotate', [], $this->bearer($s))->assertOk();
    }

    public function test_an_idle_player_has_the_held_win_collected_by_the_round_loop(): void
    {
        [$v, $sym, $pay] = $this->winner();
        $s = $this->auth();
        $this->rig('p1', $v, $v['nonce']);
        $id = $this->spin($s, [$sym => 1], 100)->assertOk()->json('round.id');
        $this->assertSame(0, app(FruitService::class)->recoverStuck());
        $this->t += 130000;
        $this->assertSame(1, app(FruitService::class)->recoverStuck());
        $this->assertSame(['settled', $pay * 100], [DB::table('instant_rounds')->where('id', $id)->value('status'), (int) DB::table('instant_rounds')->where('id', $id)->value('payout')]);
        $this->assertContains('fr:'.$id.':win', array_column($this->sent('/wallet/credit'), 'txId'));
    }

    public function test_bad_bets_and_a_repeated_request_id(): void
    {
        $s = $this->auth();
        foreach ([[[], 100], [['apple' => 0], 100], [['pear' => 1], 100], [['apple' => 21], 100], [['apple' => 1], 0], [['apple' => -1], 100], [['apple' => 1.5], 100]] as [$bets, $credit]) {
            $this->t += 3500;
            $this->postJson(self::BASE.'/play', ['bets' => $bets, 'credit' => $credit, 'requestId' => 'bad-'.bin2hex(random_bytes(4))], $this->bearer($s))->assertStatus(400);
        }
        $this->t += 3500;
        $this->postJson(self::BASE.'/play', ['bets' => ['apple' => 20, 'bar' => 20, 'star' => 20, 'bell' => 20, 'lemon' => 20, 'orange' => 20], 'credit' => 100, 'requestId' => 'big-0123456'], $this->bearer($s))->assertStatus(400);   // 120 credits
        $this->assertSame([], $this->sent('/wallet/debit'));
        $a = $this->postJson(self::BASE.'/play', ['bets' => ['apple' => 1], 'credit' => 100, 'requestId' => 'same-request-1'], $this->bearer($s))->assertOk();
        $b = $this->postJson(self::BASE.'/play', ['bets' => ['apple' => 1], 'credit' => 100, 'requestId' => 'same-request-1'], $this->bearer($s))->assertOk();
        $this->assertSame([$a->json('round.id'), true], [$b->json('round.id'), $b->json('repeat')]);
        $this->assertCount(1, $this->sent('/wallet/debit'));
    }

    public function test_a_refused_debit_leaves_nothing_and_a_lost_answer_is_rolled_back(): void
    {
        $s = $this->auth();
        $this->insufficient = 1;
        $this->spin($s)->assertStatus(402);
        $this->assertSame(0, DB::table('instant_rounds')->count());
        $this->loseDebitAnswers = 2;
        $this->spin($s)->assertStatus(502)->assertJsonPath('error', 'WALLET_UNAVAILABLE');
        $this->assertSame('void', DB::table('instant_rounds')->value('status'));
    }

    public function test_the_proof_shows_the_spin_and_the_double_ups_once_the_seed_is_revealed(): void
    {
        [$v, $sym] = $this->winner();
        $s = $this->auth();
        $this->rig('p1', $v, $v['nonce']);
        $id = $this->spin($s, [$sym => 1], 100)->assertOk()->json('round.id');
        $this->double($s, $id, $this->sides($v, $v['nonce'] + 1)[1], 0)->assertOk();
        $this->getJson(self::BASE.'/proof/'.$id, $this->bearer($s))->assertStatus(409)->assertJson(['error' => 'SEED_NOT_REVEALED']);
        $this->postJson(self::BASE.'/seed/rotate', [], $this->bearer($s))->assertOk();
        $p = $this->getJson(self::BASE.'/proof/'.$id, $this->bearer($s))->assertOk();
        $this->assertSame($v['serverSeed'], $p->json('proof.serverSeed'));
        $this->assertSame($v['rounds'], $p->json('proof.rounds'));
        $this->assertCount(1, $p->json('proof.doubles'));
        $this->assertArrayHasKey('double1', $p->json('proof.verify'));
        $this->assertSame($p->json('proof.rounds'), Draw::spin($p->json('proof.serverSeed'), $p->json('proof.clientSeed'), $p->json('proof.nonce')), 'the proof re-runs');
    }

    public function test_the_game_is_off_for_a_client_without_it(): void
    {
        $this->client('beta', ['games' => ['horse-race']]);
        $this->postJson(self::BASE.'/auth', ['token' => 'launch-x', 'client' => 'beta'])->assertStatus(403)->assertJson(['error' => 'GAME_NOT_ENABLED']);
    }
}
