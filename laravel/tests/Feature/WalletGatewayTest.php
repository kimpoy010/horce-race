<?php

namespace Tests\Feature;

use App\Game\GameError;
use App\Game\Ledger;
use App\Game\Wallet\HttpWallet;
use App\Game\Wallet\MockWallet;
use App\Platform\Wallet\WalletGateway;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Http;
use Tests\Support\RecordingWallet;
use Tests\TestCase;

/**
 * The wallet gateway (Phase 1): the queue of credits and rollbacks and the debit, for the horse race (its rows are unchanged) and for a game that has no race number
 * (rows carry the game id and a round_ref, and the wallet is told the game and the round).
 */
class WalletGatewayTest extends TestCase
{
    use RefreshDatabase;

    private int $t = 1_800_000_000_000;

    private RecordingWallet $wallet;

    private WalletGateway $gw;

    private Ledger $ledger;

    protected function setUp(): void
    {
        parent::setUp();
        $this->wallet = new RecordingWallet(new MockWallet(100000, 'PHP'));
        $this->ledger = new Ledger;
        $this->gw = new WalletGateway(fn () => $this->t, fn (array $ev) => $this->ledger->append($ev + ['t' => $this->t]), fn (string $cid) => $cid === 'default' ? $this->wallet : null);
    }

    private function events(): array
    {
        return array_map(fn ($l) => json_decode($l, true), DB::table('ledger')->orderBy('seq')->pluck('line')->all());
    }

    /* ---------- a game without a race number ---------- */

    public function test_a_credit_of_an_instant_game_is_queued_delivered_and_logged_with_its_game(): void
    {
        $this->gw->queueCredit('bp:77:win', 'alice', 2500, null, 'win', ['currency' => 'PHP'], 'bingo-pinball', 'bp:77');
        $this->gw->queueCredit('bp:77:win', 'alice', 2500, null, 'win', [], 'bingo-pinball', 'bp:77');         // the same credit twice is queued once
        $row = DB::table('pending_ops')->first();
        $this->assertSame(1, DB::table('pending_ops')->count());
        $this->assertSame(['bp:77:win', 'credit', null, 'win', 'bingo-pinball', 'bp:77', 0], [$row->tx_id, $row->kind, $row->race_no, $row->tx_kind, $row->game_id, $row->round_ref, (int) $row->tries]);

        $this->gw->flushCredits();
        $call = collect($this->wallet->calls)->firstWhere('op', 'credit');
        $this->assertSame(['alice', 2500, 'bp:77:win'], [$call['playerId'], $call['amount'], $call['txId']]);
        $this->assertSame(['roundId' => 'bp:77', 'gameId' => 'bingo-pinball', 'kind' => 'win', 'currency' => 'PHP'], $call['meta'], 'the wallet is told the game and the round');
        $this->assertSame(0, DB::table('pending_ops')->count());
        $ev = $this->events();
        $this->assertSame(['credit_due', 'bingo-pinball', 'bp:77'], [$ev[0]['e'], $ev[0]['game'], $ev[0]['roundRef']]);
        $this->assertArrayNotHasKey('raceNo', $ev[0]);
        $this->assertSame(['credit_ok', 'bingo-pinball', 'bp:77'], [$ev[1]['e'], $ev[1]['game'], $ev[1]['roundRef']]);
    }

    public function test_an_instant_game_credit_is_retried_with_the_same_back_off_as_the_horse_race(): void
    {
        $this->wallet->failCredits = 3;
        $this->gw->queueCredit('bp:5:win', 'alice', 100, null, 'win', [], 'bingo-pinball', 'bp:5');
        $waits = [];
        for ($i = 0; $i < 4; $i++) {
            $row = DB::table('pending_ops')->first();
            $this->t = max($this->t, (int) $row->next_at);
            $this->gw->flushCredits();
            $row = DB::table('pending_ops')->first();
            $waits[] = $row ? (int) $row->next_at - $this->t : 'delivered';
        }
        $this->assertSame([2000, 4000, 8000, 'delivered'], $waits);
    }

    public function test_a_rollback_of_an_instant_game_is_queued_delivered_and_logged_with_its_game(): void
    {
        $this->gw->queueRollback('bp:9:bet', 'alice', 500, ['gameId' => 'bingo-pinball', 'roundRef' => 'bp:9', 'currency' => 'PHP']);
        $row = DB::table('pending_ops')->first();
        $this->assertSame(['rb:bp:9:bet', 'rollback', 'bingo-pinball', 'bp:9'], [$row->tx_id, $row->kind, $row->game_id, $row->round_ref]);
        $this->gw->flushRollbacks();
        $call = collect($this->wallet->calls)->firstWhere('op', 'rollback');
        $this->assertSame('bp:9:bet', $call['txId']);
        $this->assertSame(['roundId' => 'bp:9', 'gameId' => 'bingo-pinball', 'kind' => 'rollback', 'refTxId' => 'bp:9:bet', 'currency' => 'PHP'], $call['meta']);
        $this->assertSame(0, DB::table('pending_ops')->count());
        $this->assertSame('bingo-pinball', collect($this->events())->firstWhere('e', 'rollback_ok')['game']);
    }

    public function test_the_debit_maps_answers_and_queues_a_rollback_when_the_outcome_is_unknown(): void
    {
        $meta = ['kind' => 'bet', 'roundId' => 'bp:3', 'gameId' => 'bingo-pinball', 'roundRef' => 'bp:3', 'currency' => 'PHP'];
        $this->assertSame(99000, $this->gw->debit('alice', 1000, 'bp:3:bet', $meta)['balance']);
        $this->assertSame(99000, $this->gw->debit('alice', 1000, 'bp:3:bet', $meta)['balance'], 'the same transaction id is applied once');

        $this->wallet->refuseDebits = 1;
        $this->expectRefused(502, 'WALLET_REJECTED', fn () => $this->gw->debit('alice', 10, 'bp:4:bet', $meta));
        $this->expectRefused(402, 'INSUFFICIENT_FUNDS', fn () => $this->gw->debit('alice', 999999, 'bp:5:bet', $meta));
        $this->expectRefused(502, 'WALLET_UNAVAILABLE', fn () => $this->gw->debit('nobody@unknown-client:x', 10, 'bp:6:bet', $meta));

        $this->wallet->loseDebitAnswers = 2;
        $this->expectRefused(502, 'WALLET_UNAVAILABLE', fn () => $this->gw->debit('alice', 700, 'bp:7:bet', $meta));
        $row = DB::table('pending_ops')->where('tx_id', 'rb:bp:7:bet')->first();
        $this->assertSame(['rollback', 'bingo-pinball', 'bp:3'], [$row->kind, $row->game_id, $row->round_ref]);
        $unknown = collect($this->events())->firstWhere('e', 'debit_unknown');
        $this->assertSame(['bp:7:bet', 'bingo-pinball'], [$unknown['txId'], $unknown['game']]);
    }

    private function expectRefused(int $status, string $code, \Closure $fn): void
    {
        try {
            $fn();
            $this->fail("expected $code");
        } catch (GameError $e) {
            $this->assertSame([$status, $code], [$e->status, $e->errorCode]);
        }
    }

    /* ---------- the horse race: its rows and events are the ones it always wrote ---------- */

    public function test_a_horse_race_row_has_a_race_number_no_round_ref_and_no_game_field_in_the_ledger(): void
    {
        $this->gw->queueCredit('win:12:alice', 'alice', 700, 12, 'win', ['betIds' => ['b:1-2']]);
        $row = DB::table('pending_ops')->first();
        $this->assertSame([12, null, 'horse-race'], [(int) $row->race_no, $row->round_ref, $row->game_id]);
        $this->gw->flushCredits();
        $call = collect($this->wallet->calls)->firstWhere('op', 'credit');
        $this->assertSame(['raceNo' => 12, 'roundId' => '12', 'kind' => 'win', 'betIds' => ['b:1-2']], $call['meta'], 'exactly the meta the horse race has always sent, in the same order');
        foreach ($this->events() as $e) {
            $this->assertArrayNotHasKey('game', $e);
        }
        $this->assertSame(['credit_due', 'credit_ok'], array_column($this->events(), 'e'));
    }

    public function test_the_wallet_counts_every_call_and_reports_the_recent_window(): void
    {
        $this->gw->debit('alice', 100, 'x:1', ['kind' => 'bet']);
        $this->wallet->refuseDebits = 1;
        $this->expectRefused(502, 'WALLET_REJECTED', fn () => $this->gw->debit('alice', 100, 'x:2', ['kind' => 'bet']));
        $w = $this->gw->window(60000, 'default');
        $this->assertSame([2, 0], [$w['calls'], $w['failures']], 'a refusal is an answer, not a failure');
        $this->wallet->loseDebitAnswers = 2;
        $this->expectRefused(502, 'WALLET_UNAVAILABLE', fn () => $this->gw->debit('alice', 100, 'x:3', ['kind' => 'bet']));
        $w = $this->gw->window(60000, 'default');
        $this->assertSame([4, 2], [$w['calls'], $w['failures']], 'no answer is a failure');
        $this->assertSame(0.5, $w['failRate']);
        $this->assertSame(0, $this->gw->window(60000, 'other')['calls']);
        $this->t += 120000;
        $this->assertSame(0, $this->gw->window(60000)['calls'], 'older calls fall out of the window');
        $stats = DB::table('wallet_stats')->where('client', 'default')->where('op', 'debit')->first();
        $this->assertSame([2, 2], [(int) $stats->ok, (int) $stats->fail], 'the running totals for /metrics only go up');
    }

    /* ---------- what the platform is told ---------- */

    public function test_the_http_wallet_tells_the_platform_the_game_of_the_call(): void
    {
        Http::fake(['https://platform.test/*' => Http::response(['ok' => true, 'balance' => 1], 200)]);
        $w = new HttpWallet('https://platform.test/api', str_repeat('s', 24), 'k1', 'hmac', 8000, 'PHP', 'horse-race');
        $w->debit('p1', 100, 'bet:1:abc', ['kind' => 'bet', 'raceNo' => 1, 'roundId' => '1']);
        $w->debit('p1', 100, 'bp:9:bet', ['kind' => 'bet', 'roundId' => 'bp:9', 'gameId' => 'bingo-pinball']);
        $bodies = collect(Http::recorded())->map(fn ($x) => json_decode($x[0]->body(), true))->all();
        $this->assertSame('horse-race', $bodies[0]['gameId'], 'a horse-race call is exactly as before');
        $this->assertSame(['bingo-pinball', 'bp:9'], [$bodies[1]['gameId'], $bodies[1]['roundId']]);
    }
}
