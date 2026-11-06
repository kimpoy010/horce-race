<?php

namespace Tests\Feature;

use App\Game\Clients\ClientRegistry;
use App\Game\Engine;
use App\Game\Ledger;
use App\Games\BingoPinball\BingoPinballService;
use App\Games\BingoPinball\Draw;
use App\Games\BingoPinball\Evaluator;
use App\Games\BingoPinball\Paytables;
use App\Games\BingoPinball\SeedService;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\Client\ConnectionException;
use Illuminate\Http\Client\Request;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Http;
use Tests\TestCase;

require_once __DIR__.'/../../bin/bingo-verify.php';

/**
 * Bingo Pinball, the play flow (Phase 3): a whole play, every way it can fail, and what is left behind each time. The platform is a fake HTTP wallet that can
 * refuse, lose answers and fail credits.
 */
class BingoPlayTest extends TestCase
{
    use RefreshDatabase;

    private int $t = 1_800_000_000_000;

    private ClientRegistry $reg;

    private Engine $engine;

    /* the fake platform */
    private int $balance = 100000;

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
            'games.settings.bingo-pinball.lock_wait_seconds' => 0, 'games.settings.bingo-pinball.min_interval_ms' => 3000]);
        $this->platform();
        $this->reg = new ClientRegistry('bingo-test-clients-key-0123456789', allowMock: false, allowHttp: false, clock: fn () => $this->t, cacheMs: 0);
        $this->app->instance(ClientRegistry::class, $this->reg);
        $this->engine = new Engine(null, new Ledger, config('horse'), fn () => $this->t, $this->reg, null);
        $this->app->instance(Engine::class, $this->engine);
        $this->client('acme', ['games' => ['horse-race', 'bingo-pinball'], 'gameSettings' => ['bingo-pinball' => ['paytable' => 96]]]);
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
                    return Http::response(['ok' => true, 'playerId' => preg_replace('/^launch-/', '', $b['token']), 'currency' => 'PHP', 'balance' => $this->balance, 'brandId' => 'brand-a'], 200);
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

    private const BASE = '/api/games/bingo-pinball';

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

    /* ---------- a whole play ---------- */

    public function test_a_whole_play_from_the_launch_to_the_proof(): void
    {
        $s = $this->auth();
        $state = $this->getJson(self::BASE.'/state', $this->bearer($s))->assertOk()->json();
        $this->assertSame(['PHP', 100000, 96, 'bp-v96-1'], [$state['currency'], $state['balance'], $state['paytable']['version'], $state['paytable']['id']]);
        $this->assertSame([2, 6, 150], array_values($state['paytable']['pays']));
        $this->assertCount(25, $state['paytable']['card']);
        $this->assertMatchesRegularExpression('/^[0-9a-f]{64}$/', $state['seed']['commit']);
        $this->assertSame([1, 0], [$state['seed']['nextNonce'], $state['seed']['plays']]);
        $this->assertNull($state['last']);

        $r = $this->play($s, 1000)->assertOk()->json();
        $round = $r['round'];
        $ref = 'bp:'.$round['id'];                                                                      // (a database does not start its ids at 1 in every test)
        $this->assertSame(['settled', 1000, 1, $ref], [$round['status'], $round['stake'], $round['nonce'], $round['ref']]);
        $this->assertCount(5, array_unique($round['holes']));
        $pt = Paytables::get(96);
        $e = Evaluator::evaluate($pt->card, $round['holes']);
        $this->assertSame([$e['lit'], $pt->payout(1000, $e['lit'])], [$round['bestLit'], $round['payout']], 'paid by the paytable of the client');
        $this->assertSame($this->balance, $r['balance'], 'the answer carries the balance the wallet reported');
        $this->assertSame([100000 - 1000 + $round['payout']], [$this->balance]);

        $debit = $this->sent('/wallet/debit')[0];
        $this->assertSame(['p1', 1000, $ref.':bet', 'bingo-pinball', $ref, 'bet'], [$debit['playerId'], $debit['amount'], $debit['txId'], $debit['gameId'], $debit['roundId'], $debit['transactionType']]);

        $events = $this->ledger();
        $this->assertSame(array_merge(['seed.commit', 'bp.play', 'bp.settled'], $round['payout'] > 0 ? ['credit_due', 'credit_ok'] : []), array_column($events, 'e'));
        $this->assertSame(['bingo-pinball'], array_values(array_unique(array_column($events, 'game'))), 'every event names the game');
        $this->assertTrue((new Ledger)->verify()['ok']);
        $play = $events[1];
        $this->assertSame([1, $state['seed']['commit'], 'acme:p1', $ref.':bet'], [$play['nonce'], $play['commit'], $play['playerId'], $play['txId']]);

        // a result can be checked once the seed is revealed
        $this->getJson(self::BASE.'/proof/1', $this->bearer($s))->assertStatus(409)->assertJsonPath('error', 'SEED_NOT_REVEALED');
        $rot = $this->postJson(self::BASE.'/seed/rotate', ['clientSeed' => 'my-own-seed'], $this->bearer($s))->assertOk()->json();
        $this->assertSame($state['seed']['commit'], $rot['revealed']['commit']);
        $proof = $this->getJson(self::BASE.'/proof/1', $this->bearer($s))->assertOk()->json('proof');
        $this->assertSame($round['holes'], Draw::holes($proof['serverSeed'], $proof['clientSeed'], $proof['nonce']), 'anyone can re-run the draw');
        $this->assertSame($proof['commit'], Draw::commitOf($proof['serverSeed']));
        $v = \bp_verify($proof['serverSeed'], $proof['clientSeed'], $proof['nonce'], 96, 1000);
        $this->assertSame([$round['holes'], $round['payout']], [$v['holes'], $v['payout']], 'the standalone verifier agrees');
        $this->assertStringContainsString('bingo-verify.php --server-seed', $proof['verify']);
    }

    public function test_a_win_is_credited_at_once_and_a_big_win_is_announced(): void
    {
        $this->reg->update('acme', ['bigWinMin' => 1]);
        $s = $this->auth();
        $r = $this->playUntilWin($s)->json();
        $ref = $r['round']['ref'];
        $this->engine->tick();                                                                          // the round loop delivers the queued webhooks
        $credit = collect($this->sent('/wallet/credit'))->firstWhere('txId', $ref.':win');
        $this->assertSame([$r['round']['payout'], 'bingo-pinball', $ref, 'win'], [$credit['amount'], $credit['gameId'], $credit['roundId'], $credit['transactionType']]);
        $this->assertSame(0, DB::table('pending_ops')->where('tx_id', $ref.':win')->count(), 'delivered, nothing left in the queue');
        $this->assertFalse($r['round']['creditPending']);
        $hook = collect($this->sent('/events'))->firstWhere('type', 'big.win');
        $this->assertSame(['bingo-pinball', 'bingo-pinball:acme:win:'.$ref, $r['round']['payout']], [$hook['gameId'], $hook['id'], $hook['data']['payout']]);
        $this->assertNull(collect($this->sent('/events'))->firstWhere('type', 'round.settled'), 'no webhook for every play unless the client asked for them');
    }

    public function test_a_client_can_ask_for_a_webhook_for_every_play(): void
    {
        $this->reg->update('acme', ['gameSettings' => ['bingo-pinball' => ['paytable' => 96, 'roundWebhooks' => true]]]);
        $s = $this->auth();
        $r = $this->next($s)->json('round');
        $this->engine->tick();                                                                          // the round loop delivers the queued webhooks
        $hook = collect($this->sent('/events'))->firstWhere('type', 'round.settled');
        $this->assertSame(['bingo-pinball', $r['ref'], $r['holes']], [$hook['gameId'], $hook['data']['roundId'], $hook['data']['holes']]);
    }

    /* ---------- the ways a play can fail ---------- */

    private function nothingWasKept(int $nonces = 0): void
    {
        $this->assertSame(0, DB::table('instant_rounds')->count(), 'no round row is left behind');
        $this->assertSame([], array_values(array_filter(array_column($this->ledger(), 'e'), fn ($e) => str_starts_with($e, 'bp.'))), 'nothing was drawn or settled');
        $this->assertSame($nonces + 1, (int) DB::table('player_seeds')->value('next_nonce'), 'the nonce was not used');
    }

    public function test_insufficient_funds_charges_nothing_and_uses_no_nonce(): void
    {
        $s = $this->auth();
        $this->insufficient = 1;
        $this->play($s)->assertStatus(402)->assertJsonPath('error', 'INSUFFICIENT_FUNDS');
        $this->nothingWasKept();
        $this->assertSame(100000, $this->balance);
    }

    public function test_a_wallet_that_says_no_charges_nothing(): void
    {
        $s = $this->auth();
        $this->refuseDebits = 1;
        $this->play($s)->assertStatus(502)->assertJsonPath('error', 'WALLET_REJECTED');
        $this->nothingWasKept();
    }

    public function test_a_lost_debit_answer_voids_the_play_and_rolls_the_debit_back(): void
    {
        $s = $this->auth();
        $this->loseDebitAnswers = 2;                                                                    // applied by the platform, answer lost twice
        $r = $this->play($s, 1000, 'lost-answer-1')->assertStatus(502)->assertJsonPath('error', 'WALLET_UNAVAILABLE');
        $this->assertSame(99000, $this->balance, 'the platform did take the stake');
        $round = DB::table('instant_rounds')->first();
        $ref = 'bp:'.$round->id;
        $this->assertSame(['void', null, null], [$round->status, $round->nonce, $round->holes], 'no draw for a play that was not confirmed');
        $this->assertSame(1, (int) DB::table('player_seeds')->value('next_nonce'));
        $op = DB::table('pending_ops')->first();
        $this->assertSame(['rb:'.$ref.':bet', 'rollback', 'bingo-pinball', $ref], [$op->tx_id, $op->kind, $op->game_id, $op->round_ref]);
        $this->assertSame(['seed.commit', 'debit_unknown', 'rollback_due', 'bp.void'], array_column($this->ledger(), 'e'));

        $this->engine->tick();                                                                          // the round loop delivers the rollback
        $rb = $this->sent('/wallet/rollback')[0];
        $this->assertSame([$ref.':bet', 'bingo-pinball', $ref, 'rollback'], [$rb['txId'], $rb['gameId'], $rb['roundId'], $rb['transactionType']]);
        $this->assertSame(100000, $this->balance, 'the player has the stake back');
        $this->assertSame(0, DB::table('pending_ops')->count());
        $this->postJson(self::BASE.'/play', ['stake' => 1000, 'requestId' => 'lost-answer-1'], $this->bearer($s))->assertStatus(409)->assertJsonPath('error', 'ROUND_VOID');
        $this->assertCount(1, $this->debited, 'the repeat did not debit again');
        $this->assertTrue($this->next($s)->assertOk()->json('round.nonce') === 1, 'the next play, with a new request id, is the first draw');
    }

    public function test_a_credit_the_platform_does_not_answer_is_retried_with_back_off_until_it_has_it(): void
    {
        $s = $this->auth();
        $this->failCredits = 2;
        $r = $this->playUntilWin($s)->json();
        $ref = $r['round']['ref'];
        $this->assertTrue($r['round']['creditPending'], 'the answer says the win is still on its way');
        $op = DB::table('pending_ops')->where('tx_id', $ref.':win')->first();
        $this->assertSame([1, 2000], [(int) $op->tries, (int) $op->next_at - $this->t]);
        $this->t += 2000;
        $this->engine->tick();
        $this->assertSame([2, 4000], [(int) DB::table('pending_ops')->where('tx_id', $ref.':win')->value('tries'), (int) DB::table('pending_ops')->where('tx_id', $ref.':win')->value('next_at') - $this->t]);
        $this->t += 4000;
        $this->engine->tick();
        $this->assertSame(0, DB::table('pending_ops')->where('tx_id', $ref.':win')->count());
        $this->assertSame($r['round']['payout'], $this->credited[$ref.':win'], 'credited once');
        $this->assertFalse($this->getJson(self::BASE.'/round/'.$r['round']['id'], $this->bearer($s))->json('round.creditPending'));
    }

    public function test_the_same_request_twice_is_one_play_and_one_debit(): void
    {
        $s = $this->auth();
        $a = $this->play($s, 1000, 'same-request-1')->assertOk()->json();
        $b = $this->play($s, 1000, 'same-request-1')->assertOk()->json();
        $this->assertSame([false, true], [$a['repeat'], $b['repeat']]);
        $this->assertSame($a['round'], array_replace($b['round'], ['seen' => $a['round']['seen']]) + [], 'the very same round');
        $this->assertCount(1, $this->sent('/wallet/debit'));
        $this->assertSame(1, DB::table('instant_rounds')->count());
        $this->assertSame(2, (int) DB::table('player_seeds')->value('next_nonce'));
        $this->postJson(self::BASE.'/play', ['stake' => 1000, 'requestId' => 'bad id!'], $this->bearer($s))->assertStatus(400)->assertJsonPath('error', 'BAD_REQUEST');
        $this->postJson(self::BASE.'/play', ['stake' => '1000', 'requestId' => 'text-stake-1'], $this->bearer($s))->assertStatus(400);
        $this->postJson(self::BASE.'/play', ['requestId' => 'no-stake-0001'], $this->bearer($s))->assertStatus(400);
    }

    public function test_two_plays_at_the_same_time_are_not_possible_for_one_player(): void
    {
        $s = $this->auth();
        $lock = Cache::lock('horse-player:acme:p1', 20);
        $this->assertTrue($lock->get(), 'the player is busy with a bet of the horse race');
        $this->play($s)->assertStatus(429)->assertJsonPath('error', 'TOO_MANY_REQUESTS');
        $this->assertSame(0, DB::table('instant_rounds')->count());
        $lock->release();
        $this->next($s)->assertOk();
    }

    public function test_a_blocked_player_cannot_play_or_come_back(): void
    {
        $s = $this->auth();
        $this->engine->blockPlayer('acme:p1', 'tester');
        $this->play($s)->assertStatus(401)->assertJsonPath('error', 'SESSION_EXPIRED');
        $this->postJson(self::BASE.'/auth', ['token' => 'launch-p1', 'client' => 'acme'])->assertStatus(403)->assertJsonPath('error', 'PLAYER_BLOCKED');
        $this->assertCount(0, $this->sent('/wallet/debit'));
        $this->engine->unblockPlayer('acme:p1', 'tester');
        $this->next($this->auth())->assertOk();
    }

    public function test_a_disabled_client_cannot_play(): void
    {
        $s = $this->auth();
        $this->reg->setStatus('acme', 'disabled');
        $this->play($s)->assertStatus(401);
        $this->postJson(self::BASE.'/auth', ['token' => 'launch-p1', 'client' => 'acme'])->assertStatus(403)->assertJsonPath('error', 'CLIENT_DISABLED');
        $this->assertCount(0, $this->sent('/wallet/debit'));
    }

    public function test_the_game_is_reachable_only_for_clients_that_have_it_and_the_launch_token_is_kept(): void
    {
        config(['games.settings.bingo-pinball.default_paytable' => 0]);                                  // (no usable server default: a client without a paytable of its own cannot play)
        $this->client('plain', ['games' => ['horse-race']]);                                             // an operator left the game out of this client's list
        $this->client('unset', ['games' => ['horse-race', 'bingo-pinball']]);                           // has the game but no paytable
        $this->postJson(self::BASE.'/auth', ['token' => 'launch-p1', 'client' => 'plain'])->assertStatus(403)->assertJsonPath('error', 'GAME_NOT_ENABLED');
        $this->postJson(self::BASE.'/auth', ['token' => 'launch-p1', 'client' => 'unset'])->assertStatus(409)->assertJsonPath('error', 'GAME_NOT_CONFIGURED');
        $this->postJson(self::BASE.'/auth', ['token' => 'launch-p1', 'client' => 'nobody'])->assertStatus(400)->assertJsonPath('error', 'INVALID_CLIENT');
        $this->assertCount(0, $this->sent('/session/validate'), 'the platform was never asked to use up the launch token');
        $s = $this->auth();
        $this->reg->update('acme', ['games' => ['horse-race']]);                                         // the operator switches it off while the player is in the game
        $this->play($s)->assertStatus(403)->assertJsonPath('error', 'GAME_NOT_ENABLED');
        $this->getJson(self::BASE.'/state', $this->bearer($s))->assertStatus(403);
        $this->assertCount(0, $this->sent('/wallet/debit'));
        $this->reg->update('acme', ['games' => ['horse-race', 'bingo-pinball'], 'gameSettings' => []]);
        $this->getJson(self::BASE.'/state', $this->bearer($s))->assertStatus(409)->assertJsonPath('error', 'GAME_NOT_CONFIGURED');
    }

    public function test_a_session_of_the_horse_race_cannot_play_bingo(): void
    {
        $this->engine->tick();
        $horse = $this->postJson('/api/auth', ['token' => 'launch-p1', 'client' => 'acme'])->assertOk()->json('session');
        $this->assertSame('horse-race', DB::table('game_sessions')->value('game_id'));
        $this->getJson(self::BASE.'/state', $this->bearer($horse))->assertStatus(403)->assertJsonPath('error', 'WRONG_GAME');
        $this->play($horse)->assertStatus(403);
        $bingo = $this->auth();
        $this->assertSame(['horse-race', 'bingo-pinball'], DB::table('game_sessions')->orderBy('created_at')->orderBy('game_id', 'desc')->pluck('game_id')->all());
        $this->postJson('/api/bet', ['bets' => [['combo' => '1-2', 'stake' => 1000]]], $this->bearer($bingo))->assertStatus(401);
    }

    public function test_limits_are_enforced_and_the_operator_can_narrow_them(): void
    {
        $this->reg->update('acme', ['gameSettings' => ['bingo-pinball' => ['paytable' => 96, 'limits' => ['minBet' => 500, 'maxBet' => 2000]]], 'limits' => ['dailyLossLimit' => 2500]]);
        $s = $this->auth();
        $this->assertSame([500, 2000], [$this->getJson(self::BASE.'/state', $this->bearer($s))->json('limits.minBet'), $this->getJson(self::BASE.'/state', $this->bearer($s))->json('limits.maxBet')]);
        $this->play($s, 400)->assertStatus(400)->assertJsonPath('error', 'BAD_BET');
        $this->play($s, 2001)->assertStatus(400)->assertJsonPath('error', 'BAD_BET');
        DB::table('instant_rounds')->insert(['game_id' => 'bingo-pinball', 'player_key' => 'acme:p1', 'client_id' => 'acme', 'stake' => 2000, 'currency' => 'PHP', 'paytable_id' => 'bp-v96-1', 'paytable_version' => 96,
            'payout' => 0, 'status' => 'settled', 'request_id' => 'earlier-loss-1', 'created_at' => $this->t - 60000, 'seen_at' => $this->t]);          // lost 2000 earlier today
        $this->t += 3500;
        $this->play($s, 600)->assertStatus(400)->assertJsonPath('error', 'DAILY_LOSS_LIMIT');
        $this->play($s, 500)->assertOk();                                                                // exactly up to the limit
        $this->assertCount(1, $this->sent('/wallet/debit'), 'a refused play never reached the wallet');
    }

    public function test_plays_must_be_at_least_three_seconds_apart(): void
    {
        $s = $this->auth();
        $this->play($s)->assertOk();
        $this->t += 2000;
        $this->play($s)->assertStatus(429)->assertJsonPath('error', 'TOO_FAST');
        $this->t += 1000;
        $this->play($s)->assertOk();
        $this->assertSame(2, DB::table('instant_rounds')->count());
    }

    /* ---------- seeds, rounds and what the player sees ---------- */

    public function test_the_seed_pair_is_replaced_after_its_plays_and_every_play_can_be_proved(): void
    {
        config(['games.settings.bingo-pinball.rotate_every' => 2]);
        $s = $this->auth();
        $first = $this->getJson(self::BASE.'/state', $this->bearer($s))->json('seed.commit');
        $ids = [];
        for ($i = 0; $i < 5; $i++) {
            $ids[] = $this->next($s)->assertOk()->json('round.id');
        }
        $this->assertSame([1, 2, 1, 2, 1], DB::table('instant_rounds')->orderBy('id')->pluck('nonce')->map(fn ($n) => (int) $n)->all(), 'the nonce starts again with every new pair');
        $this->assertSame(3, DB::table('player_seeds')->count());
        $this->assertSame(['seed.commit', 'seed.reveal', 'seed.commit', 'seed.reveal', 'seed.commit'], array_values(array_filter(array_column($this->ledger(), 'e'), fn ($e) => str_starts_with($e, 'seed.'))));
        $this->getJson(self::BASE.'/proof/'.$ids[4], $this->bearer($s))->assertStatus(409)->assertJsonPath('error', 'SEED_NOT_REVEALED');
        foreach (array_slice($ids, 0, 4) as $id) {
            $p = $this->getJson(self::BASE.'/proof/'.$id, $this->bearer($s))->assertOk()->json();
            $this->assertSame($p['round']['holes'], Draw::holes($p['proof']['serverSeed'], $p['proof']['clientSeed'], $p['proof']['nonce']));
        }
        $this->assertSame($first, $this->getJson(self::BASE.'/proof/'.$ids[0], $this->bearer($s))->json('proof.commit'), 'the first plays were drawn under the first commit that was shown');
    }

    public function test_the_page_is_told_about_a_result_it_has_not_shown_yet(): void
    {
        $s = $this->auth();
        $id = $this->next($s)->json('round.id');
        $state = $this->getJson(self::BASE.'/state', $this->bearer($s))->json();
        $this->assertSame([true, $id, false], [$state['unseen'], $state['last']['id'], $state['unfinished']], 'a page that lost its connection can show the result again');
        $this->postJson(self::BASE."/round/$id/seen", [], $this->bearer($s))->assertOk();
        $this->assertFalse($this->getJson(self::BASE.'/state', $this->bearer($s))->json('unseen'));
        $second = $this->next($s)->json('round.id');
        $this->assertTrue($this->getJson(self::BASE.'/round/'.$second, $this->bearer($s))->json('round.id') === $second);
        $this->assertTrue($this->getJson(self::BASE.'/state', $this->bearer($s))->json('unseen'));
        $this->next($s)->assertOk();
        $this->assertTrue((bool) DB::table('instant_rounds')->where('id', $second)->value('seen_at'), 'playing on counts as having seen the one before');
    }

    public function test_history_and_rounds_belong_to_their_player(): void
    {
        $a = $this->auth('ann');
        $b = $this->auth('bob');
        $ra = $this->next($a)->json('round.id');
        $this->next($b);
        $this->assertSame([$ra], array_column($this->getJson(self::BASE.'/history', $this->bearer($a))->json('rounds'), 'id'));
        $this->getJson(self::BASE.'/round/'.$ra, $this->bearer($b))->assertStatus(404);
        $this->getJson(self::BASE.'/proof/'.$ra, $this->bearer($b))->assertStatus(404);
        $this->postJson(self::BASE."/round/$ra/seen", [], $this->bearer($b))->assertStatus(404);
        $this->assertSame('acme:ann', DB::table('player_seeds')->orderBy('id')->value('player_key'));
        $this->assertNotSame(DB::table('player_seeds')->where('player_key', 'acme:ann')->value('commit'), DB::table('player_seeds')->where('player_key', 'acme:bob')->value('commit'), 'every player has their own pair');
    }

    public function test_many_plays_leave_an_intact_ledger_and_the_nonces_in_order(): void
    {
        $s = $this->auth();
        for ($i = 0; $i < 25; $i++) {
            $this->next($s)->assertOk();
        }
        $this->assertSame(range(1, 25), DB::table('instant_rounds')->orderBy('id')->pluck('nonce')->map(fn ($n) => (int) $n)->all());
        $this->assertTrue((new Ledger)->verify()['ok'], 'one intact hash chain');
        $this->assertSame(25, count(array_filter($this->ledger(), fn ($e) => $e['e'] === 'bp.settled')));
        $sum = DB::table('instant_rounds')->sum('payout');
        $this->assertSame(100000 - 25000 + (int) $sum, $this->balance, 'the wallet and the rounds agree to the centavo');
        $this->assertSame(0, DB::table('pending_ops')->count());
    }

    /* ---------- a crash between the debit and the draw ---------- */

    public function test_a_play_that_dies_after_the_debit_is_cancelled_and_refunded_by_the_round_loop(): void
    {
        $s = $this->auth();
        $this->play($s)->assertOk();                                                                    // one normal play first
        $seed = DB::table('player_seeds')->first();
        DB::table('player_seeds')->where('id', $seed->id)->update(['server_seed' => 'enc:v1:'.base64_encode(str_repeat('a', 12)).':'.base64_encode(str_repeat('b', 16)).':'.base64_encode('garbage')]);      // the draw will fail after the wallet took the stake
        $this->t += 3500;
        $this->withoutExceptionHandling();
        try {
            $this->play($s, 1000, 'crash-request-1');
            $this->fail('the draw should have failed');
        } catch (\Throwable $e) {
            $this->assertStringContainsString('cannot be decrypted', $e->getMessage());
        }
        $round = DB::table('instant_rounds')->where('request_id', 'crash-request-1')->first();
        $this->assertSame(['debiting', null], [$round->status, $round->nonce], 'the stake was taken, nothing was drawn');
        $this->assertSame(2, (int) DB::table('player_seeds')->value('next_nonce'), 'no nonce was used up');
        $this->assertSame(1, count(array_filter(array_column($this->ledger(), 'e'), fn ($e) => $e === 'bp.play')), 'the failed transaction left nothing in the ledger: only the first play is there');

        $svc = $this->app->make(BingoPinballService::class);
        $this->assertSame(0, $svc->recoverStuck(), 'too soon: the play may still be finishing');
        $this->t += 31000;
        $locked = Cache::lock('horse-player:acme:p1', 20);
        $this->assertTrue($locked->get());
        $this->assertSame(0, $svc->recoverStuck(), 'the player is in the middle of something: later');
        $locked->release();
        $this->assertSame(1, $svc->recoverStuck());
        $this->assertSame('void', DB::table('instant_rounds')->where('id', $round->id)->value('status'));
        $this->assertSame('bp.void', collect($this->ledger())->last()['e']);
        $this->assertSame('stuck', collect($this->ledger())->last()['reason']);
        $this->engine->tick();
        $this->assertTrue($this->rolledBack['bp:'.$round->id.':bet'], 'the debit was rolled back');
        $this->assertSame(0, $svc->recoverStuck(), 'once only');
    }

    public function test_the_round_loop_cleans_up_by_itself(): void
    {
        $s = $this->auth();
        DB::table('instant_rounds')->insert(['game_id' => 'bingo-pinball', 'player_key' => 'acme:p1', 'client_id' => 'acme', 'stake' => 700, 'currency' => 'PHP', 'brand_id' => null, 'paytable_id' => 'bp-v96-1',
            'paytable_version' => 96, 'status' => 'debiting', 'request_id' => 'orphan-request-1', 'created_at' => $this->t - 60000]);          // a play whose process died a minute ago
        $this->t += 1000;
        $this->artisan('game:run', ['--once' => true])->expectsOutputToContain('1 instant play(s) that never finished')->assertSuccessful();
        $id = DB::table('instant_rounds')->value('id');
        $this->assertSame('void', DB::table('instant_rounds')->value('status'));
        $this->assertSame(['rollback'], DB::table('pending_ops')->pluck('kind')->all(), 'its debit is to be rolled back');
        $this->artisan('game:run', ['--once' => true])->doesntExpectOutputToContain('never finished')->assertSuccessful();
        $this->assertSame(0, DB::table('pending_ops')->count(), 'the next tick delivered the rollback');
        $this->assertTrue($this->rolledBack['bp:'.$id.':bet'] ?? false);
    }

    /* ---------- the client API ---------- */

    public function test_a_platform_asks_which_games_it_can_offer(): void
    {
        $key = $this->reg->rotateKey('acme', 0)['apiKey'];
        $plain = $this->client('plain', ['games' => ['horse-race']]);
        $g = $this->getJson('/api/client/games', ['Authorization' => 'Bearer '.$key])->assertOk()->json('games');
        $this->assertSame([['horse-race', 'shared'], ['bingo-pinball', 'instant']], array_map(fn ($x) => [$x['id'], $x['kind']], $g));
        $base = rtrim(config('app.url'), '/');
        $this->assertSame($base.'/games/bingo-pinball?client=acme', $g[1]['launchUrl']);
        $this->assertSame($base.'/?client=acme', $g[0]['launchUrl']);
        $this->getJson('/api/client/games', ['Authorization' => 'Bearer '.$plain['apiKey']])->assertOk()->assertJsonPath('games.0.id', 'horse-race')->assertJsonCount(1, 'games');
        $this->getJson('/api/client/games', ['Authorization' => 'Bearer nope'])->assertStatus(401)->assertJsonPath('error', 'INVALID_API_KEY');
    }

    public function test_the_game_needs_the_key_that_keeps_the_seeds_secret_and_does_not_use_up_a_launch_token_without_it(): void
    {
        config(['horse.clients_key' => '']);                                                             // before the first request: the service is built from the config
        $this->postJson(self::BASE.'/auth', ['token' => 'launch-new', 'client' => 'acme'])->assertStatus(503)->assertJsonPath('error', 'GAME_NOT_CONFIGURED');
        $this->assertCount(0, $this->sent('/session/validate'), 'the platform was not asked to use up the launch token');
        $this->assertSame([0, 0, 0], [DB::table('player_seeds')->count(), DB::table('instant_rounds')->count(), DB::table('game_sessions')->count()], 'nothing was stored without protection');
    }

    public function test_every_client_plays_bingo_with_the_default_paytable_unless_it_has_its_own(): void
    {
        $this->client('everyone');                                                                       // no games list, no paytable: the server defaults
        $this->client('own', ['gameSettings' => ['bingo-pinball' => ['paytable' => 94]]]);               // no games list, its own paytable
        $this->balance = 100000;
        $a = $this->postJson(self::BASE.'/auth', ['token' => 'launch-p1', 'client' => 'everyone'])->assertOk();
        $this->assertSame([90, 'bp-v90-1'], [$a->json('paytable.version'), $a->json('paytable.id')]);
        $b = $this->postJson(self::BASE.'/auth', ['token' => 'launch-p2', 'client' => 'own'])->assertOk();
        $this->assertSame(94, $b->json('paytable.version'));
        $round = $this->play($a->json('session'), 1000)->assertOk()->json('round');
        $this->assertSame('bp-v90-1', $round['paytable']['id'], 'the play is paid under the default paytable');
    }
}
