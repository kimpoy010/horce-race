<?php

namespace Tests\Feature;

use App\Game\AlertManager;
use App\Games\GameReports;
use App\Games\Reconcile;
use Illuminate\Support\Facades\DB;

/** Phase 5: per-game numbers in the back office, the admin console, /metrics and the alerts, and their agreement with the ledger */
class GameReportsTest extends StaffTestCase
{
    private const BASE = '/api/games/bingo-pinball';

    protected function setUp(): void
    {
        parent::setUp();
        config(['games.settings.bingo-pinball.min_interval_ms' => 0, 'games.settings.bingo-pinball.lock_wait_seconds' => 0]);
        $this->reg->update('acme', ['games' => ['horse-race', 'bingo-pinball'], 'gameSettings' => ['bingo-pinball' => ['paytable' => 96]]]);
    }

    private function bingoSession(string $who = 'pat', string $client = 'acme'): array
    {
        $s = $this->postJson(self::BASE.'/auth', ['client' => $client, 'token' => 'demo-'.$who])->assertOk()->json('session');

        return ['Authorization' => 'Bearer '.$s];
    }

    /** @return list<array> the rounds of $n plays */
    private function plays(array $h, int $n, int $stake = 1000): array
    {
        $out = [];
        for ($i = 0; $i < $n; $i++) {
            $out[] = $this->postJson(self::BASE.'/play', ['stake' => $stake, 'requestId' => 'rq'.$i.bin2hex(random_bytes(4))], $h)->assertOk()->json('round');
        }

        return $out;
    }

    private function boHeaders(string $role = 'viewer'): array
    {
        $this->staff('acme', 'bea', $role);

        return $this->signIn('bo', 'acme', 'bea')[0];
    }

    public function test_the_summary_counts_each_game_on_its_own(): void
    {
        $h = $this->bingoSession();
        $rounds = $this->plays($h, 40);
        $this->postJson('/api/bet', ['bets' => [['combo' => '1-2', 'stake' => 1000]]], ['Authorization' => 'Bearer '.$this->player('acme', 'hank')])->assertOk();
        $g = app(GameReports::class)->summary('acme');
        $b = $g['bingo-pinball'];
        $this->assertSame(40, $b['plays']);
        $this->assertSame(40000, $b['staked']);
        $this->assertSame(array_sum(array_column($rounds, 'payout')), $b['paid']);
        $this->assertEqualsWithDelta(0.9653, $b['rtpTheoretical'], 0.0001);
        $this->assertSame(count(array_filter($rounds, fn ($r) => $r['payout'] > 0)), array_sum($b['hits']));
        $this->assertEqualsWithDelta(22356 / 53130, $b['hitFrequencyTheoretical'], 0.0001);
        $this->assertSame(0, $g['horse-race']['plays'], 'the bet is still open, so it is not counted yet');
        $this->assertSame(0, app(GameReports::class)->summary('zeta')['bingo-pinball']['plays']);
        $this->assertSame(40, app(GameReports::class)->summary()['bingo-pinball']['plays']);
    }

    public function test_the_z_score_follows_the_paytable_of_the_plays(): void
    {
        $at = $this->t;
        DB::table('instant_rounds')->insert(array_map(fn ($i) => ['game_id' => 'bingo-pinball', 'player_key' => 'acme:x', 'client_id' => 'acme', 'stake' => 1000, 'currency' => 'PHP', 'paytable_id' => 'bp-v96-1', 'paytable_version' => 96,
            'holes' => '[1,2,3,4,5]', 'best_lit' => 0, 'best_line' => 0, 'multiple' => 0, 'payout' => 0, 'status' => 'settled', 'request_id' => 'z'.$i, 'created_at' => $at, 'settled_at' => $at], range(1, 2000)));
        $low = app(GameReports::class)->summary('acme')['bingo-pinball'];
        $this->assertLessThan(-15, $low['rtpZ'], '2000 plays that never win are far below what the PAR sheet predicts');
        $this->assertSame(0.0, (float) $low['rtpActual']);
    }

    public function test_the_back_office_filters_by_game_and_shows_a_round_with_its_proof(): void
    {
        $h = $this->bingoSession();
        $rounds = $this->plays($h, 5);
        $bo = $this->boHeaders();
        $games = $this->getJson('/bo/api/games', $bo)->assertOk()->json();
        $this->assertSame(['horse-race', 'bingo-pinball'], $games['enabled']);
        $this->assertSame(5, $games['games']['bingo-pinball']['plays']);
        $list = $this->getJson('/bo/api/rounds?game=bingo-pinball', $bo)->assertOk()->json('rounds');
        $this->assertSame(array_reverse(array_column($rounds, 'id')), array_column($list, 'id'), 'newest first');
        $this->assertSame('pat', $list[0]['playerId']);
        $this->assertSame(['pat'], array_column($this->getJson('/bo/api/players?game=bingo-pinball', $bo)->assertOk()->json('players'), 'playerId'));
        $this->assertCount(5, $this->getJson('/bo/api/rounds?game=bingo-pinball&player=pat', $bo)->json('rounds'));
        $this->assertCount(0, $this->getJson('/bo/api/rounds?game=bingo-pinball&player=nobody', $bo)->json('rounds'));
        // without the filter the horse race answers as before
        $this->assertArrayHasKey('raceNo', ['raceNo' => 0] + ($this->getJson('/bo/api/rounds', $bo)->assertOk()->json('rounds')[0] ?? []));
        $this->assertSame([], $this->getJson('/bo/api/rounds', $bo)->json('rounds'));
        // the proof is secret until the seed is revealed
        $id = $rounds[0]['id'];
        $one = $this->getJson('/bo/api/games/bingo-pinball/rounds/'.$id, $bo)->assertOk()->json();
        $this->assertNull($one['proof']);
        $this->assertArrayHasKey('proofNote', $one);
        $this->postJson(self::BASE.'/seed/rotate', [], $h)->assertOk();
        $one = $this->getJson('/bo/api/games/bingo-pinball/rounds/'.$id, $bo)->assertOk()->json();
        $this->assertMatchesRegularExpression('/^[0-9a-f]{64}$/', $one['proof']['serverSeed']);
        $this->assertSame($rounds[0]['holes'], $one['proof']['holes']);
        $this->assertStringStartsWith('php bin/bingo-verify.php', $one['proof']['verify']);
        $this->getJson('/bo/api/games/bingo-pinball/rounds/999999', $bo)->assertStatus(404);
    }

    public function test_a_client_cannot_see_the_rounds_of_another_client(): void
    {
        $this->reg->update('zeta', ['games' => ['horse-race', 'bingo-pinball'], 'gameSettings' => ['bingo-pinball' => ['paytable' => 90]]]);
        $round = $this->plays($this->bingoSession('zed', 'zeta'), 1)[0];
        $bo = $this->boHeaders();
        $this->getJson('/bo/api/games/bingo-pinball/rounds/'.$round['id'], $bo)->assertStatus(404);
        $this->assertSame([], $this->getJson('/bo/api/rounds?game=bingo-pinball', $bo)->json('rounds'));
    }

    public function test_the_per_game_csv_files_are_audited_and_safe(): void
    {
        $this->plays($this->bingoSession(), 3);
        $bo = $this->boHeaders();
        $csv = $this->get('/bo/api/export/bingo-rounds.csv', $bo)->assertOk()->assertHeader('Content-Disposition', 'attachment; filename="bingo-rounds.csv"')->getContent();
        $this->assertSame(4, count(array_filter(explode("\n", trim($csv)))));
        $this->assertStringStartsWith('round,time,player,status,stake,paid,holes', $csv);
        $games = $this->get('/bo/api/export/games.csv', $bo)->assertOk()->getContent();
        $this->assertStringContainsString("\nbingo-pinball,3,3000,", $games);
        $this->assertSame(2, DB::table('audit_log')->where('client', 'acme')->where('entry', 'like', '%"action":"export"%')->count());
    }

    public function test_the_admin_console_shows_each_game_in_total_and_per_client(): void
    {
        $this->staff('_operator', 'olga', 'viewer');
        $adm = $this->signIn('admin', null, 'olga')[0];
        $this->plays($this->bingoSession(), 4);
        $g = $this->getJson('/admin/api/games', $adm)->assertOk()->json();
        $this->assertSame(4, $g['games']['bingo-pinball']['plays']);
        $this->assertSame(4, $g['clients']['acme']['games']['bingo-pinball']['plays']);
        $this->assertSame(96, $g['clients']['acme']['paytables']['bingo-pinball']);
        $this->assertSame(['horse-race', 'bingo-pinball'], $g['clients']['acme']['enabled']);
        $this->assertSame(['horse-race'], $g['clients']['zeta']['enabled'], 'switched off for clients that were not given the game');
        $this->assertSame(['horse-race', 'bingo-pinball'], array_column($g['available'], 'id'));
    }

    public function test_metrics_carry_a_game_label_and_the_old_names_stay(): void
    {
        $this->plays($this->bingoSession(), 3);
        $text = $this->get('/metrics', ['X-Controller-Key' => 'ctl-key-for-tests'])->assertOk()->getContent();
        $this->assertStringContainsString('horse_game_plays_total{game="bingo-pinball"} 3', $text);
        $this->assertStringContainsString('horse_game_staked_total{game="bingo-pinball",currency="PHP"} 3000', $text);
        $this->assertMatchesRegularExpression('/^horse_game_rtp_theoretical\{game="bingo-pinball"\} 0\.96/m', $text);
        $this->assertStringContainsString('horse_game_plays_total{game="horse-race"} 0', $text);
        foreach (['horse_rounds_total', 'horse_rtp_zscore', 'horse_pending_credits', 'horse_client_staked_total'] as $old) {
            $this->assertStringContainsString("# TYPE $old", $text);
        }
    }

    public function test_alerts_for_bingo_rtp_drift_and_stuck_wins(): void
    {
        $alerts = new AlertManager($this->engine, config('horse.alerts'), null, fn () => $this->t);
        $this->assertSame([], array_column($alerts->current(), 'name'));
        DB::table('instant_rounds')->insert(array_map(fn ($i) => ['game_id' => 'bingo-pinball', 'player_key' => 'acme:x', 'client_id' => 'acme', 'stake' => 1000, 'currency' => 'PHP', 'paytable_id' => 'bp-v96-1', 'paytable_version' => 96,
            'holes' => '[1,2,3,4,5]', 'best_lit' => 0, 'best_line' => 0, 'multiple' => 0, 'payout' => 0, 'status' => 'settled', 'request_id' => 'a'.$i, 'created_at' => $this->t, 'settled_at' => $this->t], range(1, 1200)));
        $names = array_column($alerts->current(), 'name');
        $this->assertContains('rtp_drift:bingo-pinball', $names);
        $this->assertNotContains('rtp_drift', $names, 'the horse race has its own check');
        $this->assertNotContains('bingo_credits_stuck', $names);
        DB::table('pending_ops')->insert(['tx_id' => 'bp:77:win', 'kind' => 'credit', 'player_key' => 'acme:x', 'amount' => 2000, 'since' => $this->t - 600000, 'tries' => 3, 'next_at' => 0, 'game_id' => 'bingo-pinball', 'round_ref' => 'bp:77']);
        $names = array_column($alerts->current(), 'name');
        $this->assertContains('bingo_credits_stuck', $names);
        $this->assertContains('credits_stuck', $names, 'and the shared queue alert still sees it');
        DB::table('pending_ops')->where('tx_id', 'bp:77:win')->update(['kind' => 'rollback', 'tx_id' => 'bp:77:bet']);
        $this->assertContains('bingo_rollbacks_stuck', array_column($alerts->current(), 'name'));
    }

    public function test_the_reports_match_the_ledger_and_a_difference_is_found(): void
    {
        $this->plays($this->bingoSession(), 25);
        $this->plays($this->bingoSession('lou'), 10, 500);
        $res = app(Reconcile::class)->run();
        $this->assertTrue($res['ok'], json_encode($res));
        $this->assertSame(35, collect($res['games']['bingo-pinball']['checks'])->firstWhere('name', 'settled plays')['ledger']);
        $this->artisan('games:reconcile')->expectsOutputToContain('every game matches the ledger')->assertSuccessful();
        $id = (int) DB::table('instant_rounds')->where('payout', '>', 0)->value('id') ?: (int) DB::table('instant_rounds')->value('id');
        DB::table('instant_rounds')->where('id', $id)->update(['payout' => DB::raw('payout + 100')]);
        $this->artisan('games:reconcile')->expectsOutputToContain('the reports and the ledger differ')->assertFailed();
        $res = app(Reconcile::class)->run();
        $this->assertFalse($res['games']['bingo-pinball']['ok']);
        $this->assertTrue($res['games']['horse-race']['ok']);
    }

    public function test_everything_keeps_working_when_the_code_is_deployed_before_the_migration(): void
    {
        \Illuminate\Support\Facades\Schema::drop('instant_rounds');         // the new tables are not there yet
        $this->staff('_operator', 'olga', 'viewer');
        $adm = $this->signIn('admin', null, 'olga')[0];
        $o = $this->getJson('/admin/api/overview', $adm)->assertOk()->json();
        $this->assertSame([], $o['alerts']);
        $g = $this->getJson('/admin/api/games', $adm)->assertOk()->json();
        $this->assertSame(0, $g['games']['bingo-pinball']['plays']);
        $this->assertSame(0, $g['games']['bingo-pinball']['pending']['credits']['count']);
        $this->get('/metrics', ['X-Controller-Key' => 'ctl-key-for-tests'])->assertOk()->assertSee('horse_game_plays_total{game="bingo-pinball"} 0', false);
        $this->assertSame([], array_column((new AlertManager($this->engine, config('horse.alerts'), null, fn () => $this->t))->current(), 'name'));
    }
}
