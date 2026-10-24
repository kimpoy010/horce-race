<?php

namespace Tests\Unit;

use App\Game\Ledger;
use App\Game\Odds;
use App\Game\Rng;
use App\Game\Wallet\Signer;
use PHPUnit\Framework\TestCase;

/**
 * The Laravel port must give exactly what the Node server gives: same odds weights, same layout, same draw for the same seed,
 * same ledger hashes. tests/fixtures/parity.json is made by tests/fixtures/make-parity.cjs from the Node code.
 */
class ParityTest extends TestCase
{
    private array $p;

    protected function setUp(): void
    {
        $this->p = json_decode(file_get_contents(__DIR__.'/../fixtures/parity.json'), true);
    }

    public function test_default_odds_table(): void
    {
        $t = Odds::build();
        $this->assertSame($this->p['odds']['weights'], $t['weights']);
        $this->assertSame($this->p['odds']['total'], $t['total']);
        $this->assertEqualsWithDelta($this->p['odds']['rtp'], $t['rtp'], 1e-12);
        $this->assertEqualsWithDelta(0.8684, $t['rtp'], 0.0001);
    }

    public function test_rtp_weights_match_node(): void
    {
        foreach ($this->p['rtps'] as $rtp => $want) {
            $t = Odds::buildForRtp(null, (float) $rtp);
            $this->assertSame($want['weights'], $t['weights'], "weights at $rtp");
            $this->assertSame($want['cheap'], $t['cheap']);
            $this->assertEqualsWithDelta($want['cheapRtp'], $t['cheapRtp'], 1e-12);
            $this->assertEqualsWithDelta($want['bestRtp'], $t['bestRtp'], 1e-12);
        }
    }

    public function test_rtp_out_of_range_is_refused(): void
    {
        $this->expectException(\InvalidArgumentException::class);
        Odds::buildForRtp(null, 0.80);
    }

    public function test_odds_layout_and_draw_match_node_for_40_seeds(): void
    {
        foreach ($this->p['layouts'] as $i => $L) {
            $layout = Rng::oddsLayout($L['seed'], $L['raceNo'], $this->p['values']);
            $this->assertEquals($L['layout'], $layout, "layout $i");
            $this->assertSame($L['weights'], Odds::buildForRtp($layout, 0.9)['weights']);
        }
        foreach ($this->p['draws'] as $i => $D) {
            $this->assertSame($D['result'], Rng::draw($D['seed'], $D['raceNo'], $D['weights']), "weighted draw $i");
            $this->assertSame($D['uniform'], Rng::draw($D['seed'], $D['raceNo']), "uniform draw $i");
        }
    }

    public function test_commit_is_sha256_of_the_seed_text(): void
    {
        foreach ($this->p['commits'] as $c) {
            $this->assertSame($c['commit'], Rng::commitOf($c['seed']));
        }
    }

    public function test_winning_pair_finishes_lower_number_first(): void
    {
        for ($i = 0; $i < 300; $i++) {
            $d = Rng::draw(Rng::newSeed(), $i + 1, Odds::buildForRtp(null, 0.9)['weights']);
            [$a, $b] = array_map('intval', explode('-', $d['combo']));
            $this->assertSame([$a, $b], array_slice($d['order'], 0, 2));
            $this->assertLessThan($b, $a);
            $this->assertSame([1, 2, 3, 4, 5, 6], collect($d['order'])->sort()->values()->all());
        }
    }

    public function test_node_ledger_chain_verifies_in_php(): void
    {
        $r = Ledger::verifyLines($this->p['ledger']['lines']);
        $this->assertTrue($r['ok']);
        $this->assertSame(12, $r['chained']);
        $this->assertSame($this->p['ledger']['head'], $r['head']);
    }

    public function test_tampered_ledger_is_detected(): void
    {
        $lines = $this->p['ledger']['lines'];
        $lines[5] = str_replace('"stake":500', '"stake":50', $lines[5]);
        $r = Ledger::verifyLines($lines);
        $this->assertFalse($r['ok']);
        $this->assertSame(6, $r['broken']['line']);
    }

    public function test_request_signature_has_the_node_format(): void
    {
        // vector made with server/sign.js: signature('secret-secret-secret', '1700000000000', 'abc', 'POST', '/horse-api/wallet/debit', '{"a":1}')
        $sig = Signer::signature('secret-secret-secret', '1700000000000', 'abc', 'POST', '/horse-api/wallet/debit', '{"a":1}');
        $this->assertSame($this->p['signature'], $sig);
    }
}
