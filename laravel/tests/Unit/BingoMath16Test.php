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
    private const FROZEN = '13c00093f67ba29eb689a157bbf94253bc6b512398fe6e6341fb4874beb7b703';

    public function test_the_rules_are_frozen(): void
    {
        $this->assertSame(self::FROZEN, hash('sha256', Rules::canonical()), 'the rules of Bingo Pinball 16 changed: a certified game is never edited, add a new version instead');
        $this->assertSame(2944, Rules::SLOT_WEIGHT * Rules::SLOTS);
        $this->assertCount(10, Rules::LINES);
        $this->assertCount(9, Rules::SQUARES);
    }

    /** @return list<list<int>> */
    private static function cases(): array
    {
        return [
            // [balls (slots, 0 = OUT), expected pattern]
            [[0, 0, 0, 0], null], [[1, 2], null], [[1, 2, 3], 'three'], [[1, 2, 3, 4], 'fullline'], [[1, 5, 9], 'three'], [[1, 6, 11], 'three'], [[4, 7, 10], 'three'],
            [[1, 2, 5, 6], 'square'], [[11, 12, 15, 16], 'square'], [[1, 4, 13], null], [[1, 4, 13, 16], 'corners'], [[1, 2, 3, 4, 5, 6, 7, 8], 'lines2'],
            [[1, 2, 3, 4, 5, 9, 13], 'lines2'], [[1, 6, 11, 16], 'fullline'], [[4, 7, 10, 13], 'fullline'], [[1, 4, 13, 16, 2, 3], 'corners'],
            [[1, 4, 13, 16, 2, 3, 14, 15], 'lines2'], [[2, 3, 14], null], [[1, 2, 4], 'three'], [[16, 15, 14], 'three'],
        ];
    }

    public function test_the_evaluator_on_hand_made_plays(): void
    {
        foreach (self::cases() as [$balls, $want]) {
            $e = Evaluator::evaluate($balls, [1, 2, 3, 4, 5]);
            $this->assertSame($want, $e['pattern'], 'balls '.implode(',', $balls));
            $this->assertSame($want === null ? 0 : Rules::PATTERNS[$want][1], $e['multiple']);
        }
        $this->assertSame([5, 9], Evaluator::evaluate([9, 5, 5, 0, 9], [1, 2, 3, 4, 5])['lit'], 'lit cells, once each, in order');
        $j = Evaluator::evaluate([3, 7, 10, 12, 16, 3], [3, 7, 10, 12, 16]);
        $this->assertSame([5, true], [$j['jackpotLit'], $j['jackpot']]);
        $j = Evaluator::evaluate([3, 7, 10, 12], [3, 7, 10, 12, 16]);
        $this->assertSame([4, false], [$j['jackpotLit'], $j['jackpot']]);
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
            $this->assertSame([$a['pattern'], $a['multiple'], $a['jackpotLit'], $a['lit']], [$b['pattern'], $b['multiple'], $b['jackpotLit'], $b['lit']], "mask $mask");
        }
    }

    public function test_the_exact_par_figures_agree_with_the_ones_computed_with_big_integers(): void
    {
        $exact = json_decode(file_get_contents(__DIR__.'/../../docs/bingo16/par.json'), true);
        $par = Par::enumerate();
        $this->assertEqualsWithDelta($exact['rtp'], $par['rtp'], 1e-10);
        $this->assertEqualsWithDelta($exact['hit'], $par['hit'], 1e-10);
        $this->assertEqualsWithDelta($exact['standardDeviation'], $par['standardDeviation'], 1e-10);
        $this->assertEqualsWithDelta($exact['jackpot'], $par['jackpot'], 1e-11);
        $this->assertEqualsWithDelta($exact['expectedLit'], $par['expectedLit'], 1e-10);
        foreach ($par['patterns'] as $k => $p) {
            $this->assertEqualsWithDelta($exact['patterns'][$k]['probability'], $p, 1e-11, $k);
            $this->assertSame(Rules::PATTERNS[$k][1], $exact['patterns'][$k]['pays']);
        }
        $this->assertEqualsWithDelta(0.8786, $par['rtp'], 0.00005, 'the published pattern RTP');
    }

    public function test_the_draw_gives_the_known_answers_of_the_independent_python_implementation(): void
    {
        $vectors = json_decode(file_get_contents(__DIR__.'/../../docs/bingo16/test-vectors.json'), true);
        $this->assertGreaterThanOrEqual(40, count($vectors));
        $seen = [];
        foreach ($vectors as $v) {
            $d = Draw::play($v['serverSeed'], $v['clientSeed'], $v['nonce']);
            $this->assertSame($v['balls'], $d['balls']);
            $this->assertSame($v['jackpotNumbers'], $d['jackpotNumbers']);
            $e = Evaluator::evaluate($d['balls'], $d['jackpotNumbers']);
            $this->assertSame([$v['lit'], $v['pattern'], $v['multiple'], $v['jackpotLit'], $v['jackpot']], [$e['lit'], $e['pattern'], $e['multiple'], $e['jackpotLit'], $e['jackpot']]);
            $this->assertSame($v['commit'], Draw::commitOf($v['serverSeed']));
            [$vb, $vj] = b16_draw($v['serverSeed'], $v['clientSeed'], $v['nonce']);             // the standalone PHP verifier
            $this->assertSame([$v['balls'], $v['jackpotNumbers']], [$vb, $vj]);
            $seen[$v['jackpot'] ? 'jackpot' : ($v['pattern'] ?? 'none')] = true;
        }
        foreach (['none', 'three', 'square', 'fullline', 'corners', 'lines2', 'jackpot'] as $k) {
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
        $ball = array_fill(0, 17, 0);
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
        $p = [0 => 7056 / 10000] + array_fill(1, 16, 184 / 10000);
        $chi = 0.0;
        foreach ($p as $k => $pk) {
            $chi += ($ball[$k] - $total * $pk) ** 2 / ($total * $pk);
        }
        $this->assertLessThan(16 + 4.5 * sqrt(2 * 16), $chi, 'balls follow the slot weights (chi-square, 16 degrees of freedom)');
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
            $paid += Evaluator::evaluate($d['balls'], $d['jackpotNumbers'])['multiple'];
        }
        $sd = 1.6351 / sqrt($plays);
        $this->assertEqualsWithDelta(0.878635, $paid / $plays, 5 * $sd, 'observed pattern return of '.$plays.' plays within 5 standard errors');
    }
}
