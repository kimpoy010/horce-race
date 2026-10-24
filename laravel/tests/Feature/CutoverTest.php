<?php

namespace Tests\Feature;

use App\Game\Clients\ClientRegistry;
use App\Game\Engine;
use App\Game\Ledger;
use App\Game\Rng;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Tests\TestCase;

/** taking over the Node server's data (docs/CUTOVER.md): tests/fixtures/node-state is what the Node engine left behind (make-node-state.cjs) */
class CutoverTest extends TestCase
{
    use RefreshDatabase;

    private int $t = 1_800_000_500_000;

    private array $exp;

    private string $dir;

    private Engine $engine;

    protected function setUp(): void
    {
        parent::setUp();
        $this->dir = __DIR__.'/../fixtures/node-state';
        $this->exp = json_decode(file_get_contents($this->dir.'/expected.json'), true);
        config(['horse.wallet' => 'none', 'horse.clients_key' => $this->exp['clientsKey']]);
        $reg = new ClientRegistry($this->exp['clientsKey'], allowMock: true, clock: fn () => $this->t, cacheMs: 0);
        $this->app->instance(ClientRegistry::class, $reg);
        $this->engine = new Engine(null, new Ledger, config('horse'), fn () => $this->t, $reg, null);
        $this->app->instance(Engine::class, $this->engine);
    }

    private function import(array $extra = []): \Illuminate\Testing\PendingCommand
    {
        return $this->artisan('import:node', ['--dir' => $this->dir] + $extra);
    }

    public function test_a_dry_run_checks_everything_and_writes_nothing(): void
    {
        $this->import(['--dry-run' => true])->expectsOutputToContain('chain intact')->expectsOutputToContain('nothing was written')->assertSuccessful();
        $this->assertSame(0, DB::table('ledger')->count());
        $this->assertSame(0, DB::table('rounds')->count());
        $this->assertSame(0, DB::table('clients')->count());
    }

    public function test_the_import_rebuilds_races_bets_owed_money_clients_and_the_block_list(): void
    {
        $this->import()->expectsOutputToContain('done. ledger head')->assertSuccessful();
        $rounds = DB::table('rounds')->orderBy('race_no')->get()->keyBy('race_no');
        $this->assertCount(3, $rounds);
        foreach ($this->exp['rounds'] as $e) {
            $r = $rounds[$e['raceNo']];
            $this->assertSame($e['seed'], $r->seed);
            $this->assertSame($e['commit'], $r->commit);
            $this->assertEqualsWithDelta($e['rtp'], (float) $r->rtp, 1e-9);
            if ($e['status'] === 'settled') {
                $this->assertSame('settled', $r->status);
                $this->assertSame($e['combo'], $r->combo);
                $this->assertSame($e['staked'], (int) $r->staked);
                $this->assertSame($e['paid'], (int) $r->paid);
            }
        }
        $this->assertSame('void', $rounds[3]->status, 'the race that was taking bets is cancelled');
        $this->assertEqualsWithDelta(0.93, (float) $rounds[3]->rtp, 1e-9, 'it was opened with the changed RTP');
        // bets: results worked out like Node does, the cancelled race refunded
        $this->assertSame(15500, (int) DB::table('bets')->where('race_no', 1)->sum('stake'));
        $this->assertSame($this->exp['rounds'][0]['paid'], (int) DB::table('bets')->where('race_no', 1)->sum('payout'));
        $this->assertSame(['refunded'], DB::table('bets')->where('race_no', 3)->pluck('status')->unique()->values()->all());
        $this->assertSame(['acme', 'zeta'], DB::table('bets')->distinct()->orderBy('client_id')->pluck('client_id')->all());
        // what the wallet still has to be told: the win Node could not credit, and the two refunds of the cancelled race
        $owed = DB::table('pending_ops')->orderBy('tx_id')->pluck('amount', 'tx_id')->all();
        $this->assertSame(['refund:3:acme:ann' => 700, 'refund:3:zeta:zed' => 300, 'win:2:acme:ann' => $this->exp['rounds'][1]['paid']], $owed);
        $this->assertSame(['acme:bad'], DB::table('blocked_players')->pluck('player_key')->all());
        $this->assertEquals(0.93, $this->engine->rtp());
        $this->assertSame(['acme', 'zeta'], DB::table('clients')->orderBy('id')->pluck('id')->all());
    }

    public function test_the_ledger_chain_continues_from_the_node_servers_last_line(): void
    {
        $this->import()->assertSuccessful();
        $nodeLines = array_values(array_filter(explode("\n", file_get_contents($this->dir.'/ledger.jsonl'))));
        $this->assertSame($this->exp['ledgerLines'], count($nodeLines));
        $mine = DB::table('ledger')->orderBy('seq')->pluck('line')->all();
        $this->assertSame($nodeLines, array_slice($mine, 0, count($nodeLines)), 'the Node lines are copied byte for byte');
        $this->assertGreaterThan(count($nodeLines), count($mine), 'the void and the refund credits were added');
        $v = Ledger::verifyLines($mine);
        $this->assertTrue($v['ok']);
        $this->assertSame($this->exp['ledgerHead'], Ledger::verifyLines($nodeLines)['head']);
        $first = json_decode($mine[count($nodeLines)], true);
        $this->assertSame('void', $first['e']);
        $this->assertSame(Ledger::sha($this->exp['ledgerHead'].Ledger::json(array_diff_key($first, ['h' => 1]))), $first['h'], 'hashed onto the Node server\'s last hash');
        $this->artisan('ledger verify')->expectsOutputToContain('INTACT')->assertSuccessful();
    }

    public function test_the_game_carries_on_race_numbers_proofs_and_history_survive(): void
    {
        $this->import()->assertSuccessful();
        $this->engine->tick();                                    // the cancelled race makes room for a fresh one
        $this->assertSame(4, (int) DB::table('rounds')->max('race_no'), 'race numbers continue: no wallet transaction id is used twice');
        $this->assertSame('betting', DB::table('rounds')->where('race_no', 4)->value('status'));
        $this->assertSame('betting', $this->getJson('/api/public')->json('round.phase'));
        // the draw of an old race can still be checked by anyone
        $proof = $this->getJson('/api/round/1')->assertOk()->json();
        $this->assertSame(hash('sha256', $proof['seed']), $proof['commit']);
        $this->assertSame($proof['combo'], Rng::draw($proof['seed'], 1, \App\Game\Odds::buildForRtp($proof['odds'], $proof['rtp'])['weights'])['combo']);
        $this->getJson('/api/round/3')->assertStatus(404);        // a cancelled race has no result
        // the debts are paid: the daemon delivers them to the wallets
        $this->engine->flushCredits();
        $this->assertSame(0, DB::table('pending_ops')->count());
        $this->assertContains('credit_ok', DB::table('ledger')->orderBy('seq')->pluck('line')->map(fn ($l) => json_decode($l, true)['e'])->all());
        // history of a player from before the cutover
        $s = $this->postJson('/api/auth', ['client' => 'acme', 'token' => 'demo-ann'])->assertOk()->json('session');
        $h = $this->getJson('/api/history', ['Authorization' => 'Bearer '.$s])->assertOk()->json('rounds');
        $this->assertSame([3, 2, 1], array_column($h, 'raceNo'));
        $this->assertSame('refunded', $h[0]['bets'][0]['status']);
        $this->postJson('/api/auth', ['client' => 'acme', 'token' => 'demo-bad'])->assertStatus(403)->assertJsonPath('error', 'PLAYER_BLOCKED');
        // a bet in the new race works, and its numbers show up
        $this->postJson('/api/bet', ['bets' => [['combo' => '1-2', 'stake' => 1000]]], ['Authorization' => 'Bearer '.$s])->assertOk();
        $this->assertTrue($this->engine->ledger()->verify()['ok']);
    }

    public function test_an_unfinished_but_drawn_race_is_settled_by_the_round_loop(): void
    {
        // edit a copy of the fixture: pretend the server stopped after the draw of race 3 (take the draw from a real settlement of the same seed)
        $tmp = sys_get_temp_dir().'/node-state-'.getmypid();
        mkdir($tmp);
        foreach (['clients.json', 'blocked.json', 'settings.json'] as $f) {
            copy($this->dir.'/'.$f, $tmp.'/'.$f);
        }
        $lines = array_values(array_filter(explode("\n", file_get_contents($this->dir.'/ledger.jsonl'))));
        $lines = array_values(array_filter($lines, fn ($l) => ! in_array(json_decode($l, true)['e'], ['shutdown'], true)));
        $chain = [];
        $prev = Ledger::sha('');
        foreach ($lines as $l) {                                   // re-chain without the shutdown line, then add a draw
            $ev = json_decode(Ledger::stripHash($l), true);
            $line = Ledger::json($ev + ['h' => $h = Ledger::sha($prev.Ledger::json($ev))]);
            $chain[] = $line;
            $prev = $h;
        }
        $r3 = collect($chain)->map(fn ($l) => json_decode($l, true))->firstWhere(fn ($e) => $e['e'] === 'open' && $e['raceNo'] === 3);
        $odds = $r3['odds'];
        $d = Rng::draw($r3['seed'], 3, \App\Game\Odds::buildForRtp($odds, $r3['rtp'])['weights']);
        $ev = ['e' => 'draw', 'raceNo' => 3, 'combo' => $d['combo'], 'order' => $d['order'], 'animSeed' => $d['animSeed'], 'startAt' => $this->t - 100000, 't' => $this->t - 100000];
        $chain[] = Ledger::json($ev + ['h' => Ledger::sha($prev.Ledger::json($ev))]);
        file_put_contents($tmp.'/ledger.jsonl', implode("\n", $chain)."\n");
        $this->artisan('import:node', ['--dir' => $tmp])->assertSuccessful();
        $this->assertSame('racing', DB::table('rounds')->where('race_no', 3)->value('status'));
        $this->engine->tick();                                    // the race is long over: it is settled and the winners are paid
        $this->assertSame('settled', DB::table('rounds')->where('race_no', 3)->value('status'));
        $this->assertSame(0, DB::table('pending_ops')->count());
        array_map('unlink', glob($tmp.'/*'));
        rmdir($tmp);
    }

    public function test_a_broken_ledger_or_a_used_database_is_refused_and_nothing_is_written(): void
    {
        $tmp = sys_get_temp_dir().'/node-state-bad-'.getmypid();
        mkdir($tmp);
        $lines = explode("\n", file_get_contents($this->dir.'/ledger.jsonl'));
        $lines[10] = str_replace('"stake":1000', '"stake":9000', $lines[10]);
        file_put_contents($tmp.'/ledger.jsonl', implode("\n", $lines));
        $this->artisan('import:node', ['--dir' => $tmp])->expectsOutputToContain('hash chain')->assertFailed();
        $this->assertSame(0, DB::table('ledger')->count());
        array_map('unlink', glob($tmp.'/*'));
        rmdir($tmp);
        $this->artisan('import:node', ['--dir' => '/nonexistent'])->assertFailed();
        $this->import()->assertSuccessful();
        $this->import()->expectsOutputToContain('already has races or ledger lines')->assertFailed();
    }

    public function test_going_back_the_ledger_and_the_clients_are_exported_in_the_node_format(): void
    {
        $this->import()->assertSuccessful();
        $this->engine->tick();
        $f = sys_get_temp_dir().'/ledger-export-'.getmypid().'.jsonl';
        $c = sys_get_temp_dir().'/clients-export-'.getmypid().'.json';
        $this->artisan('ledger', ['action' => 'export', 'file' => $f])->assertSuccessful();
        $this->artisan('clients', ['action' => 'export', 'id' => $c])->assertSuccessful();
        $root = realpath(__DIR__.'/../../..');
        if (trim((string) shell_exec('command -v node')) === '') {
            $this->markTestIncomplete('node is not installed: the Node server cannot be asked to read the export');
        }
        // the Node tools accept what Laravel wrote: the chain verifies, and the registry loads with the same key
        exec('node '.escapeshellarg($root.'/scripts/verify-ledger.js').' '.escapeshellarg($f).' 2>&1', $out, $code);
        $this->assertSame(0, $code, implode("\n", $out));
        $this->assertStringContainsString('INTACT', implode("\n", $out));
        $js = "const {ClientRegistry}=require('$root/server/clients.js');const r=new ClientRegistry({file:'$c',secret:'{$this->exp['clientsKey']}',allowMock:true});"
            ."if(r.loadError||!r.get('acme')||!r.get('zeta'))process.exit(3);console.log('clients',r.count());";
        exec('node -e '.escapeshellarg($js).' 2>&1', $out2, $code2);
        $this->assertSame(0, $code2, implode("\n", $out2));
        $this->assertStringContainsString('clients 2', implode("\n", $out2));
        unlink($f);
        unlink($c);
    }
}
