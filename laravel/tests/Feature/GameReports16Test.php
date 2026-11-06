<?php

namespace Tests\Feature;

use App\Game\AlertManager;
use App\Game\Clients\SecretBox;
use App\Games\BingoPinball16\Par;
use App\Games\GameReports;
use App\Games\Reconcile;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/** Phase E of Bingo Pinball 16: the figures, the consoles, /metrics, the alerts and the ledger reconciliation, including its jackpot pool */
class GameReports16Test extends StaffTestCase
{
    private const BASE = '/api/games/bingo-pinball-16';

    protected function setUp(): void
    {
        parent::setUp();
        config(['games.settings.bingo-pinball-16.min_interval_ms' => 0, 'games.settings.bingo-pinball-16.lock_wait_seconds' => 0]);
        $this->reg->update('acme', ['games' => ['horse-race', 'bingo-pinball-16']]);
    }

    private function player16(string $who = 'pat'): array
    {
        $s = $this->postJson(self::BASE.'/auth', ['client' => 'acme', 'token' => 'demo-'.$who])->assertOk()->json('session');

        return ['Authorization' => 'Bearer '.$s];
    }

    private function plays(array $h, int $n, int $stake = 1000): array
    {
        $out = [];
        for ($i = 0; $i < $n; $i++) {
            $out[] = $this->postJson(self::BASE.'/play', ['stake' => $stake, 'requestId' => 'rq'.$i.bin2hex(random_bytes(4))], $h)->assertOk()->json('round');
        }

        return $out;
    }

    private function rig(string $who, array $vector): void
    {
        DB::table('player_seeds')->where('player_key', 'acme:'.$who)->where('game_id', 'bingo-pinball-16')->where('status', 'active')->update([
            'server_seed' => SecretBox::encrypt($vector['serverSeed'], 'clients-key-for-tests-1234'), 'commit' => $vector['commit'], 'client_seed' => $vector['clientSeed'], 'next_nonce' => $vector['nonce']]);
    }

    private function jackpotVector(): array
    {
        foreach (json_decode(file_get_contents(__DIR__.'/../../docs/bingo16/test-vectors.json'), true) as $v) {
            if ($v['jackpot'] && $v['halves'] > 0) {
                return $v;
            }
        }
        $this->fail('no jackpot vector');
    }

    private function bo(string $role = 'viewer'): array
    {
        $this->staff('acme', 'bea', $role);

        return $this->signIn('bo', 'acme', 'bea')[0];
    }

    /** a bulk of settled plays without playing them (for figures that need thousands) */
    private function bulk(int $n, int $multiple, int $jackpotPaid = 0, int $jackpotEvery = 0): void
    {
        $at = $this->t;
        $rows = [];
        for ($i = 1; $i <= $n; $i++) {
            $jp = $jackpotEvery && $i % $jackpotEvery === 0 ? 5000 : $jackpotPaid;
            $rows[] = ['game_id' => 'bingo-pinball-16', 'player_key' => 'acme:x', 'client_id' => 'acme', 'stake' => 1000, 'currency' => 'PHP', 'paytable_id' => 'b16-v90-3', 'paytable_version' => 1, 'best_lit' => 4,
                'multiple' => $multiple * 2, 'payout' => 1000 * $multiple + $jp, 'jackpot_paid' => $jp, 'pattern' => $multiple === 2 ? 'lshape' : null, 'status' => 'settled', 'request_id' => 'bulk'.$i, 'created_at' => $at, 'settled_at' => $at];
        }
        foreach (array_chunk($rows, 500) as $c) {
            DB::table('instant_rounds')->insert($c);
        }
    }

    public function test_the_summary_counts_the_game_with_its_patterns_and_its_pool(): void
    {
        $rounds = $this->plays($this->player16(), 40);
        $g = app(GameReports::class)->summary('acme')['bingo-pinball-16'];
        $this->assertSame([40, 40000], [$g['plays'], $g['staked']]);
        $this->assertSame(array_sum(array_column($rounds, 'payout')), $g['paid']);
        $this->assertSame($g['paid'], $g['patternPaid'] + $g['jackpotPaid']);
        $par = Par::enumerate();
        $this->assertEqualsWithDelta($par['rtp'] + 0.0148, $g['rtpTheoretical'], 1e-9);
        $this->assertEqualsWithDelta($par['hit'], $g['hitFrequencyTheoretical'], 1e-9);
        $counted = array_sum(array_column((array) $g['patterns'], 'count'));
        $this->assertSame(count(array_filter($rounds, fn ($r) => $r['pattern'] !== null)), $counted);
        $this->assertEqualsWithDelta(40 * $par['patterns']['lshape'], ((array) $g['patterns'])['lshape']['expected'], 1e-9);
        $pool = ((array) $g['pools'])['PHP'];
        $this->assertTrue($pool['balanced']);
        $this->assertGreaterThanOrEqual(10000, $pool['amount']);
        $this->assertSame(0, app(GameReports::class)->summary('zeta')['bingo-pinball-16']['plays']);
    }

    public function test_the_alerts_judge_the_patterns_the_jackpots_and_the_books_of_the_pool(): void
    {
        config(['horse.alerts.jackpotMinExpected' => 1]);                                      // a jackpot is about 1 in 21,600 plays: judge it after 1 expected, not 5
        $alerts = new AlertManager($this->engine, config('horse.alerts'), null, fn () => $this->t);
        $this->assertSame([], array_column($alerts->current(), 'name'));
        $this->bulk(20000, 0);                                                                  // 20,000 plays that never win: far below the PAR sheet
        $z = app(GameReports::class)->summary()['bingo-pinball-16']['rtpZ'];
        $this->assertLessThan(-15, $z);
        $this->assertContains('rtp_drift:bingo-pinball-16', array_column($alerts->current(), 'name'));
        DB::table('instant_rounds')->where('game_id', 'bingo-pinball-16')->delete();
        $this->bulk(30000, 2, 0, 750);                                                          // 40 jackpots in 30,000 plays (the maths expects 6)
        $g = app(GameReports::class)->summary()['bingo-pinball-16'];
        $this->assertSame(40, $g['jackpotHits']);
        $this->assertGreaterThan(4, $g['jackpotZ']);
        $names = array_column($alerts->current(), 'name');
        $this->assertContains('jackpot_drift:bingo-pinball-16', $names);
        $this->assertContains('rtp_drift:bingo-pinball-16', $names, 'and these plays, all paying 2x, are far above the pattern pays of the PAR sheet');
        // the pool's books
        $this->player16();
        app(GameReports::class)->pools();
        $this->plays($this->player16('amy'), 1);
        $this->assertNotContains('jackpot_books:bingo-pinball-16:PHP', array_column($alerts->current(), 'name'));
        DB::table('jackpot_pools')->where('id', 'bingo-pinball-16:PHP')->update(['amount' => DB::raw('amount + 7')]);
        $this->assertContains('jackpot_books:bingo-pinball-16:PHP', array_column($alerts->current(), 'name'));
        DB::table('jackpot_pools')->where('id', 'bingo-pinball-16:PHP')->update(['amount' => 5, 'seeded' => 5, 'contributed' => 0, 'paid' => 0]);
        $this->assertContains('jackpot_below_seed:bingo-pinball-16:PHP', array_column($alerts->current(), 'name'));
        // a win credit the wallet has not taken
        DB::table('pending_ops')->insert(['tx_id' => 'b16:9:win', 'kind' => 'credit', 'player_key' => 'acme:x', 'amount' => 9000, 'since' => $this->t - 600000, 'tries' => 3, 'next_at' => 0, 'game_id' => 'bingo-pinball-16', 'round_ref' => 'b16:9']);
        $this->assertContains('bingo16_credits_stuck', array_column($alerts->current(), 'name'));
    }

    public function test_the_back_office_shows_the_plays_with_their_proof_and_exports_them(): void
    {
        $h = $this->player16();
        $rounds = $this->plays($h, 5);
        $bo = $this->bo();
        $games = $this->getJson('/bo/api/games', $bo)->assertOk()->json();
        $this->assertSame(5, $games['games']['bingo-pinball-16']['plays']);
        $this->assertContains('bingo-pinball-16', $games['enabled']);
        $list = $this->getJson('/bo/api/rounds?game=bingo-pinball-16', $bo)->assertOk()->json('rounds');
        $this->assertSame(array_reverse(array_column($rounds, 'id')), array_column($list, 'id'));
        $this->assertSame(['pat'], array_column($this->getJson('/bo/api/players?game=bingo-pinball-16', $bo)->json('players'), 'playerId'));
        $this->assertCount(5, $this->getJson('/bo/api/rounds?game=bingo-pinball-16&player=pat', $bo)->json('rounds'));
        $this->assertCount(0, $this->getJson('/bo/api/rounds?game=bingo-pinball-16&player=nobody', $bo)->json('rounds'));
        $id = $rounds[0]['id'];
        $one = $this->getJson('/bo/api/games/bingo-pinball-16/rounds/'.$id, $bo)->assertOk()->json();
        $this->assertNull($one['proof']);
        $this->assertCount(16, $one['round']['balls']);
        $this->postJson(self::BASE.'/seed/rotate', [], $h)->assertOk();
        $one = $this->getJson('/bo/api/games/bingo-pinball-16/rounds/'.$id, $bo)->assertOk()->json();
        $this->assertStringStartsWith('php bin/bingo16-verify.php', $one['proof']['verify']);
        $this->getJson('/bo/api/games/bingo-pinball-16/rounds/999999', $bo)->assertStatus(404);
        $csv = $this->get('/bo/api/export/bingo16-rounds.csv', $bo)->assertOk()->assertHeader('Content-Disposition', 'attachment; filename="bingo16-rounds.csv"')->getContent();
        $this->assertSame(6, count(array_filter(explode("\n", trim($csv)))));
        $this->assertStringStartsWith('round,time,player,status,stake,paid,pattern_paid,jackpot_paid,pattern', $csv);
        $this->assertSame(1, DB::table('audit_log')->where('client', 'acme')->where('entry', 'like', '%bingo16-rounds.csv%')->count());
        // another client sees nothing of it
        $this->reg->update('zeta', ['games' => ['horse-race', 'bingo-pinball-16']]);
        $this->staff('zeta', 'zoe', 'viewer');
        $zh = $this->signIn('bo', 'zeta', 'zoe')[0];
        $this->getJson('/bo/api/games/bingo-pinball-16/rounds/'.$id, $zh)->assertStatus(404);
    }

    public function test_the_admin_console_and_metrics_show_the_pool_and_the_game(): void
    {
        $this->staff('_operator', 'olga', 'viewer');
        $adm = $this->signIn('admin', null, 'olga')[0];
        $this->plays($this->player16(), 4);
        $g = $this->getJson('/admin/api/games', $adm)->assertOk()->json();
        $this->assertSame(4, $g['games']['bingo-pinball-16']['plays']);
        $this->assertTrue($g['pools']['PHP']['balanced']);
        $this->assertSame(4, $g['clients']['acme']['games']['bingo-pinball-16']['plays']);
        $this->assertContains('bingo-pinball-16', array_column($g['available'], 'id'));
        $text = $this->get('/metrics', ['X-Controller-Key' => 'ctl-key-for-tests'])->assertOk()->getContent();
        $this->assertStringContainsString('horse_game_plays_total{game="bingo-pinball-16"} 4', $text);
        $this->assertMatchesRegularExpression('/^horse_jackpot_pool\{game="bingo-pinball-16",currency="PHP"\} \d+$/m', $text);
        $this->assertStringContainsString('horse_jackpot_balanced{game="bingo-pinball-16",currency="PHP"} 1', $text);
        $this->assertStringContainsString('# TYPE horse_jackpot_zscore gauge', $text);
        foreach (['horse_rounds_total', 'horse_rtp_zscore', 'horse_pending_credits'] as $old) {
            $this->assertStringContainsString("# TYPE $old", $text);
        }
    }

    public function test_the_reports_match_the_ledger_including_a_jackpot_and_a_difference_is_found(): void
    {
        $this->plays($this->player16('pat'), 15);
        $v = $this->jackpotVector();
        $this->player16('jan');
        $this->rig('jan', $v);
        $r = $this->plays($this->player16('jan'), 1)[0];
        $this->assertTrue($r['jackpot']);
        $this->plays($this->player16('pat'), 10, 500);
        $res = app(Reconcile::class)->run();
        $this->assertTrue($res['ok'], json_encode($res['games']['bingo-pinball-16']));
        $checks = collect($res['games']['bingo-pinball-16']['checks']);
        $this->assertSame(26, $checks->firstWhere('name', 'settled plays')['ledger']);
        $this->assertSame($r['jackpotPaid'], $checks->firstWhere('name', 'jackpots paid (pool) against the ledger')['ledger']);
        $this->artisan('games:reconcile')->expectsOutputToContain('every game matches the ledger')->assertSuccessful();
        DB::table('instant_rounds')->where('id', $r['id'])->update(['jackpot_paid' => DB::raw('jackpot_paid + 100'), 'payout' => DB::raw('payout + 100')]);
        $res = app(Reconcile::class)->run();
        $this->assertFalse($res['games']['bingo-pinball-16']['ok']);
        $this->assertTrue($res['games']['horse-race']['ok'] && $res['games']['bingo-pinball']['ok']);
        DB::table('instant_rounds')->where('id', $r['id'])->update(['jackpot_paid' => DB::raw('jackpot_paid - 100'), 'payout' => DB::raw('payout - 100')]);
        DB::table('jackpot_pools')->where('id', 'bingo-pinball-16:PHP')->update(['amount' => DB::raw('amount + 3')]);          // money that is not in the ledger
        $this->artisan('games:reconcile')->expectsOutputToContain('the reports and the ledger differ')->assertFailed();
    }

    public function test_everything_keeps_working_when_the_code_is_deployed_before_the_migration_of_this_game(): void
    {
        Schema::drop('jackpot_pools');
        $this->staff('_operator', 'olga', 'viewer');
        $adm = $this->signIn('admin', null, 'olga')[0];
        $this->getJson('/admin/api/overview', $adm)->assertOk();
        $g = $this->getJson('/admin/api/games', $adm)->assertOk()->json();
        $this->assertSame(0, $g['games']['bingo-pinball-16']['plays']);
        $this->get('/metrics', ['X-Controller-Key' => 'ctl-key-for-tests'])->assertOk();
        $this->assertSame([], array_column((new AlertManager($this->engine, config('horse.alerts'), null, fn () => $this->t))->current(), 'name'));
    }
}
