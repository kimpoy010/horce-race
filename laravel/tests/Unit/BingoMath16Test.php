<?php

namespace Tests\Unit;

use App\Games\BingoPinball16\Draw;
use App\Games\BingoPinball16\Evaluator;
use App\Games\BingoPinball16\Par;
use App\Games\BingoPinball16\Rules;
use PHPUnit\Framework\TestCase;

require_once __DIR__.'/../../bin/bingo16-verify.php';

/** Bingo Pinball 16, the maths package: the rules, the evaluator, the exact PAR figures, the draw and its independent re-implementations. Pure code. */
class BingoMath16Test extends TestCase
{
    /** sha256 of Rules::canonical(): the rules of a certified game are frozen; a change is a new version and a deliberate new line here */
    private const FROZEN = '6a036849baa0b4033beb2d52d034ab4e6672801f5beab64b94d14540313f232b';

    public function test_the_rules_are_frozen(): void
    {
        $this->assertSame(self::FROZEN, hash('sha256', Rules::canonical()), 'the rules of Bingo Pinball 16 changed: a certified game is never edited, add a new version instead');
        $this->assertSame(Rules::TOTAL_WEIGHT, Rules::SLOT_WEIGHT * Rules::SLOTS, 'every ball lands in a slot: no OUT');
        $this->assertCount(10, Rules::LINES);
    }

    /** @return list<list<int>> */
    private static function cases(): array
    {
        return [
            // [balls (slots), expected pattern]
            [[1, 2], null], [[1, 2, 3], null], [[1, 2, 3, 4], 'across'], [[5, 6, 7, 8], 'across'], [[13, 14, 15, 16], 'across'], [[1, 5, 9, 13], 'down'], [[4, 8, 12, 16], 'down'],
            [[1, 6, 11, 16], 'diagonal'], [[4, 7, 10, 13], 'diagonal'], [[1, 4, 13, 16], 'corners'], [[6, 7, 10, 11], 'smallbox'], [[1, 2, 3, 4, 7, 10, 13], 'lucky7'],
            [[1, 5, 9, 13, 14, 15, 16], 'lshape'], [[1, 2, 3, 4, 13, 14, 15, 16], 'equal'], [[1, 5, 9, 13, 4, 8, 12, 16], 'eleven'], [[1, 2, 3, 4, 7, 10, 13, 14, 15, 16], 'zshape'],
            [[1, 2, 3, 4, 5, 8, 9, 12, 13, 14, 15, 16], 'bigbox'], [range(1, 17), 'full'], [[2, 3, 14], null], [[1, 2, 4, 5, 8, 10], null],
            [[1, 2, 3, 4, 5, 6, 7, 8], 'across'],                               // two rows: still ACROSS
            [[1, 2, 3, 4, 5, 9, 13], 'across'],                                 // a row and a column: ACROSS ranks above DOWN
            [[1, 2, 3, 4, 6, 7, 10, 11], 'smallbox'],                           // SMALL BOX ranks above ACROSS
            [[1, 2, 3, 4, 13, 14, 15, 16, 5, 9], 'equal'],                      // EQUAL ranks above the rest
            
        ];
    }

    public function test_the_evaluator_on_hand_made_plays(): void
    {
        foreach (self::cases() as [$balls, $want]) {
            $balls = array_values((array) $balls);
            $e = Evaluator::evaluate($balls, [1, 2, 3, 4, 5]);
            $this->assertSame($want, $e['pattern'], 'balls '.implode(',', $balls));
            $this->assertSame($want === null ? 0 : Rules::PATTERNS[$want][1], $e['halves']);
        }
        $this->assertSame([2, 1, 10], [Rules::PATTERNS['diagonal'][1], Rules::PATTERNS['across'][1], Rules::PATTERNS['eleven'][1]]);
        $this->assertSame(500, Rules::pay('across', 1000), 'half the stake');
        $this->assertSame(1000, Rules::pay('smallbox', 1000), 'the stake');
        $this->assertSame(5000, Rules::pay('eleven', 1000));
        $this->assertSame(2, Rules::pay('across', 5), 'rounded down');
        $this->assertSame([5, 9], Evaluator::evaluate([9, 5, 5, 9], [1, 2, 3, 4, 5])['lit'], 'lit cells, once each, in order');
        $j = Evaluator::evaluate([3, 3, 7, 7, 10, 10, 12, 12, 16, 16], [3, 7, 10, 12, 16]);
        $this->assertSame([5, true], [$j['jackpotLit'], $j['jackpot']], 'each jackpot number holds two balls');
        $j = Evaluator::evaluate([3, 3, 7, 7, 10, 10, 12, 12, 16], [3, 7, 10, 12, 16]);
        $this->assertSame([4, false], [$j['jackpotLit'], $j['jackpot']], 'one ball is not enough');
        $j = Evaluator::evaluate([3, 7, 10, 12, 16], [3, 7, 10, 12, 16]);
        $this->assertSame([0, false], [$j['jackpotLit'], $j['jackpot']]);
    }

    public function test_the_evaluator_agrees_with_the_independent_one_on_every_lit_set(): void
    {
        for ($mask = 0; $mask < 65536; $mask += 7) {                       // every 7th set (9,363 of them); the PAR test below covers all 65,536 through the same evaluator
            $balls = [];
            for ($c = 0; $c < 16; $c++) {
                if ($mask >> $c & 1) {
                    $balls[] = $c + 1;
                }
            }
            $a = Evaluator::evaluate($balls, [1, 5, 9, 13, 16]);
            $b = b16_evaluate($balls, [1, 5, 9, 13, 16]);
            $this->assertSame([$a['pattern'], $a['halves'], $a['jackpotLit'], $a['lit'], $a['cells']], [$b['pattern'], $b['halves'], $b['jackpotLit'], $b['lit'], $b['cells']], "mask $mask");
        }
    }

    public function test_the_exact_par_figures_agree_with_the_ones_computed_with_big_integers(): void
    {
        $exact = json_decode(file_get_contents(__DIR__.'/../../docs/bingo16/par.json'), true);
        $par = Par::enumerate();
        $this->assertEqualsWithDelta($exact['rtp'], $par['rtp'], 1e-10);
        $this->assertEqualsWithDelta($exact['hit'], $par['hit'], 1e-10);
        $this->assertEqualsWithDelta($exact['standardDeviation'], $par['standardDeviation'], 1e-7);
        $this->assertEqualsWithDelta($exact['jackpot'], $par['jackpot'], 1e-11);
        $this->assertEqualsWithDelta($exact['expectedLit'], $par['expectedLit'], 1e-10);
        foreach ($par['patterns'] as $k => $p) {
            $this->assertEqualsWithDelta($exact['patterns'][$k]['probability'], $p, 1e-11, $k);
            $this->assertEqualsWithDelta(Rules::PATTERNS[$k][1] / 2, $exact['patterns'][$k]['pays'], 1e-12);
        }
        $this->assertEqualsWithDelta(0.8795, $par['rtp'], 0.00005, 'the published pattern RTP');
    }

    public function test_the_draw_gives_the_known_answers_of_the_independent_python_implementation(): void
    {
        $vectors = json_decode(file_get_contents(__DIR__.'/../../docs/bingo16/test-vectors.json'), true);
        $this->assertGreaterThanOrEqual(30, count($vectors));
        $seen = [];
        foreach ($vectors as $v) {
            $d = Draw::play($v['serverSeed'], $v['clientSeed'], $v['nonce']);
            $this->assertSame($v['balls'], $d['balls']);
            $this->assertSame($v['jackpotNumbers'], $d['jackpotNumbers']);
            $e = Evaluator::evaluate($d['balls'], $d['jackpotNumbers']);
            $this->assertSame([$v['lit'], $v['pattern'], $v['halves'], $v['cells'], $v['jackpotLit'], $v['jackpot']], [$e['lit'], $e['pattern'], $e['halves'], $e['cells'], $e['jackpotLit'], $e['jackpot']]);
            $this->assertSame($v['commit'], Draw::commitOf($v['serverSeed']));
            [$vb, $vj] = b16_draw($v['serverSeed'], $v['clientSeed'], $v['nonce']);             // the standalone PHP verifier
            $this->assertSame([$v['balls'], $v['jackpotNumbers']], [$vb, $vj]);
            $seen[$v['jackpot'] ? 'jackpot' : ($v['pattern'] ?? 'none')] = true;
        }
        foreach (['none', 'across', 'down', 'diagonal', 'corners', 'smallbox', 'lshape', 'lucky7', 'equal', 'eleven', 'zshape', 'bigbox', 'jackpot'] as $k) {
            $this->assertArrayHasKey($k, $seen, "the vectors include a play with $k");
        }
    }

    public function test_the_draw_depends_on_all_three_inputs_and_refuses_bad_input(): void
    {
        $seed = hash('sha256', 'x');
        $a = Draw::play($seed, 'c', 1);
        $this->assertSame($a, Draw::play($seed, 'c', 1));
        $this->assertCount(16, $a['balls']);
        $this->assertCount(5, array_unique($a['jackpotNumbers']));
        $this->assertNotSame($a, Draw::play(hash('sha256', 'y'), 'c', 1));
        $this->assertNotSame($a, Draw::play($seed, 'd', 1));
        $this->assertNotSame($a, Draw::play($seed, 'c', 2));
        foreach ([['zz', 'c', 1], [$seed, 'bad seed!', 1], [$seed, '', 1], [$seed, 'c', 0]] as $bad) {
            try {
                Draw::play(...$bad);
                $this->fail('accepted bad input');
            } catch (\InvalidArgumentException) {
                $this->addToAssertionCount(1);
            }
        }
    }

    public function test_every_outcome_of_a_ball_and_every_jackpot_number_is_equally_likely(): void
    {
        $draws = (int) (getenv('BINGO_STAT_DRAWS') ?: 6000);                // 96,000 balls and 6,000 sets of jackpot numbers
        $ball = array_fill(1, 16, 0);
        $jp = array_fill(1, 16, 0);
        $seed = hash('sha256', 'uniformity16');
        for ($n = 1; $n <= $draws; $n++) {
            $d = Draw::play($seed, 'stat', $n);
            foreach ($d['balls'] as $b) {
                $ball[$b]++;
            }
            foreach ($d['jackpotNumbers'] as $x) {
                $jp[$x]++;
            }
        }
        $total = $draws * 16;
        $p = array_fill(1, 16, 625 / 10000);
        $chi = 0.0;
        foreach ($p as $k => $pk) {
            $chi += ($ball[$k] - $total * $pk) ** 2 / ($total * $pk);
        }
        $this->assertLessThan(15 + 4.5 * sqrt(2 * 15), $chi, 'balls follow the slot weights (chi-square, 15 degrees of freedom)');
        $chi = 0.0;
        foreach ($jp as $c) {
            $chi += ($c - $draws * 5 / 16) ** 2 / ($draws * 5 / 16);
        }
        $this->assertLessThan(15 + 4.5 * sqrt(2 * 15), $chi, 'every number is equally likely to be a jackpot number');
    }

    public function test_the_observed_return_of_many_plays_is_close_to_the_exact_one(): void
    {
        $plays = (int) (getenv('BINGO_STAT_DRAWS') ?: 6000) * 5;
        $seed = hash('sha256', 'rtp16');
        $paid = 0;
        for ($n = 1; $n <= $plays; $n++) {
            $d = Draw::play($seed, 'rtp', $n);
            $paid += Evaluator::evaluate($d['balls'], $d['jackpotNumbers'])['halves'] / 2;
        }
        $sd = 6.3818 / sqrt($plays);
        $this->assertEqualsWithDelta(0.879479, $paid / $plays, 5 * $sd, 'observed pattern return of '.$plays.' plays within 5 standard errors');
    }
}
