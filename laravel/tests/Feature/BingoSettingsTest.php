<?php

namespace Tests\Feature;

use App\Game\Clients\ClientRegistry;
use App\Game\Engine;
use App\Game\GameError;
use App\Game\Ledger;
use App\Game\Wallet\MockWallet;
use App\Platform\Limits\Limits;
use Illuminate\Support\Facades\DB;

/** Bingo Pinball, per-client settings and the daily loss limit it shares with the horse race (Phase 3a) */
class BingoSettingsTest extends StaffTestCase
{
    private function setting(array $s): array
    {
        return $this->reg->update('acme', ['gameSettings' => ['bingo-pinball' => $s]]);
    }

    public function test_a_clients_bingo_settings_are_checked_and_stored(): void
    {
        $this->assertArrayNotHasKey('gameSettings', $this->reg->get('acme'));
        $ok = ['paytable' => 96, 'limits' => ['minBet' => 500, 'maxBet' => 5000], 'roundWebhooks' => true];
        $c = $this->setting($ok);
        $this->assertSame($ok, $c['gameSettings']['bingo-pinball']);
        $this->assertSame($ok, $this->reg->get('acme')['gameSettings']['bingo-pinball']);
        $this->assertSame(['paytable' => 88], $this->setting(['paytable' => 88])['gameSettings']['bingo-pinball'], 'a new object replaces the old one');
        $this->reg->update('acme', ['gameSettings' => []]);
        $this->assertArrayNotHasKey('gameSettings', $this->reg->get('acme'), 'an empty object clears them');
    }

    public function test_bad_settings_are_refused_and_change_nothing(): void
    {
        $this->setting(['paytable' => 94]);
        $bad = [
            'a paytable that does not exist' => ['bingo-pinball' => ['paytable' => 89]],
            'a paytable as text' => ['bingo-pinball' => ['paytable' => '96']],
            'a negative limit' => ['bingo-pinball' => ['paytable' => 96, 'limits' => ['minBet' => -1]]],
            'min above max' => ['bingo-pinball' => ['paytable' => 96, 'limits' => ['minBet' => 900, 'maxBet' => 100]]],
            'an unknown limit' => ['bingo-pinball' => ['paytable' => 96, 'limits' => ['maxRoundStake' => 100]]],
            'webhooks as text' => ['bingo-pinball' => ['paytable' => 96, 'roundWebhooks' => 'yes']],
            'an unknown setting' => ['bingo-pinball' => ['paytable' => 96, 'rtp' => 0.99]],
            'an unknown game' => ['no-such-game' => ['paytable' => 96]],
            'settings for the horse race' => ['horse-race' => ['rtp' => 0.99]],
            'a list' => [['paytable' => 96]],
            'a game with a list' => ['bingo-pinball' => [96]],
        ];
        foreach ($bad as $why => $settings) {
            try {
                $this->reg->update('acme', ['gameSettings' => $settings]);
                $this->fail("refused: $why");
            } catch (GameError $e) {
                $this->assertSame(400, $e->status, $why);
            }
        }
        $this->assertSame(['paytable' => 94], $this->reg->get('acme')['gameSettings']['bingo-pinball'], 'nothing changed');
    }

    public function test_reading_a_client_never_fails_even_if_its_stored_settings_are_not_valid_any_more(): void
    {
        $this->setting(['paytable' => 96]);
        $row = DB::table('clients')->where('id', 'acme')->first();
        $data = json_decode($row->data, true);
        $data['gameSettings'] = ['bingo-pinball' => ['paytable' => 89, 'something' => 1], 'gone-game' => ['x' => 1]];       // what an older or newer version might have written
        DB::table('clients')->where('id', 'acme')->update(['data' => json_encode($data)]);
        $c = (new ClientRegistry('clients-key-for-tests-1234', allowMock: true, clock: fn () => $this->t, cacheMs: 0))->get('acme');
        $this->assertSame('acme', $c['id'], 'the client is still there, and the horse race with it');
    }

    public function test_the_admin_console_reads_and_writes_game_settings(): void
    {
        $this->staff('_operator', 'olga', 'admin');
        $h = $this->signIn('admin', null, 'olga')[0];
        $this->postJson('/admin/api/clients/acme', ['client' => ['games' => ['horse-race', 'bingo-pinball'], 'gameSettings' => ['bingo-pinball' => ['paytable' => 92]]]], $h)->assertOk();
        $c = $this->getJson('/admin/api/clients/acme', $h)->assertOk()->json('client');
        $this->assertSame(['horse-race', 'bingo-pinball'], $c['games']);
        $this->assertSame(['paytable' => 92], $c['gameSettings']['bingo-pinball']);
        $this->postJson('/admin/api/clients/acme', ['client' => ['gameSettings' => ['bingo-pinball' => ['paytable' => 50]]]], $h)->assertStatus(400);
        $this->assertSame(92, $this->reg->get('acme')['gameSettings']['bingo-pinball']['paytable']);
        $this->assertArrayNotHasKey('gameSettings', $this->getJson('/admin/api/clients/zeta', $h)->json('client'), 'a client without settings shows none');
    }

    public function test_the_modules_describe_what_an_operator_may_set(): void
    {
        $m = $this->app->make(\App\Platform\Games\Games::class)->get('bingo-pinball');
        $this->assertSame(['paytable', 'limits', 'roundWebhooks'], array_keys($m->clientSettings()));
        $this->assertSame(['holes' => 25, 'balls' => 5, 'lines' => 12], array_intersect_key($m->rules(), ['holes' => 1, 'balls' => 1, 'lines' => 1]));
    }

    /* ---------- the daily loss limit is shared by every game ---------- */

    private function round(string $player, int $stake, int $payout, string $status, ?int $at = null): void
    {
        DB::table('instant_rounds')->insert(['game_id' => 'bingo-pinball', 'player_key' => $player, 'client_id' => 'default', 'stake' => $stake, 'currency' => 'PHP', 'paytable_id' => 'bp-v96-1', 'paytable_version' => 96,
            'payout' => $payout, 'status' => $status, 'request_id' => bin2hex(random_bytes(6)), 'created_at' => $at ?? $this->t]);
    }

    public function test_the_daily_figures_count_the_instant_rounds_of_today_that_were_settled(): void
    {
        $l = new Limits(fn () => $this->t, ['min_bet' => 100, 'max_bet' => 100000, 'max_round_stake' => 500000, 'daily_loss_limit' => 0]);
        $this->round('zoe', 1000, 0, 'settled');
        $this->round('zoe', 500, 1500, 'settled');
        $this->round('zoe', 700, 0, 'void');
        $this->round('zoe', 800, 0, 'debiting');
        $this->round('zoe', 9999, 0, 'settled', $this->t - 2 * 86400000);
        $this->round('other', 5000, 0, 'settled');
        $this->assertSame(['staked' => 1500, 'paid' => 1500], $l->today('zoe'));
        $this->assertSame(0, $l->dayNet('zoe'));
        $this->assertSame(['staked' => 5000, 'paid' => 0], $l->today('other'));
    }

    public function test_what_a_player_lost_at_bingo_counts_towards_the_horse_race_daily_limit(): void
    {
        config(['horse.daily_loss_limit' => 2500, 'horse.wallet' => 'mock']);
        $engine = new Engine(new MockWallet(100000, 'PHP'), new Ledger, config('horse'), fn () => $this->t);
        $this->app->instance(Engine::class, $engine);
        $engine->tick();
        $s = $this->postJson('/api/auth', ['token' => 'demo-zoe'])->assertOk()->json('session');
        $h = ['Authorization' => 'Bearer '.$s];
        $this->round('zoe', 2000, 0, 'settled');                                                         // lost at bingo today
        $this->postJson('/api/bet', ['bets' => [['combo' => '1-2', 'stake' => 600]]], $h)->assertStatus(400)->assertJsonPath('error', 'DAILY_LOSS_LIMIT');
        $this->postJson('/api/bet', ['bets' => [['combo' => '1-2', 'stake' => 500]]], $h)->assertOk();       // exactly up to the limit
        $this->assertSame(2500, $this->getJson('/api/me', $h)->json('responsible.dailyNetLoss'), 'the figure the player sees counts both games');
    }

    public function test_a_database_without_the_instant_tables_still_runs_the_horse_race(): void
    {
        \Illuminate\Support\Facades\Cache::flush();
        \Illuminate\Support\Facades\Schema::drop('instant_rounds');
        \Illuminate\Support\Facades\Cache::flush();
        $l = new Limits(fn () => $this->t, ['min_bet' => 100, 'max_bet' => 100000, 'max_round_stake' => 500000, 'daily_loss_limit' => 0]);
        $this->assertSame(['staked' => 0, 'paid' => 0], $l->today('zoe'), 'a deploy whose migration has not run yet must not break betting');
    }
}
