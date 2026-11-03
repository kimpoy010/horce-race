<?php

namespace Tests\Feature;

use App\Game\Clients\ClientRegistry;
use App\Game\Ledger;
use App\Game\Wallet\MockWallet;
use App\Game\Webhook;
use App\Platform\Clients\ClientDirectory;
use App\Platform\Ledger\Journal;
use App\Platform\Wallet\WalletGateway;
use App\Platform\Webhooks\WebhookQueue;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Http;
use Tests\TestCase;

/** The journal (the one ledger of every game) and the webhook queue (Phase 1) */
class PlatformLedgerWebhooksTest extends TestCase
{
    use RefreshDatabase;

    private int $t = 1_800_000_000_000;

    private Journal $journal;

    private WebhookQueue $hooks;

    private ClientRegistry $reg;

    protected function setUp(): void
    {
        parent::setUp();
        $this->journal = new Journal(new Ledger, fn () => $this->t);
        $this->reg = new ClientRegistry('platform-test-key-0123456789', allowMock: true, clock: fn () => $this->t, cacheMs: 0);
        $dir = new ClientDirectory(new MockWallet(1000, 'PHP'), new Webhook('https://hook.default.test/e', str_repeat('k', 24), 'k1', 'round.settled,big.win,game.round'), $this->reg);
        $log = fn (array $ev) => $this->journal->log($ev);
        $this->hooks = new WebhookQueue(fn () => $this->t, $log, $dir, new WalletGateway(fn () => $this->t, $log, fn ($id) => $dir->walletFor($id)));
    }

    private function lines(): array
    {
        return array_map(fn ($l) => json_decode($l, true), DB::table('ledger')->orderBy('seq')->pluck('line')->all());
    }

    public function test_the_journal_chains_every_event_and_stamps_the_time(): void
    {
        $this->journal->log(['e' => 'bet', 'raceNo' => 1]);
        $this->t += 5;
        $this->journal->log(['e' => 'bp.play', 'round' => 'bp:1'], 'bingo-pinball');
        $this->journal->log(['e' => 'credit_ok'], 'horse-race');
        [$a, $b, $c] = $this->lines();
        $this->assertSame(['bet', 1800000000000], [$a['e'], $a['t']]);
        $this->assertArrayNotHasKey('game', $a, 'the horse race writes the events it always wrote');
        $this->assertArrayNotHasKey('game', $c);
        $this->assertSame(['e', 'game', 'round', 't', 'h'], array_keys($b), 'another game names itself right after the event');
        $this->assertSame(1800000000005, $b['t']);
        $this->assertTrue($this->journal->ledger()->verify()['ok'], 'one chain for all games');
        $this->assertSame(3, $this->journal->ledger()->lines());
    }

    public function test_a_horse_race_event_is_queued_with_the_ids_it_always_had(): void
    {
        $this->hooks->emit('round.settled', 'round:7', ['roundId' => '7', 'raceNo' => 7, 'combo' => '1-2'], 'default');
        $row = DB::table('pending_ops')->first();
        $this->assertSame(['horse-race:round:7', 'webhook', 7, 'horse-race', null], [$row->tx_id, $row->kind, (int) $row->race_no, $row->game_id, $row->round_ref]);
        $ev = json_decode($row->extra, true);
        $this->assertSame(['id', 'type', 'createdAt', 'gameId', 'clientId', 'data'], array_keys($ev));
        $this->assertSame(['horse-race', 'default'], [$ev['gameId'], $ev['clientId']]);
        $this->hooks->emit('round.settled', 'round:7', ['raceNo' => 7], 'default');                  // the same event twice is queued once
        $this->assertSame(1, DB::table('pending_ops')->count());
        $this->hooks->emit('not.wanted', 'x', [], 'default');
        $this->hooks->emit('round.settled', 'round:7', [], 'nobody');
        $this->assertSame(1, DB::table('pending_ops')->count(), 'an event the client does not want, or a client without a webhook, is not queued');
        $this->assertSame(['webhook_due', 'webhook_due'], array_column($this->lines(), 'e'), 'as it always was: the ledger line is written before the queue ignores a duplicate');
    }

    public function test_an_event_of_another_game_names_its_game_and_round(): void
    {
        $this->reg->create(['id' => 'acme', 'wallet' => ['type' => 'mock'], 'webhook' => ['url' => 'https://hook.acme.test/e', 'secret' => str_repeat('s', 24), 'events' => 'game.round']]);
        $this->hooks->emit('game.round', 'bp:55', ['roundId' => 'bp:55', 'payout' => 0], 'acme', 'bingo-pinball');
        $row = DB::table('pending_ops')->first();
        $this->assertSame(['bingo-pinball:acme:bp:55', null, 'bingo-pinball', 'bp:55'], [$row->tx_id, $row->race_no, $row->game_id, $row->round_ref]);
        $this->assertSame('bingo-pinball', json_decode($row->extra, true)['gameId']);
    }

    public function test_events_are_delivered_retried_with_back_off_and_dropped_when_the_webhook_goes(): void
    {
        Http::fake(['https://hook.default.test/*' => Http::sequence()->push('', 500)->push('ok', 200)]);
        $this->hooks->emit('round.settled', 'round:1', ['raceNo' => 1], 'default');
        $this->hooks->flush();
        $row = DB::table('pending_ops')->first();
        $this->assertSame([1, 2000], [(int) $row->tries, (int) $row->next_at - $this->t], 'a failed delivery is retried after 2 s');
        $this->hooks->flush();
        $this->assertSame(1, DB::table('pending_ops')->count(), 'not due yet');
        $this->t += 2000;
        $this->hooks->flush();
        $this->assertSame(0, DB::table('pending_ops')->count());
        $this->assertSame(['webhook_due', 'webhook_ok'], array_column($this->lines(), 'e'));

        $this->reg->create(['id' => 'gone', 'wallet' => ['type' => 'mock'], 'webhook' => ['url' => 'https://hook.gone.test/e', 'secret' => str_repeat('s', 24)]]);
        $this->hooks->emit('round.settled', 'round:2', ['raceNo' => 2], 'gone');
        $this->reg->update('gone', ['webhook' => null]);
        $this->hooks->flush();
        $this->assertSame(0, DB::table('pending_ops')->count());
        $this->assertSame('webhook_dropped', collect($this->lines())->last()['e']);
    }
}
