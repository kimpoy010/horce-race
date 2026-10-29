<?php

namespace Tests\Unit;

use App\Games\BingoPinball\Card;
use App\Games\BingoPinball\Draw;
use App\Games\BingoPinball\Evaluator;
use App\Games\BingoPinball\Par;
use App\Games\BingoPinball\Paytable;
use App\Games\BingoPinball\Paytables;
use Illuminate\Support\Facades\Artisan;
use PHPUnit\Framework\TestCase;

require_once __DIR__.'/../../bin/bingo-verify.php';

/**
 * Bingo Pinball, the maths package (Phase 2): the card and line evaluator, the frozen paytables, the exact PAR figures, the draw and its independent
 * re-implementations. Pure code: no database, no routes.
 */
class BingoMathTest extends TestCase
{
    /** sha256 of Paytable::canonical() of every version. A paytable in use is never edited: a change is a new file and a new line here, made on purpose. */
    private const FROZEN = [
        88 => '50994078e29d364f95309246506e75834e7160ee522bbe900bb54493a662c20f',
        90 => '0a6085a93d0bd0abdae8b6f604aeee55d377ed93fb1876e835937cc88fd8a082',
        92 => 'e8fdf8c92d57e99536b2d5662e19328a3494787ea0daa95fa8533af1304a62da',
        94 => '9576c818d3cfd3565ee57dadf1c00c1bfe3c1fa11c59bb9f210368334fd755b0',
        96 => '7d227a30c0ca5ac862fb7ab9892cf9e1b4042e68f989a1f610850fde569f2321',
    ];

    /** the exact RTP of every version as a reduced fraction of the 53,130 outcomes, and the figure printed on the rules sheet */
    private const RTP = [88 => ['1114/1265', '88.06'], 90 => ['7968/8855', '89.98'], 92 => ['1164/1265', '92.02'], 94 => ['8348/8855', '94.27'], 96 => ['8548/8855', '96.53']];

    private static array $par = [];

    private static function par(int $v): array
    {
        return self::$par[$v] ??= Par::enumerate(Paytables::get($v));
    }

    private function vectors(): array
    {
        return json_decode((string) file_get_contents(__DIR__.'/../../docs/bingo/test-vectors.json'), true)['vectors'];
    }

    /** a plain re-count of the best line, deliberately written differently from Evaluator (no lookup tables shared with it) */
    private static function bruteBest(array $card, array $holes): int
    {
        $grid = [];
        foreach ($card as $i => $hole) {
            $grid[intdiv($i, 5)][$i % 5] = in_array($hole, $holes, true) ? 1 : 0;
        }
        $best = 0;
        for ($k = 0; $k < 5; $k++) {
            $best = max($best, array_sum($grid[$k]), array_sum(array_column($grid, $k)));
        }
        $best = max($best, $grid[0][0] + $grid[1][1] + $grid[2][2] + $grid[3][3] + $grid[4][4], $grid[0][4] + $grid[1][3] + $grid[2][2] + $grid[3][1] + $grid[4][0]);

        return $best;
    }

    /* ---------- the paytables ---------- */

    public function test_paytables_are_frozen_and_their_cards_follow_the_documented_recipe(): void
    {
        $this->assertSame(array_keys(self::FROZEN), Paytables::VERSIONS);
        foreach (Paytables::all() as $v => $p) {
            $this->assertSame(self::FROZEN[$v], hash('sha256', $p->canonical()), "paytable $v was changed: a paytable in use is frozen; add a new version file instead");
            $this->assertSame($p->card, Card::generate($v), "the card of version $v is what Card::generate() makes");
            $this->assertSame("bp-v$v-1", $p->id);
            $this->assertSame($v, $p->version);
        }
        $this->assertCount(5, array_unique(array_map(fn ($p) => json_encode($p->card), Paytables::all())), 'every version has its own layout');
    }

    public function test_a_paytable_must_make_sense(): void
    {
        $card = range(1, 25);
        $this->expectException(\InvalidArgumentException::class);
        new Paytable('x', 1, [3 => 5, 4 => 3, 5 => 10], '0', $card);          // 4 in line must not pay less than 3
    }

    public function test_an_unknown_version_and_a_bad_card_are_refused(): void
    {
        foreach ([fn () => Paytables::get(89), fn () => Card::check(array_merge(range(1, 24), [24])), fn () => Card::check(range(1, 24))] as $f) {
            try {
                $f();
                $this->fail('refused');
            } catch (\InvalidArgumentException $e) {
                $this->assertTrue(true);
            }
        }
    }

    /* ---------- the evaluator ---------- */

    public function test_the_evaluator_on_hand_made_cards(): void
    {
        $id = range(1, 25);                                       // hole n sits in cell n-1: rows are 1-5, 6-10 ...
        $cases = [
            'a full row' => [[1, 2, 3, 4, 5], 5, 0],
            'a full column' => [[1, 6, 11, 16, 21], 5, 5],
            'the last column' => [[5, 10, 15, 20, 25], 5, 9],
            'the diagonal' => [[1, 7, 13, 19, 25], 5, 10],
            'the other diagonal' => [[5, 9, 13, 17, 21], 5, 11],
            '4 in a row and one elsewhere' => [[6, 7, 8, 9, 25], 4, 1],
            '4 in a column' => [[2, 7, 12, 17, 25], 4, 6],
            '3 in a row, two stray' => [[11, 12, 13, 3, 25], 3, 2],
            'two lines of 3 tie: the lowest line index is shown' => [[1, 2, 3, 6, 11], 3, 0],
            '3 on the diagonal' => [[1, 7, 13, 5, 10], 3, 10],
            'nothing better than 2 (two in row 1)' => [[1, 8, 15, 22, 4], 2, 0],
            '3 in the last column, found although the holes come in any order' => [[25, 1, 15, 8, 5], 3, 9],
        ];
        foreach ($cases as $name => [$holes, $lit, $line]) {
            $r = Evaluator::evaluate($id, $holes);
            $this->assertSame([$lit, $line], [$r['lit'], $r['line']], $name);
            $this->assertSame($lit, self::bruteBest($id, $holes), "$name (re-count)");
        }
        $r = Evaluator::evaluate($id, [1, 2, 3, 6, 11]);
        $this->assertSame([0, 1, 2, 5, 10], $r['litCells']);
        $this->assertSame([0, 1, 2], $r['lineCells']);
    }

    public function test_a_scrambled_card_lights_the_cell_that_shows_the_hole(): void
    {
        $card = Paytables::get(96)->card;                         // [4, 8, 21, 19, 20, ...]: holes 4, 8, 21, 19, 20 are the first row
        $r = Evaluator::evaluate($card, [4, 8, 21, 19, 20]);
        $this->assertSame([5, 0, [0, 1, 2, 3, 4]], [$r['lit'], $r['line'], $r['litCells']]);
    }

    public function test_the_evaluator_agrees_with_a_plain_recount_on_a_sample_of_all_outcomes(): void
    {
        $card = Paytables::get(90)->card;
        $seed = hash('sha256', 'recount');
        for ($n = 1; $n <= 5000; $n++) {
            $h = Draw::holes($seed, 'recount', $n);
            $this->assertSame(self::bruteBest($card, $h), Evaluator::evaluate($card, $h)['lit']);
        }
    }

    public function test_the_evaluator_refuses_bad_input(): void
    {
        foreach ([[1, 2, 3, 4], [1, 2, 3, 4, 4], [1, 2, 3, 4, 26]] as $bad) {
            try {
                Evaluator::evaluate(range(1, 25), $bad);
                $this->fail('refused');
            } catch (\InvalidArgumentException $e) {
                $this->assertTrue(true);
            }
        }
    }

    /* ---------- the PAR sheet: exact enumeration ---------- */

    public function test_the_enumeration_reproduces_the_published_counts_and_rtp_for_every_version(): void
    {
        foreach (Paytables::all() as $v => $p) {
            $r = self::par($v);
            $this->assertSame(53130, $r['outcomes']);
            $this->assertSame(array_sum($r['byLit']), $r['outcomes']);
            $this->assertSame([5 => 12, 4 => 1200, 3 => 21144, 0 => 30774], [5 => $r['byLit'][5], 4 => $r['byLit'][4], 3 => $r['byLit'][3], 0 => $r['byLit'][0] + $r['byLit'][1] + $r['byLit'][2]], "counts of version $v");
            [$fraction, $rounded] = self::RTP[$v];
            $this->assertSame($fraction, $r['rtpFraction'], "exact RTP of version $v");
            $this->assertSame($rounded, $r['rtpRounded']);
            $this->assertSame($rounded, $p->publishedRtp);
            // the same number from the closed formula of the plan: RTP = sum(n_k / 53130 x pay_k)
            $this->assertEqualsWithDelta((12 * $p->pays[5] + 1200 * $p->pays[4] + 21144 * $p->pays[3]) / 53130, $r['rtp'], 1e-12);
            $this->assertEqualsWithDelta(0.4207793, $r['hitFrequency'], 1e-7, 'hit frequency (3 or more in a line) is the same for every version');
            $this->assertSame(array_sum(array_map(fn ($l) => $l[5], $r['perLine'])), 12, 'each of the 12 lines has exactly one winning set of 5');
        }
    }

    public function test_every_card_layout_gives_the_same_probabilities(): void
    {
        $first = null;
        foreach (Paytables::VERSIONS as $v) {
            $r = self::par($v);
            $first ??= $r['byLit'];
            $this->assertSame($first, $r['byLit'], 'the layout is cosmetic: it does not change any probability');
        }
    }

    public function test_the_published_variance_matches_a_direct_calculation(): void
    {
        $p = Paytables::get(94);
        $r = self::par(94);
        $e = (12 * 150 + 1200 * 5 + 21144 * 2) / 53130;
        $e2 = (12 * 150 ** 2 + 1200 * 5 ** 2 + 21144 * 2 ** 2) / 53130;
        $this->assertEqualsWithDelta(sqrt($e2 - $e * $e), $r['standardDeviation'], 1e-12);
    }

    /* ---------- the draw ---------- */

    public function test_the_draw_gives_five_distinct_holes_and_depends_only_on_its_inputs(): void
    {
        $seed = hash('sha256', 'distinct');
        for ($n = 1; $n <= 20000; $n++) {
            $h = Draw::holes($seed, 'c', $n);
            $this->assertCount(5, array_unique($h));
            $this->assertGreaterThanOrEqual(1, min($h));
            $this->assertLessThanOrEqual(25, max($h));
        }
        $a = Draw::holes($seed, 'c', 7);
        $this->assertSame($a, Draw::holes($seed, 'c', 7));
        $this->assertNotSame($a, Draw::holes($seed, 'c', 8), 'another nonce, another result');
        $this->assertNotSame($a, Draw::holes($seed, 'd', 7), 'another client seed, another result');
        $this->assertNotSame($a, Draw::holes(hash('sha256', 'other'), 'c', 7), 'another server seed, another result');
        $this->assertSame(hash('sha256', $seed), Draw::commitOf($seed));
    }

    public function test_the_draw_refuses_bad_seeds_and_nonces(): void
    {
        $seed = hash('sha256', 'x');
        foreach ([[$seed, '', 1], [$seed, 'a:b', 1], [$seed, 'a b', 1], [$seed, str_repeat('a', 65), 1], [$seed, 'ok', 0], ['xyz', 'ok', 1], [strtoupper($seed), 'ok', 1]] as [$s, $c, $n]) {
            try {
                Draw::holes($s, $c, $n);
                $this->fail('refused');
            } catch (\InvalidArgumentException $e) {
                $this->assertTrue(true);
            }
        }
    }

    public function test_known_answer_vectors_made_by_the_independent_python_implementation(): void
    {
        $vectors = $this->vectors();
        $this->assertGreaterThanOrEqual(30, count($vectors));
        $seenLit = [];
        $perVersion = [];
        foreach ($vectors as $v) {
            $this->assertSame($v['holes'], Draw::holes($v['serverSeed'], $v['clientSeed'], $v['nonce']), 'the PHP draw equals the Python draw');
            $this->assertSame($v['commit'], Draw::commitOf($v['serverSeed']));
            foreach ($v['versions'] as $version => $exp) {
                $p = Paytables::get((int) $version);
                $e = Evaluator::evaluate($p->card, $v['holes']);
                $this->assertSame($exp['bestLit'], $e['lit'], "version $version");
                $this->assertSame($exp['bestLineIndex'], $e['line'], "version $version");
                $this->assertSame($exp['payout'], $p->payout(1000, $e['lit']), "version $version");
                $seenLit[$e['lit']] = true;
                $perVersion[$version][$e['lit']] = true;
            }
        }
        foreach (Paytables::VERSIONS as $version) {
            foreach ([3, 4, 5] as $lit) {
                $this->assertArrayHasKey($lit, $perVersion[$version], "the vectors contain a best line of $lit for version $version");
            }
        }
        foreach ([2, 3, 4, 5] as $lit) {
            $this->assertArrayHasKey($lit, $seenLit, "the vectors contain a best line of $lit");
        }
    }

    public function test_the_standalone_script_gives_the_same_answers_as_the_game_code(): void
    {
        $seed = hash('sha256', 'standalone');
        for ($n = 1; $n <= 3000; $n++) {
            $this->assertSame(Draw::holes($seed, 'sa', $n), \bp_holes($seed, 'sa', $n));
        }
        foreach (Paytables::all() as $v => $p) {
            $this->assertSame($p->id, BP_PAYTABLES[$v]['id']);
            $this->assertSame($p->pays, BP_PAYTABLES[$v]['pays'], "the pays embedded in bin/bingo-verify.php are those of version $v");
            $this->assertSame($p->card, BP_PAYTABLES[$v]['card'], "the card embedded in bin/bingo-verify.php is that of version $v");
            for ($n = 1; $n <= 300; $n++) {
                $h = Draw::holes($seed, 'sa', $n);
                $e = Evaluator::evaluate($p->card, $h);
                $r = \bp_verify($seed, 'sa', $n, $v, 1000);
                $this->assertSame([$e['lit'], $p->payout(1000, $e['lit']), $h], [$r['bestLit'], $r['payout'], $r['holes']]);
            }
        }
    }

    public function test_the_standalone_script_from_the_command_line(): void
    {
        $seed = hash('sha256', 'cli');
        $script = escapeshellarg(PHP_BINARY).' '.escapeshellarg(__DIR__.'/../../bin/bingo-verify.php');
        $out = shell_exec("$script --server-seed $seed --client-seed demo --nonce 5 --version 96 --stake 1000 --commit ".hash('sha256', $seed).' --json 2>&1');
        $j = json_decode((string) $out, true);
        $this->assertSame(Draw::holes($seed, 'demo', 5), $j['holes']);
        $this->assertTrue($j['commitMatches']);
        exec("$script --server-seed $seed --client-seed demo --nonce 5 --commit ".str_repeat('0', 64).' >/dev/null 2>&1', $o, $code);
        $this->assertSame(1, $code, 'a commit that does not match is reported');
        exec("$script --server-seed nothex --client-seed demo --nonce 5 >/dev/null 2>&1", $o, $code);
        $this->assertSame(2, $code, 'bad input is refused');
    }

    public function test_the_python_reference_agrees_when_python_is_available(): void
    {
        $py = trim((string) shell_exec('command -v python3'));
        if ($py === '') {
            $this->markTestSkipped('python3 is not installed');
        }
        $script = escapeshellarg(__DIR__.'/../../docs/bingo/verify_play.py');
        foreach (array_slice($this->vectors(), 0, 8) as $v) {
            $out = shell_exec("$py -I $script --server-seed {$v['serverSeed']} --client-seed {$v['clientSeed']} --nonce {$v['nonce']} --version 96 --json 2>&1");
            $this->assertSame($v['holes'], json_decode((string) $out, true)['holes']);
        }
    }

    /* ---------- fairness of the draw (statistics) ---------- */

    /** z-score of a chi-square value (Wilson-Hilferty): about 0 when the data are uniform; beyond +-4.5 is a probability below 1 in 100,000 */
    private static function chiSquareZ(float $chi, int $df): float
    {
        return (pow($chi / $df, 1 / 3) - (1 - 2 / (9 * $df))) / sqrt(2 / (9 * $df));
    }

    public function test_holes_are_uniform_over_many_draws(): void
    {
        $draws = (int) (getenv('BINGO_STAT_DRAWS') ?: 1000000);                 // BINGO_STAT_DRAWS=10000000 for the testing lab
        $seed = hash('sha256', 'uniformity test seed');
        $hole = array_fill(1, 25, 0);
        $ball = array_fill(0, 5, array_fill(1, 25, 0));
        $combo = [];
        $binom = [[1]];
        for ($i = 1; $i <= 25; $i++) {
            $binom[$i][0] = 1;
            for ($j = 1; $j <= $i; $j++) {
                $binom[$i][$j] = ($binom[$i - 1][$j - 1] ?? 0) + ($binom[$i - 1][$j] ?? 0);
            }
        }
        $comboCount = array_fill(0, 53130, 0);
        for ($n = 1; $n <= $draws; $n++) {
            $h = Draw::holes($seed, 'stat', $n);
            foreach ($h as $k => $x) {
                $hole[$x]++;
                $ball[$k][$x]++;
            }
            sort($h);                                                            // the rank of the set among all C(25,5) sets
            $rank = 0;
            foreach ($h as $k => $x) {
                $rank += $binom[$x - 1][$k + 1] ?? 0;
            }
            $comboCount[$rank]++;
        }
        $chi = fn (array $counts, float $expected) => array_sum(array_map(fn ($c) => ($c - $expected) ** 2 / $expected, $counts));
        $z = self::chiSquareZ($chi($hole, $draws * 5 / 25), 24);
        $this->assertLessThan(4.5, abs($z), "every hole is equally likely overall (z = $z)");
        for ($k = 0; $k < 5; $k++) {
            $zk = self::chiSquareZ($chi($ball[$k], $draws / 25), 24);
            $this->assertLessThan(4.5, abs($zk), "ball ".($k + 1)." lands in every hole equally often (z = $zk)");
        }
        $this->assertSame($draws, array_sum($comboCount));
        $zc = self::chiSquareZ($chi($comboCount, $draws / 53130), 53129);
        $this->assertLessThan(4.5, abs($zc), "all 53,130 sets of holes are equally likely (z = $zc, expected ".round($draws / 53130, 1).' each)');
    }

    public function test_the_observed_rtp_over_many_plays_is_close_to_the_exact_one(): void
    {
        $p = Paytables::get(94);
        $seed = hash('sha256', 'rtp convergence');
        $n = 200000;
        $paid = 0;
        for ($i = 1; $i <= $n; $i++) {
            $paid += $p->multiple(Evaluator::evaluate($p->card, Draw::holes($seed, 'rtp', $i))['lit']);
        }
        $exact = self::par(94);
        $se = $exact['standardDeviation'] / sqrt($n);
        $this->assertLessThan(5 * $se, abs($paid / $n - $exact['rtp']), 'the observed RTP is within 5 standard errors of the exact RTP');
    }
}
