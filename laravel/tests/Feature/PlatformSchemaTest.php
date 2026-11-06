<?php

namespace Tests\Feature;

use App\Game\Engine;
use App\Game\Ledger;
use App\Game\Wallet\MockWallet;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;
use Tests\TestCase;

/** Phase 1: the shared tables know which game a row belongs to, and everything the horse race writes is a 'horse-race' row without the code having to say so */
class PlatformSchemaTest extends TestCase
{
    use RefreshDatabase;

    public function test_the_shared_tables_have_a_game_id_that_defaults_to_the_horse_race(): void
    {
        foreach (['game_sessions', 'bets', 'pending_ops'] as $table) {
            $this->assertTrue(Schema::hasColumn($table, 'game_id'), "$table.game_id");
        }
        $this->assertTrue(Schema::hasColumn('pending_ops', 'round_ref'));
    }

    public function test_what_the_horse_race_writes_is_marked_as_horse_race_by_the_default(): void
    {
        $t = 1_800_000_000_000;
        config(['horse.wallet' => 'mock', 'horse.big_win_min' => 1]);
        $wallet = new MockWallet(100000, 'PHP');
        $engine = new Engine($wallet, new Ledger, config('horse'), fn () => $t);
        $this->app->instance(Engine::class, $engine);
        $engine->tick();
        $s = $this->postJson('/api/auth', ['token' => 'demo-zoe'])->assertOk()->json('session');
        $this->postJson('/api/bet', ['bets' => array_map(fn ($c) => ['combo' => $c, 'stake' => 100], \App\Game\Odds::combos())], ['Authorization' => 'Bearer '.$s])->assertOk();
        $t += 25000;
        $engine->tick();
        $t += 36000;
        $engine->tick();
        foreach (['game_sessions', 'bets'] as $table) {
            $this->assertGreaterThan(0, DB::table($table)->count());
            $this->assertSame([], DB::table($table)->where('game_id', '!=', 'horse-race')->get()->all(), "every $table row is a horse-race row");
        }
        DB::table('pending_ops')->insert(['tx_id' => 'x', 'kind' => 'credit', 'player_key' => 'p', 'amount' => 1, 'since' => 1, 'tries' => 0, 'next_at' => 0]);
        $row = DB::table('pending_ops')->where('tx_id', 'x')->first();
        $this->assertSame(['horse-race', null], [$row->game_id, $row->round_ref]);
    }

    public function test_the_migration_can_be_undone_and_redone(): void
    {
        $this->artisan('migrate:rollback', ['--step' => 4])->assertSuccessful();             // the pattern column, the Bingo Pinball 16 tables, the instant-game tables, then this one
        $this->assertFalse(Schema::hasColumn('bets', 'game_id'));
        $this->assertFalse(Schema::hasColumn('pending_ops', 'round_ref'));
        $this->artisan('migrate')->assertSuccessful();
        $this->assertTrue(Schema::hasColumn('bets', 'game_id'));
    }
}
