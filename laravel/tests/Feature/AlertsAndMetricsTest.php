<?php

namespace Tests\Feature;

use App\Game\AlertManager;
use App\Game\Engine;
use App\Game\Odds;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Http;

class AlertsAndMetricsTest extends StaffTestCase
{
    private AlertManager $alerts;

    protected function setUp(): void
    {
        parent::setUp();
        config(['horse.alert_webhook_url' => 'https://hooks.example/alerts']);
        $this->alerts = new AlertManager($this->engine, config('horse.alerts'), 'https://hooks.example/alerts', fn () => $this->t);
        $this->app->instance(AlertManager::class, $this->alerts);
        Http::fake(['https://hooks.example/*' => Http::response('ok')]);
    }

    private function names(): array
    {
        return array_column($this->alerts->list(), 'name');
    }

    public function test_a_healthy_game_has_no_alerts(): void
    {
        $this->assertSame([], $this->alerts->evaluate());
        Http::assertNothingSent();
        $this->artisan('alerts:check')->expectsOutputToContain('no alerts')->assertSuccessful();
    }

    public function test_a_stopped_round_loop_is_critical_and_resolves_when_it_runs_again(): void
    {
        $this->t += 20000;                                        // nobody ticked for 20 s
        $this->assertSame(['round_loop_stalled'], array_column($this->alerts->evaluate(), 'name'));
        Http::assertSent(fn ($r) => $r['status'] === 'firing' && $r['name'] === 'round_loop_stalled' && $r['severity'] === 'critical'
            && str_starts_with($r['text'], '[CRITICAL] Horse Race: round_loop_stalled - the round loop has not run for 20 s') && $r['id'] === 'round_loop_stalled:'.$r['since']);
        $this->artisan('alerts:check')->expectsOutputToContain('round_loop_stalled')->assertFailed();
        $this->engine->tick();
        $this->assertSame([], $this->alerts->evaluate());
        Http::assertSent(fn ($r) => $r['status'] === 'resolved' && str_starts_with($r['text'], '[RESOLVED]'));
        $this->assertSame(['resolved', 'firing'], array_column($this->alerts->recent(5), 'status'));
    }

    public function test_a_loop_that_never_started_is_reported_too(): void
    {
        Cache::forget('horse:tick');
        $r = collect($this->alerts->evaluate())->firstWhere('name', 'round_loop_stalled');
        $this->assertStringContainsString('is not running', $r['message']);
    }

    public function test_the_ledger_chain_breaking_is_critical(): void
    {
        $this->player('acme', 'pat');
        $this->assertNotContains('ledger_broken', array_column($this->alerts->evaluate(), 'name'));
        if (DB::getDriverName() === 'pgsql') {              // on PostgreSQL a trigger refuses any change: switch it off to play the part of an intruder with database rights
            DB::unprepared('ALTER TABLE ledger DISABLE TRIGGER ledger_no_change');
        }
        $first = (int) DB::table('ledger')->min('seq');                 // (sequences keep counting across tests on PostgreSQL)
        DB::table('ledger')->where('seq', $first)->update(['line' => str_replace('"rtp":0.9', '"rtp":0.99', DB::table('ledger')->where('seq', $first)->value('line'))]);
        $a = collect($this->alerts->evaluate())->firstWhere('name', 'ledger_broken');
        $this->assertSame('critical', $a['severity']);
        $this->assertStringContainsString('hash chain is broken at line 1', $a['message']);
        $this->assertFalse($this->engine->health()['ok']);
    }

    public function test_credits_rollbacks_and_webhooks_that_stay_undelivered_raise_alerts_after_their_time(): void
    {
        $old = fn ($min) => $this->t - $min * 60000;
        DB::table('pending_ops')->insert([
            ['tx_id' => 'win:1:acme:p1', 'kind' => 'credit', 'player_key' => 'acme:p1', 'amount' => 500, 'since' => $old(4), 'tries' => 3, 'next_at' => $this->t + 86400000],
            ['tx_id' => 'rb:bet:1:x', 'kind' => 'rollback', 'player_key' => 'acme:p1', 'amount' => 500, 'since' => $old(1), 'tries' => 1, 'next_at' => $this->t + 86400000],
            ['tx_id' => 'horse-race:acme:round:1', 'kind' => 'webhook', 'player_key' => '', 'amount' => 0, 'since' => $old(9), 'tries' => 1, 'next_at' => $this->t + 86400000],
        ]);
        $this->assertSame([], $this->alerts->evaluate(), 'not old enough yet');
        $this->t += 120000;                                       // credit 6 min, rollback 3 min, webhook 11 min
        $this->engine->tick();
        $got = collect($this->alerts->evaluate())->keyBy('name');
        $this->assertSame('critical', $got['credits_stuck']['severity']);
        $this->assertSame('critical', $got['rollbacks_stuck']['severity']);
        $this->assertSame('warning', $got['webhooks_stuck']['severity']);
        $this->assertStringContainsString('1 win/refund credit(s) not delivered to the wallet, the oldest for 6 min', $got['credits_stuck']['message']);
        $this->assertStringContainsString('a player may be charged for a bet that was not placed', $got['rollbacks_stuck']['message']);
        DB::table('pending_ops')->delete();
        $this->assertSame([], $this->alerts->evaluate());
    }

    public function test_each_clients_wallet_is_judged_on_its_own(): void
    {
        $at = $this->t;
        foreach (range(1, 8) as $i) {
            DB::table('wallet_calls')->insert(['at' => $at, 'client' => 'acme', 'op' => 'debit', 'ms' => 40, 'ok' => $i <= 5]);          // 3 of 8 fail: 37%
            DB::table('wallet_calls')->insert(['at' => $at, 'client' => 'zeta', 'op' => 'debit', 'ms' => $i <= 7 ? 4000 : 50, 'ok' => true]);    // slow
        }
        foreach (range(1, 30) as $i) {
            DB::table('wallet_calls')->insert(['at' => $at, 'client' => 'busy', 'op' => 'debit', 'ms' => 20, 'ok' => true]);               // healthy: cannot hide the others
        }
        $names = array_column($this->alerts->evaluate(), 'name');
        sort($names);
        $this->assertSame(['wallet_failing:acme', 'wallet_slow:zeta'], $names);
        $a = collect($this->alerts->list())->firstWhere('name', 'wallet_failing:acme');
        $this->assertStringContainsString('wallet of client acme calls failing: 38% of 8', $a['message']);
        $this->t += 301000;                                       // the window moves on
        $this->engine->tick();
        $this->assertSame([], $this->alerts->evaluate());
    }

    public function test_few_calls_are_not_judged_and_a_single_wallet_reads_wallet(): void
    {
        foreach (range(1, 4) as $i) {
            DB::table('wallet_calls')->insert(['at' => $this->t, 'client' => 'default', 'op' => 'debit', 'ms' => 9000, 'ok' => false]);
        }
        $this->assertSame([], $this->alerts->evaluate(), 'under 5 calls');
        DB::table('wallet_calls')->insert(['at' => $this->t, 'client' => 'default', 'op' => 'debit', 'ms' => 9000, 'ok' => false]);
        $names = array_column($this->alerts->evaluate(), 'name');
        sort($names);
        $this->assertSame(['wallet_failing', 'wallet_slow'], $names);
        $this->assertStringStartsWith('wallet calls failing', collect($this->alerts->list())->firstWhere('name', 'wallet_failing')['message']);
    }

    public function test_rtp_drift_and_low_disk_need_their_thresholds(): void
    {
        DB::table('settings')->updateOrInsert(['key' => 'rtp_track'], ['value' => json_encode(['exp' => 1000, 'varsum' => 100, 'paid' => 1100, 'staked' => 5000])]);   // z = +10
        $this->assertNotContains('rtp_drift', array_column($this->alerts->evaluate(), 'name'), 'too few races to judge');
        for ($i = 1; $i <= 300; $i++) {
            DB::table('rounds')->insert(['race_no' => 1000 + $i, 'seed' => str_repeat('a', 64), 'commit' => str_repeat('b', 64), 'odds' => json_encode(Odds::DEFAULT_ODDS), 'order' => '[1,2,3,4,5,6]', 'rtp' => 0.9, 'open_at' => 1, 'bet_close_at' => 2, 'status' => 'settled', 'combo' => '1-2']);
        }
        $a = collect($this->alerts->evaluate())->firstWhere('name', 'rtp_drift');
        $this->assertSame('warning', $a['severity']);
        $this->assertStringContainsString('10.0 standard deviations above what the odds predict', $a['message']);
        $quiet = new AlertManager($this->engine, ['diskFreeMb' => PHP_INT_MAX] + config('horse.alerts'), null, fn () => $this->t);
        $this->assertContains('disk_low', array_column($quiet->evaluate(), 'name'));
    }

    public function test_alerts_repeat_while_they_last_and_the_webhook_may_be_away(): void
    {
        Http::fake(['https://hooks.example/*' => Http::response('boom', 500)]);
        $this->t += 20000;
        $this->alerts->evaluate();
        $this->t += 29 * 60000;
        $this->alerts->evaluate();
        $this->assertCount(1, $this->alerts->recent(10), 'no reminder yet');
        $this->t += 60000;
        $this->alerts->evaluate();
        $recent = $this->alerts->recent(10);
        $this->assertCount(2, $recent);
        $this->assertTrue($recent[0]['reminder']);
        $this->assertStringContainsString('(still active)', $recent[0]['text']);
        $this->assertSame($recent[0]['since'], $recent[1]['since'], 'the same alert');
    }

    public function test_the_overview_and_the_controller_show_the_alerts(): void
    {
        $this->t += 20000;
        $this->alerts->evaluate();
        $this->staff('_operator', 'olga', 'viewer');
        [$h] = $this->signIn('admin', null, 'olga');
        $o = $this->getJson('/admin/api/overview', $h)->assertOk()->json();
        $this->assertSame(['round_loop_stalled'], array_column($o['alerts'], 'name'));
        $this->assertSame('firing', $o['recentAlerts'][0]['status']);
        $rep = $this->getJson('/api/report', ['X-Controller-Key' => 'ctl-key-for-tests'])->assertOk()->json();
        $this->assertSame(['round_loop_stalled'], array_column($rep['ops']['alerts'], 'name'));
    }

    public function test_metrics_need_the_operator_key_and_follow_the_prometheus_text_format(): void
    {
        $s = $this->player('acme', 'pat');
        $bets = array_map(fn ($c) => ['combo' => $c, 'stake' => 1000], Odds::combos());
        $this->postJson('/api/bet', ['bets' => $bets], ['Authorization' => 'Bearer '.$s])->assertOk();
        $this->t += 25000;
        $this->engine->tick();
        $this->t += 36000;
        $this->engine->tick();
        $this->get('/metrics')->assertStatus(401);
        $this->get('/metrics', ['X-Controller-Key' => 'wrong'])->assertStatus(401);
        $r = $this->get('/metrics', ['Authorization' => 'Bearer ctl-key-for-tests'])->assertOk();
        $this->assertStringStartsWith('text/plain; version=0.0.4', $r->headers->get('content-type'));
        $m = $r->getContent();
        foreach (['horse_up 1', 'horse_rounds_total 1', 'horse_bets_total 15', 'horse_staked_total{currency="PHP"} 15000', 'horse_ledger_ok 1', 'horse_sessions_active 1', 'horse_pending_credits 0',
            'horse_client_staked_total{client="acme"} 15000', 'horse_client_bets_total{client="acme"} 15', 'horse_wallet_calls_total{client="acme",op="debit",result="ok"} 1',
            'horse_wallet_calls_total{client="acme",op="debit",result="fail"} 0', 'horse_rtp_setting 0.9'] as $line) {
            $this->assertStringContainsString("\n".$line."\n", "\n".$m, $line);
        }
        $this->assertMatchesRegularExpression('/^horse_staked_total\{currency="PHP"\} \d+$/m', $m);
        // every sample line is "name{labels} value" and each family has HELP and TYPE
        foreach (explode("\n", trim($m)) as $l) {
            $this->assertMatchesRegularExpression('/^(# (HELP|TYPE) \w+ .+|\w+(\{[^}]*\})? -?[0-9.e+]+)$/', $l, $l);
        }
        $this->assertStringContainsString('# TYPE horse_wallet_latency_seconds histogram', $m);
        $this->assertMatchesRegularExpression('/horse_wallet_latency_seconds_bucket\{le="\+Inf",client="acme",op="debit"\} 1/', $m);
        $this->assertStringContainsString('horse_wallet_latency_seconds_count{client="acme",op="debit"} 1', $m);
    }

    public function test_wallet_counters_only_go_up_even_when_the_detailed_calls_are_pruned(): void
    {
        $this->player('acme', 'pat');
        $this->player('zeta', 'zed');
        $this->t += 2 * 3600000;
        $this->engine->tick();                                    // prunes calls older than an hour
        $this->assertSame(0, DB::table('wallet_calls')->count());
        $m = $this->get('/metrics', ['X-Controller-Key' => 'ctl-key-for-tests'])->getContent();
        $this->assertStringContainsString('horse_wallet_calls_total{client="acme",op="validate",result="ok"} 1', $m);
        $this->assertStringContainsString('horse_wallet_calls_total{client="zeta",op="validate",result="ok"} 1', $m);
        $this->player('acme', 'pia');
        $m = $this->get('/metrics', ['X-Controller-Key' => 'ctl-key-for-tests'])->getContent();
        $this->assertStringContainsString('horse_wallet_calls_total{client="acme",op="validate",result="ok"} 2', $m);
    }

    public function test_firing_alerts_show_up_in_the_metrics(): void
    {
        $this->t += 20000;
        $m = $this->get('/metrics', ['X-Controller-Key' => 'ctl-key-for-tests'])->getContent();
        $this->assertStringContainsString('horse_alert_firing{name="round_loop_stalled",severity="critical"} 1', $m);
        $this->assertStringContainsString('horse_role{role="down"} 1', $m);
    }
}
