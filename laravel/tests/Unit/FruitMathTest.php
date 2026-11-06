<?php

namespace Tests\Unit;

use App\Games\FruitRing\Draw;
use App\Games\FruitRing\Evaluator;
use App\Games\FruitRing\Par;
use App\Games\FruitRing\Rules;
use PHPUnit\Framework\TestCase;

require_once __DIR__.'/../../bin/fruit-verify.php';

/** Fruit Game, the maths package: frozen rules, the evaluator, the PAR figures against the independent Python figures, the draw and the standalone verifier. Pure code. */
class FruitMathTest extends TestCase
{
    private const FROZEN = '2e3b9cd540de12c8451f4f42c0069faa83bc8af6b920a40fc0f1e85200c1c50e';

    public function test_the_rules_are_frozen(): void
    {
        $this->assertSame(self::FROZEN, hash('sha256', Rules::canonical()), 'the rules of Fruit Game changed: a certified game is never edited, add a new version instead');
        $this->assertCount(24, Rules::RING);
        $this->assertSame(Rules::TOTAL_WEIGHT, array_sum(array_column(Rules::RING, 2)));
        $this->assertSame([9, 21], Rules::luckyCells());
        $this->assertSame('free3', Rules::RING[9][0]);
        $this->assertSame('light3', Rules::RING[21][0]);
    }

    public function test_the_python_vectors_agree(): void
    {
        $vectors = json_decode(file_get_contents(__DIR__.'/../../docs/fruit/test-vectors.json'), true);
        $this->assertCount(32, $vectors);
        foreach ($vectors as $v) {
            $this->assertSame($v['commit'], Draw::commitOf($v['serverSeed']));
            $lit = Draw::spin($v['serverSeed'], $v['clientSeed'], $v['nonce']);
            $this->assertSame($v['rounds'], $lit, 'rounds '.$v['clientSeed']);
            $this->assertSame($v['payouts'], Evaluator::payouts($lit));
            $this->assertSame($v['double'], Draw::doubleNumber($v['serverSeed'], $v['clientSeed'], $v['nonce']));
            $this->assertSame($v['rounds'], fr_spin($v['serverSeed'], $v['clientSeed'], $v['nonce']), 'standalone verifier');
            $this->assertSame($v['payouts'], fr_payouts($v['rounds']));
        }
    }

    public function test_par_agrees_with_the_exact_figures(): void
    {
        $exact = json_decode(file_get_contents(__DIR__.'/../../docs/fruit/par.json'), true);
        $p = Par::enumerate();
        $this->assertEqualsWithDelta($exact['allEightRtp'], $p['allEightRtp'], 1e-10);
        $this->assertEqualsWithDelta($exact['luckyShare'], $p['luckyShare'], 1e-10);
        foreach (Rules::SYMBOLS as $s) {
            foreach (['rtp', 'hit', 'stop', 'standardDeviation'] as $k) {
                $this->assertEqualsWithDelta($exact['symbols'][$s][$k], $p['symbols'][$s][$k], 1e-10, "$s $k");
            }
            $this->assertLessThanOrEqual(0.9, $p['symbols'][$s]['rtp'] + 1e-12);
            $this->assertGreaterThan(0.89, $p['symbols'][$s]['rtp']);
        }
    }

    public function test_pays_and_double(): void
    {
        $this->assertSame(30, Rules::cellPay(3));
        $this->assertSame(12, Rules::cellPay(2));
        $this->assertSame(0, Rules::cellPay(9));
        $this->assertSame(6, Rules::cellPay(11));
        $this->assertSame(['bar' => 0, 'seven' => 0, 'star' => 0, 'watermelon' => 0, 'bell' => 0, 'lemon' => 0, 'orange' => 4, 'apple' => 0], Evaluator::payouts([[0], [12]]));
        $this->assertSame(8, Evaluator::pay([[0], [12]], ['orange' => 2, 'apple' => 5]));
        $this->assertTrue(Evaluator::doubleWins(7, 'small'));
        $this->assertFalse(Evaluator::doubleWins(8, 'small'));
        $this->assertTrue(Evaluator::doubleWins(8, 'big'));
    }

    public function test_the_draw_is_uniform_and_returns_the_rtp(): void
    {
        $n = 60000;
        $seed = str_repeat('ab', 32);
        $stops = array_fill(0, 24, 0);
        $paid = 0;
        $dbl = array_fill(1, 14, 0);
        for ($i = 1; $i <= $n; $i++) {
            $lit = Draw::spin($seed, 'u', $i);
            $stops[$lit[0][0]]++;
            $paid += Evaluator::pay($lit, array_fill_keys(Rules::SYMBOLS, 1));
            $dbl[Draw::doubleNumber($seed, 'u', $i)]++;
        }
        $chi = 0.0;
        foreach (Rules::RING as $i => $c) {
            $e = $n * $c[2] / Rules::TOTAL_WEIGHT;
            $chi += ($stops[$i] - $e) ** 2 / $e;
        }
        $this->assertLessThan(52.0, $chi, 'chi-square, 23 d.o.f.');
        $chi2 = 0.0;
        foreach ($dbl as $c) {
            $chi2 += ($c - $n / 14) ** 2 / ($n / 14);
        }
        $this->assertLessThan(34.0, $chi2, 'chi-square, 13 d.o.f.');
        $this->assertEqualsWithDelta(0.8998, $paid / ($n * 8), 0.02);
    }

    public function test_the_verifier_script(): void
    {
        $v = json_decode(file_get_contents(__DIR__.'/../../docs/fruit/test-vectors.json'), true)[0];
        $out = shell_exec('php '.escapeshellarg(__DIR__.'/../../bin/fruit-verify.php').' --json --server-seed '.$v['serverSeed'].' --client-seed '.$v['clientSeed'].' --nonce '.$v['nonce'].' --commit '.$v['commit']);
        $j = json_decode($out, true);
        $this->assertSame($v['rounds'], $j['rounds']);
        $this->assertTrue($j['commitOk']);
    }
}
