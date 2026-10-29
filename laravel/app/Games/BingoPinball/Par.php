<?php

namespace App\Games\BingoPinball;

/**
 * The PAR sheet: the exact statistics of a paytable, from enumerating all C(25,5) = 53,130 equally likely outcomes through the same Evaluator the game uses
 * (not from a formula, so a bug in the evaluator or the paytable shows up as a wrong number). All figures are exact rationals of the outcome count.
 */
final class Par
{
    public const OUTCOMES = 53130;

    /** @var array<string,array> */
    private static array $memo = [];

    /** the published counts of the best line over all outcomes (the same for every card layout): lit cells => outcomes; 0 = no win (best line of 1 or 2) */
    public const PUBLISHED_COUNTS = [5 => 12, 4 => 1200, 3 => 21144, 0 => 30774];

    /**
     * @return array{
     *   outcomes:int, byLit:array<int,int>, hits:int, returnUnits:int, secondMoment:int,
     *   rtp:float, rtpFraction:string, rtpRounded:string, hitFrequency:float, variance:float, standardDeviation:float, maxMultiple:int,
     *   perLine:array<int,array{lit3:int,lit4:int,lit5:int}>
     * }
     */
    public static function enumerate(Paytable $p): array
    {
        $key = hash('sha256', $p->canonical());
        if (isset(self::$memo[$key])) {                                   // a pure function of the paytable: enumerate each one once per process
            return self::$memo[$key];
        }
        $byLit = [0 => 0, 1 => 0, 2 => 0, 3 => 0, 4 => 0, 5 => 0];
        $perLine = array_fill(0, 12, [3 => 0, 4 => 0, 5 => 0]);
        $n = 0;
        $a = [1, 2, 3, 4, 5];
        for (;;) {                                                            // every 5-subset of 1..25, in order
            $r = Evaluator::evaluate($p->card, $a);
            $byLit[$r['lit']]++;
            if ($r['lit'] >= 3) {
                $perLine[$r['line']][$r['lit']]++;
            }
            $n++;
            $i = 4;
            while ($i >= 0 && $a[$i] === 25 - (4 - $i)) {
                $i--;
            }
            if ($i < 0) {
                break;
            }
            $a[$i]++;
            for ($k = $i + 1; $k < 5; $k++) {
                $a[$k] = $a[$k - 1] + 1;
            }
        }
        $returnUnits = 0;
        $second = 0;
        $hits = 0;
        foreach ($byLit as $lit => $count) {
            $m = $p->multiple($lit);
            $returnUnits += $count * $m;
            $second += $count * $m * $m;
            if ($m > 0) {
                $hits += $count;
            }
        }
        $rtp = $returnUnits / $n;
        $variance = $second / $n - $rtp * $rtp;
        $g = self::gcd($returnUnits, $n);

        return self::$memo[$key] = ['outcomes' => $n, 'byLit' => $byLit, 'hits' => $hits, 'returnUnits' => $returnUnits, 'secondMoment' => $second, 'rtp' => $rtp, 'rtpFraction' => ($returnUnits / $g).'/'.($n / $g),
            'rtpRounded' => number_format($rtp * 100, 2, '.', ''), 'hitFrequency' => $hits / $n, 'variance' => $variance, 'standardDeviation' => sqrt($variance), 'maxMultiple' => $p->maxMultiple(), 'perLine' => $perLine];
    }

    private static function gcd(int $a, int $b): int
    {
        return $b === 0 ? $a : self::gcd($b, $a % $b);
    }

    /** the PAR sheet of one version as text (what the command prints and docs/bingo/PAR_SHEETS.md contains) */
    public static function sheet(Paytable $p): string
    {
        $r = self::enumerate($p);
        $out = "Bingo Pinball - paytable {$p->id} (RTP version {$p->version})\n";
        $out .= 'Pays (stake x, stake included): 3 in line '.$p->pays[3].'x, 4 in line '.$p->pays[4].'x, 5 in line '.$p->pays[5]."x\n";
        $out .= "Outcomes: {$r['outcomes']} (every set of 5 of the 25 holes, equally likely)\n\n";
        $out .= sprintf("%-12s %10s %12s %10s %14s\n", 'Best line', 'Outcomes', 'Probability', 'Pays', 'RTP share');
        foreach ([5, 4, 3] as $lit) {
            $out .= sprintf("%-12s %10d %11.4f%% %9dx %13.4f%%\n", $lit.' in line', $r['byLit'][$lit], $r['byLit'][$lit] / $r['outcomes'] * 100, $p->pays[$lit], $r['byLit'][$lit] * $p->pays[$lit] / $r['outcomes'] * 100);
        }
        $none = $r['byLit'][0] + $r['byLit'][1] + $r['byLit'][2];
        $out .= sprintf("%-12s %10d %11.4f%% %9dx %13.4f%%\n", 'no win', $none, $none / $r['outcomes'] * 100, 0, 0);
        $out .= sprintf("\nRTP: %s%% (exact %s = %.6f%%)   published: %s%%\n", $r['rtpRounded'], $r['rtpFraction'], $r['rtp'] * 100, $p->publishedRtp);
        $out .= sprintf("Hit frequency (any win): %.4f%% (1 in %.2f plays)\n", $r['hitFrequency'] * 100, 1 / $r['hitFrequency']);
        $out .= sprintf("Standard deviation of the return of one play: %.4f x stake (variance %.6f)\n", $r['standardDeviation'], $r['variance']);
        $out .= sprintf("Top prize: %dx stake, %d of %d outcomes (on average once in %.0f plays)\n", $r['maxMultiple'], $r['byLit'][5], $r['outcomes'], $r['outcomes'] / max(1, $r['byLit'][5]));

        return $out;
    }
}
