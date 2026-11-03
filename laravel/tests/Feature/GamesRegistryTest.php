<?php

namespace Tests\Feature;

use App\Game\Clients\ClientRegistry;
use App\Game\GameError;
use App\Game\Ledger;
use App\Game\Wallet\MockWallet;
use App\Games\HorseRace\HorseRaceModule;
use App\Platform\Clients\ClientDirectory;
use App\Platform\Games\GameModule;
use App\Platform\Games\Games;
use App\Platform\Limits\Limits;
use App\Platform\Sessions\Sessions;
use App\Platform\Wallet\WalletGateway;
use Illuminate\Support\Facades\DB;
use Tests\Support\RecordingWallet;

/** The game modules and the games a client plays (Phase 1). Nothing here changes the horse race: a client without a list plays it, as before. */
class GamesRegistryTest extends StaffTestCase
{
    private function games(): Games
    {
        return new Games($this->app, (array) config('games'));          // built from the config as it is now (the tests change it)
    }

    private function admin(): array
    {
        $this->staff('_operator', 'olga', 'admin');

        return $this->signIn('admin', null, 'olga')[0];
    }

    public function test_the_horse_race_is_the_default_game_and_bingo_pinball_ships_switched_off(): void
    {
        $g = $this->games();
        $this->assertSame(['horse-race', 'bingo-pinball'], $g->ids());
        $this->assertSame(['horse-race'], $g->defaults(), 'a new game is registered but is not in the defaults: no client plays it until an operator adds it');
        $this->assertFalse($g->isEnabled($this->reg->get('acme'), 'bingo-pinball'));
        $this->assertSame(['instant', 'Bingo Pinball', '/games/bingo-pinball'], [$g->get('bingo-pinball')->kind(), $g->get('bingo-pinball')->name(), $g->get('bingo-pinball')->launchPath()]);
        $m = $g->get('horse-race');
        $this->assertInstanceOf(GameModule::class, $m);
        $this->assertInstanceOf(HorseRaceModule::class, $m);
        $this->assertSame(['horse-race', 'shared', 'Horse Race', '/'], [$m->id(), $m->kind(), $m->name(), $m->launchPath()]);
        $this->assertSame($this->engine->rules(), $m->rules());
        $this->assertSame([], $m->clientSettings());
        $this->assertSame(['horse-race', 'bingo-pinball'], array_keys($g->all()));
        $this->expectException(\InvalidArgumentException::class);
        $g->get('nope');
    }

    public function test_a_client_without_a_list_plays_the_defaults_and_nothing_is_stored_for_it(): void
    {
        $c = $this->reg->get('acme');
        $this->assertArrayNotHasKey('games', $c, 'existing clients are untouched');
        $this->assertSame(['horse-race'], $this->games()->enabledFor($c));
        $this->assertTrue($this->games()->isEnabled($c, 'horse-race'));
        $this->assertFalse($this->games()->isEnabled($c, 'bingo-pinball'));
        $this->assertArrayNotHasKey('games', $this->reg->publicView($c), 'the client views are as they were');
    }

    public function test_a_clients_own_list_is_validated_stored_and_changed(): void
    {
        $this->reg->update('acme', ['games' => ['horse-race', 'bingo-pinball']]);
        $c = $this->reg->get('acme');
        $this->assertSame(['horse-race', 'bingo-pinball'], $c['games']);
        $this->assertSame(['horse-race', 'bingo-pinball'], $this->games()->enabledFor($c));
        $this->assertSame(['horse-race', 'bingo-pinball'], $this->reg->publicView($c)['games']);
        foreach ([[], 'horse-race', ['horse-race', 'horse-race'], ['nope'], [5], ['a' => 'horse-race']] as $bad) {
            try {
                $this->reg->update('zeta', ['games' => $bad]);
                $this->fail('refused: '.json_encode($bad));
            } catch (GameError $e) {
                $this->assertSame(400, $e->status);
            }
        }
        $this->assertArrayNotHasKey('games', $this->reg->get('zeta'), 'a refused list changes nothing');
        config(['games.modules' => ['horse-race' => HorseRaceModule::class]]);                                                     // the server no longer has the other game
        $this->assertSame(['horse-race'], $this->games()->enabledFor($this->reg->get('acme')), 'a game this server no longer has is skipped');
    }

    public function test_the_admin_console_reads_and_writes_a_clients_games(): void
    {
        $h = $this->admin();
        $this->postJson('/admin/api/clients/acme', ['client' => ['games' => ['horse-race']]], $h)->assertOk();
        $this->assertSame(['horse-race'], $this->reg->get('acme')['games']);
        $this->assertSame(['horse-race'], $this->getJson('/admin/api/clients/acme', $h)->assertOk()->json('client.games'));
        $this->postJson('/admin/api/clients/acme', ['client' => ['games' => ['no-such-game']]], $h)->assertStatus(400);
        $this->assertSame(['horse-race'], $this->reg->get('acme')['games']);
        $this->assertArrayNotHasKey('games', $this->getJson('/admin/api/clients/zeta', $h)->json('client'), 'a client that has no list shows none');
    }

    public function test_a_game_that_is_not_enabled_for_the_client_cannot_be_launched_and_the_launch_token_is_kept(): void
    {
        $wallet = new RecordingWallet(new MockWallet(1000, 'PHP'));
        $dir = new ClientDirectory($wallet, null, $this->reg);
        $log = fn (array $ev) => (new Ledger)->append($ev + ['t' => $this->t]);
        $cfg = ['min_bet' => 100, 'max_bet' => 100000, 'max_round_stake' => 500000, 'daily_loss_limit' => 0, 'currency' => 'PHP', 'reality_check_minutes' => 0, 'currency_limits' => [], 'session_ttl_ms' => 3600000];
        $sessions = new Sessions(fn () => $this->t, $log, $cfg, $dir, new WalletGateway(fn () => $this->t, $log, fn ($id) => $dir->walletFor($id)), new Limits(fn () => $this->t, $cfg),
            fn (array $client, string $game) => $this->games()->isEnabled($client, $game));

        try {
            $sessions->auth('demo-alice', 'acme', 'bingo-pinball');
            $this->fail('not enabled');
        } catch (GameError $e) {
            $this->assertSame([403, 'GAME_NOT_ENABLED'], [$e->status, $e->errorCode]);
        }
        $this->assertSame([], $wallet->calls, 'the platform was not asked to use up the launch token');
        $this->assertSame(0, DB::table('game_sessions')->count());
        $this->assertSame('alice', $sessions->auth('demo-alice', 'acme')['playerId'], 'the horse race needs no entry in the list');

        $this->reg->update('acme', ['games' => ['horse-race', 'bingo-pinball']]);
        $s = $sessions->auth('demo-bob', 'acme', 'bingo-pinball');
        $this->assertSame('bingo-pinball', DB::table('game_sessions')->where('key', Sessions::key($s['session']))->value('game_id'));
    }
}
