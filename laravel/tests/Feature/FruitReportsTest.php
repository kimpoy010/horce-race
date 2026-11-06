<?php

namespace Tests\Feature;

use App\Game\AlertManager;
use App\Games\FruitRing\Par;
use App\Games\GameReports;
use App\Games\Reconcile;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/** Phase E of Fruit Game: the figures, the consoles, /metrics, the alerts and the ledger reconciliation (held wins and double-ups included) */
class FruitReportsTest extends StaffTestCase
{
    private const BASE = '/api/games/fruit-ring';

    protected function setUp(): void
    {
        parent::setUp();
        config(['games.settings.fruit-ring.min_interval_ms' => 0, 'games.settings.fruit-ring.lock_wait_seconds' => 0]);
        $this->reg->update('acme', ['games' => ['horse-race', 'fruit-ring']]);
    }

    private function fruit(string $who = 'pat'): array
    {
        $s = $this->postJson(self::BASE.'/auth', ['client' => 'acme', 'token' => 'demo-'.$who])->assertOk()->json('session');

        return ['Authorization' => 'Bearer '.$s];
    }

    private function spin(array $h, array $bets = ['apple' => 2], int $credit = 100): array
    {
        return $this->postJson(self::BASE.'/play', ['bets' => $bets, 'credit' => $credit, 'requestId' => 'rq'.bin2hex(random_bytes(6))], $h)->assertOk()->json('round');
    }

    /** spins n times, collecting every win that is held; returns the settled rounds */
    private function play(array $h, int $n, array $bets = ['apple' => 2], int $credit = 100): array
    {
        $out = [];
        for ($i = 0; $i < $n; $i++) {
            $r = $this->spin($h, $bets, $credit);
            if ($r['status'] === 'open') {
                $r = $this->postJson(self::BASE.'/round/'.$r['id'].'/collect', [], $h)->assertOk()->json('round');
            }
            $out[] = $r;
        }

        return $out;
    }

    private function bo(string $role = 'viewer'): array
    {
        $this->staff('acme', 'bea', $role);

        return $this->signIn('bo', 'acme', 'bea')[0];
    }

    /** settled rounds without playing them: $win is the spin win of each (minor units), $exp what the maths expected of it */
    private function bulk(int $n, int $win, float $exp, float $var, int $doubles = 0, int $doublesWon = 0, string $status = 'settled', ?int $at = null): void
    {
        $at ??= $this->t;
        $rows = [];
        for ($i = 1; $i <= $n; $i++) {
            $rows[] = ['game_id' => 'fruit-ring', 'player_key' => 'acme:x', 'client_id' => 'acme', 'stake' => 200, 'currency' => 'PHP', 'paytable_id' => 'fr-v90-2', 'paytable_version' => 1,
                'multiple' => null, 'payout' => $win, 'status' => $status, 'request_id' => 'bulk'.$status.$at.$i, 'created_at' => $at, 'settled_at' => $status === 'settled' ? $at : null,
                'spin_win' => $win, 'exp_win' => $exp, 'var_win' => $var, 'doubles' => $doubles, 'doubles_won' => $doublesWon, 'details' => json_encode(['bets' => ['apple' => 2], 'credit' => 100, 'rounds' => [[0]], 'doubles' => [], 'held' => $win, 'spinWin' => $win])];
        }
        foreach (array_chunk($rows, 500) as $c) {
            DB::table('instant_rounds')->insert($c);
        }
    }

    public function test_the_figures_of_the_plays_and_the_double_ups(): void
    {
        $h = $this->fruit();
        $rounds = $this->play($h, 8);
        $g = app(GameReports::class)->summary()['fruit-ring'];
        $this->assertSame([8, 8 * 200, array_sum(array_column($rounds, 'payout'))], [$g['plays'], $g['staked'], $g['paid']]);
        $this->assertEqualsWithDelta(Par::symbolFigures()['apple']['rtp'], $g['rtpTheoretical'], 1e-9, 'the expected return of apple-only bets is the PAR figure of apple');
        $this->assertSame(['count' => 0, 'won' => 0], ['count' => $g['doubles']['count'], 'won' => $g['doubles']['won']]);
        // one win, doubled once, then left held
        for ($i = 0; $i < 60; $i++) {
            $r = $this->spin($h);
            if ($r['status'] === 'open') {
                $d = $this->postJson(self::BASE.'/round/'.$r['id'].'/double', ['side' => 'small', 'step' => 0], $h)->assertOk()->json('round');
                break;
            }
        }
        $this->assertArrayHasKey('doubles', $d ?? []);
        $g = app(GameReports::class)->summary()['fruit-ring'];
        $this->assertSame(1, $g['doubles']['count']);
        $this->assertSame($d['status'] === 'open' ? 1 : 0, $g['open']['count'], 'a doubled win that is not settled is still held');
        $this->assertSame(1, (int) DB::table('instant_rounds')->where('id', $d['id'])->value('doubles'));
    }

    public function test_the_alerts_judge_the_spins_the_double_ups_held_wins_and_the_queues(): void
    {
        $alerts = new AlertManager($this->engine, config('horse.alerts'), null, fn () => $this->t);
        $this->assertSame([], array_column($alerts->current(), 'name'));
        $this->bulk(2000, 0, 180.0, 40000.0);                                                   // 2,000 spins that never win where the maths expects 90%
        $g = app(GameReports::class)->summary()['fruit-ring'];
        $this->assertLessThan(-15, $g['rtpZ']);
        $this->assertContains('rtp_drift:fruit-ring', array_column($alerts->current(), 'name'));
        DB::table('instant_rounds')->where('game_id', 'fruit-ring')->delete();
        $this->bulk(500, 0, 0.0, 0.0, 1, 0);                                                    // 500 double-ups, none right
        $g = app(GameReports::class)->summary()['fruit-ring'];
        $this->assertSame([500, 0], [$g['doubles']['count'], $g['doubles']['won']]);
        $this->assertContains('double_drift:fruit-ring', array_column($alerts->current(), 'name'));
        DB::table('instant_rounds')->where('game_id', 'fruit-ring')->delete();
        $this->bulk(1, 400, 180.0, 40000.0, 0, 0, 'open', $this->t - 3600 * 1000);             // a win held for an hour
        $this->assertContains('fruit_open_stuck', array_column($alerts->current(), 'name'));
        DB::table('pending_ops')->insert(['tx_id' => 'fr:9:win', 'kind' => 'credit', 'player_key' => 'acme:x', 'amount' => 9000, 'since' => $this->t - 600000, 'tries' => 3, 'next_at' => 0, 'game_id' => 'fruit-ring', 'round_ref' => 'fr:9']);
        $this->assertContains('fruit_credits_stuck', array_column($alerts->current(), 'name'));
    }

    public function test_the_back_office_shows_the_plays_with_their_proof_and_exports_them(): void
    {
        $h = $this->fruit();
        $rounds = $this->play($h, 4);
        $bo = $this->bo();
        $games = $this->getJson('/bo/api/games', $bo)->assertOk()->json();
        $this->assertSame(4, $games['games']['fruit-ring']['plays']);
        $this->assertContains('fruit-ring', $games['enabled']);
        $list = $this->getJson('/bo/api/rounds?game=fruit-ring', $bo)->assertOk()->json('rounds');
        $this->assertSame(array_reverse(array_column($rounds, 'id')), array_column($list, 'id'));
        $this->assertSame(['pat'], array_column($this->getJson('/bo/api/players?game=fruit-ring', $bo)->json('players'), 'playerId'));
        $this->assertCount(4, $this->getJson('/bo/api/rounds?game=fruit-ring&player=pat', $bo)->json('rounds'));
        $this->assertCount(0, $this->getJson('/bo/api/rounds?game=fruit-ring&player=nobody', $bo)->json('rounds'));
        $id = $rounds[0]['id'];
        $one = $this->getJson('/bo/api/games/fruit-ring/rounds/'.$id, $bo)->assertOk()->json();
        $this->assertNull($one['proof']);
        $this->assertSame(['apple' => 2], $one['round']['bets']);
        $this->postJson(self::BASE.'/seed/rotate', [], $h)->assertOk();
        $one = $this->getJson('/bo/api/games/fruit-ring/rounds/'.$id, $bo)->assertOk()->json();
        $this->assertStringStartsWith('php bin/fruit-verify.php', $one['proof']['verify']['spin']);
        $this->getJson('/bo/api/games/fruit-ring/rounds/999999', $bo)->assertStatus(404);
        $csv = $this->get('/bo/api/export/fruit-rounds.csv', $bo)->assertOk()->assertHeader('Content-Disposition', 'attachment; filename="fruit-rounds.csv"')->getContent();
        $this->assertSame(5, count(array_filter(explode("\n", trim($csv)))));
        $this->assertStringStartsWith('round,time,player,status,stake,paid,spin_win,credit,bets', $csv);
        $this->assertSame(1, DB::table('audit_log')->where('client', 'acme')->where('entry', 'like', '%fruit-rounds.csv%')->count());
        $this->reg->update('zeta', ['games' => ['horse-race', 'fruit-ring']]);
        $this->staff('zeta', 'zoe', 'viewer');
        $zh = $this->signIn('bo', 'zeta', 'zoe')[0];
        $this->getJson('/bo/api/games/fruit-ring/rounds/'.$id, $zh)->assertStatus(404);
    }

    public function test_the_admin_console_and_metrics_show_the_game(): void
    {
        $this->staff('_operator', 'olga', 'viewer');
        $adm = $this->signIn('admin', null, 'olga')[0];
        $this->play($this->fruit(), 3);
        $g = $this->getJson('/admin/api/games', $adm)->assertOk()->json();
        $this->assertSame(3, $g['games']['fruit-ring']['plays']);
        $this->assertSame(3, $g['clients']['acme']['games']['fruit-ring']['plays']);
        $this->assertContains('fruit-ring', array_column($g['available'], 'id'));
        $text = $this->get('/metrics', ['X-Controller-Key' => 'ctl-key-for-tests'])->assertOk()->getContent();
        $this->assertStringContainsString('horse_game_plays_total{game="fruit-ring"} 3', $text);
        foreach (['horse_fruit_doubles_total', 'horse_fruit_double_zscore', 'horse_fruit_open_rounds'] as $m) {
            $this->assertStringContainsString("# TYPE $m", $text);
        }
        $this->assertStringContainsString('horse_fruit_open_rounds{game="fruit-ring"} 0', $text);
    }

    public function test_the_reports_match_the_ledger_with_held_wins_and_double_ups_and_a_difference_is_found(): void
    {
        $h = $this->fruit('pat');
        $this->play($h, 12);
        $held = null;
        for ($i = 0; $i < 80 && ! $held; $i++) {                                               // a win that is doubled once and left held
            $r = $this->spin($h);
            if ($r['status'] === 'open') {
                $held = $this->postJson(self::BASE.'/round/'.$r['id'].'/double', ['side' => 'big', 'step' => 0, 'take' => min(100, max(0, $r['held'] - 1))], $h)->assertOk()->json('round');
            }
        }
        $res = app(Reconcile::class)->run();
        $this->assertTrue($res['ok'], json_encode($res['games']['fruit-ring']));
        $checks = collect($res['games']['fruit-ring']['checks']);
        $this->assertSame($held['status'] === 'open' ? 1 : 0, $checks->firstWhere('name', 'wins held (open rounds) against the ledger')['ledger']);
        $this->assertSame(1, $checks->firstWhere('name', 'double-ups (rounds) against the ledger')['ledger']);
        $this->artisan('games:reconcile')->expectsOutputToContain('every game matches the ledger')->assertSuccessful();
        $settled = DB::table('instant_rounds')->where('game_id', 'fruit-ring')->where('status', 'settled')->orderBy('id')->first();
        DB::table('instant_rounds')->where('id', $settled->id)->update(['payout' => DB::raw('payout + 100')]);
        $res = app(Reconcile::class)->run();
        $this->assertFalse($res['games']['fruit-ring']['ok']);
        $this->assertTrue($res['games']['horse-race']['ok']);
        DB::table('instant_rounds')->where('id', $settled->id)->update(['payout' => DB::raw('payout - 100')]);
        $this->assertTrue(app(Reconcile::class)->run()['games']['fruit-ring']['ok']);
        DB::table('instant_rounds')->where('id', $settled->id)->update(['stake' => DB::raw('stake + 5')]);
        $this->artisan('games:reconcile')->expectsOutputToContain('the reports and the ledger differ')->assertFailed();
    }

    public function test_everything_keeps_working_when_the_code_is_deployed_before_the_migration_of_the_figures(): void
    {
        Schema::table('instant_rounds', fn ($t) => $t->dropColumn(['spin_win', 'exp_win', 'var_win', 'doubles', 'doubles_won']));
        $this->staff('_operator', 'olga', 'viewer');
        $adm = $this->signIn('admin', null, 'olga')[0];
        $this->getJson('/admin/api/overview', $adm)->assertOk();
        $g = $this->getJson('/admin/api/games', $adm)->assertOk()->json();
        $this->assertSame(0, $g['games']['fruit-ring']['plays']);
        $this->get('/metrics', ['X-Controller-Key' => 'ctl-key-for-tests'])->assertOk();
        $this->assertSame([], array_column((new AlertManager($this->engine, config('horse.alerts'), null, fn () => $this->t))->current(), 'name'));
        app(Reconcile::class)->run();
    }
}
