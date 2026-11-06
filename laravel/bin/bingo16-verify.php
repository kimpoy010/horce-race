#!/usr/bin/env php
<?php
/*
 * Bingo Pinball 16 - verify one play, on your own. Needs nothing but PHP 8 (no framework, no database, no network).
 *
 *   php bingo16-verify.php --server-seed <64 hex> --client-seed <text> --nonce <n> [--stake 1000] [--commit <64 hex>] [--json]
 *
 * It re-draws the 16 balls and the five jackpot numbers from (server seed, client seed, nonce), lights the card, finds the best pattern and prints what the play pays
 * (not counting the jackpot pool, whose amount is the pool at that moment). With --commit it also checks that the server seed is the one that was shown before you played.
 * Exit code: 0 = all good, 1 = the commit does not match, 2 = bad input. The draw (the same text is in docs/bingo16/MATH.md):
 *   key    = the 32 bytes of the server seed
 *   stream = HMAC-SHA256(key, "bingo-pinball-16:" clientSeed ":" nonce ":" counter), counter = 0, 1, 2 ...; read 4 bytes (big endian) at a time
 *   int(n) = uniform in [0, n): take 32-bit values v, throw away v >= 2^32 - (2^32 mod n), the answer is v mod n
 *   each of 16 balls: r = int(10000); r < 1600: MISSED (0, it fell into a basket), otherwise slot = floor((r - 1600) / 525) + 1
 *   jackpot numbers: a = [1..16]; for i = 0..4: j = i + int(16 - i); swap a[i], a[j]; the numbers are a[0] .. a[4]
 *   baskets: b = [1..10]; for i = 0..2: j = i + int(10 - i); swap b[i], b[j]; the baskets are on the places b[0] .. b[2]
 * Slot k lights cell k of the 4 x 4 card (numbered 1-16 row by row). The best complete pattern pays (stake included, in half stakes: 1 = 0.5x, 2 = 1x): FULL CARD 10000, BIG BOX 1000,
 * Z SHAPE 160, EQUAL 20, NUMBER ELEVEN 20, LUCKY SEVEN 8, L SHAPE 8, 4 CORNERS 4, SMALL BOX 4, DIAGONAL 2, ACROSS 1, DOWN 1 (the shapes: docs/bingo16/MATH.md); the payout is floor(stake x halves / 2).
 * The jackpot pool is won when each of the 5 jackpot numbers holds at least 2 balls. */

const B16_ROWS = [[0, 1, 2, 3], [4, 5, 6, 7], [8, 9, 10, 11], [12, 13, 14, 15]];
const B16_COLS = [[0, 4, 8, 12], [1, 5, 9, 13], [2, 6, 10, 14], [3, 7, 11, 15]];
const B16_LINES = [[0, 1, 2, 3], [4, 5, 6, 7], [8, 9, 10, 11], [12, 13, 14, 15], [0, 4, 8, 12], [1, 5, 9, 13], [2, 6, 10, 14], [3, 7, 11, 15], [0, 5, 10, 15], [3, 6, 9, 12]];
/** best first: key => [half stakes, the ways to make it] */
const B16_PATTERNS = [
    'full' => [10000, [[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]]],
    'bigbox' => [1000, [[0, 1, 2, 3, 4, 7, 8, 11, 12, 13, 14, 15]]],
    'zshape' => [160, [[0, 1, 2, 3, 6, 9, 12, 13, 14, 15]]],
    'equal' => [20, [[0, 1, 2, 3, 12, 13, 14, 15]]],
    'eleven' => [20, [[0, 4, 8, 12, 3, 7, 11, 15]]],
    'lucky7' => [8, [[0, 1, 2, 3, 6, 9, 12]]],
    'lshape' => [8, [[0, 4, 8, 12, 13, 14, 15]]],
    'corners' => [4, [[0, 3, 12, 15]]],
    'smallbox' => [4, [[5, 6, 9, 10]]],
    'diagonal' => [2, [[0, 5, 10, 15], [3, 6, 9, 12]]],
    'across' => [1, B16_ROWS],
    'down' => [1, B16_COLS],
];

function b16_stream(string $key, string $label): Generator
{
    for ($ctr = 0;; $ctr++) {
        $block = hash_hmac('sha256', $label.':'.$ctr, $key, true);
        for ($i = 0; $i < 32; $i += 4) {
            yield unpack('N', substr($block, $i, 4))[1];
        }
    }
}

function b16_draw(string $serverSeedHex, string $clientSeed, int $nonce): array
{
    $ints = b16_stream(hex2bin($serverSeedHex), 'bingo-pinball-16:'.$clientSeed.':'.$nonce);
    $below = function (int $n) use ($ints) {
        $limit = 4294967296 - (4294967296 % $n);
        do {
            $v = $ints->current();
            $ints->next();
        } while ($v >= $limit);

        return $v % $n;
    };
    $balls = [];
    for ($i = 0; $i < 16; $i++) {
        $r = $below(10000);
        $balls[] = $r < 1600 ? 0 : intdiv($r - 1600, 525) + 1;
    }
    $a = range(1, 16);
    for ($i = 0; $i < 5; $i++) {
        $j = $i + $below(16 - $i);
        [$a[$i], $a[$j]] = [$a[$j], $a[$i]];
    }

    $b = range(1, 10);
    for ($i = 0; $i < 3; $i++) {
        $j = $i + $below(10 - $i);
        [$b[$i], $b[$j]] = [$b[$j], $b[$i]];
    }

    return [$balls, array_slice($a, 0, 5), array_slice($b, 0, 3)];
}

function b16_evaluate(array $balls, array $jp): array
{
    $lit = [];
    foreach ($balls as $b) {
        if ($b > 0) {
            $lit[$b - 1] = true;
        }
    }
    $all = fn (array $cells) => count(array_filter($cells, fn ($c) => isset($lit[$c]))) === count($cells);
    $key = null;
    $made = [];
    foreach (B16_PATTERNS as $k => [, $ways]) {
        foreach ($ways as $w) {
            if ($all($w)) {
                $key = $k;
                $made = $w;
                break 2;
            }
        }
    }
    $counts = array_count_values($balls);
    $n = count(array_filter($jp, fn ($x) => ($counts[$x] ?? 0) >= 2));
    $cells = array_map(fn ($c) => $c + 1, array_keys($lit));
    sort($cells);
    $made = array_map(fn ($c) => $c + 1, $made);
    sort($made);

    return ['lit' => $cells, 'pattern' => $key, 'halves' => $key ? B16_PATTERNS[$key][0] : 0, 'cells' => $made, 'missed' => count(array_filter($balls, fn ($b) => $b === 0)), 'jackpotLit' => $n, 'jackpot' => $n === 5];
}

if (PHP_SAPI === 'cli' && realpath($_SERVER['SCRIPT_FILENAME'] ?? '') === __FILE__) {
    $o = getopt('', ['server-seed:', 'client-seed:', 'nonce:', 'stake::', 'commit::', 'json']);
    if (! isset($o['server-seed'], $o['client-seed'], $o['nonce']) || ! preg_match('/^[0-9a-f]{64}$/', $o['server-seed']) || ! preg_match('/^[A-Za-z0-9_-]{1,64}$/', $o['client-seed']) || (int) $o['nonce'] < 1) {
        fwrite(STDERR, "usage: php bingo16-verify.php --server-seed <64 lower-case hex> --client-seed <letters, digits, - _> --nonce <n >= 1> [--stake <minor units>] [--commit <64 hex>] [--json]\n");
        exit(2);
    }
    [$balls, $jp, $baskets] = b16_draw($o['server-seed'], $o['client-seed'], (int) $o['nonce']);
    $e = b16_evaluate($balls, $jp);
    $res = ['commit' => hash('sha256', $o['server-seed']), 'balls' => $balls, 'jackpotNumbers' => $jp, 'baskets' => $baskets] + $e + ['patternPay' => intdiv($e['halves'] * (int) ($o['stake'] ?? 0), 2)];
    $bad = isset($o['commit']) && strtolower($o['commit']) !== $res['commit'];
    if (isset($o['json'])) {
        echo json_encode($res + ['commitOk' => ! $bad], JSON_UNESCAPED_SLASHES), "\n";
    } else {
        foreach ($res as $k => $v) {
            echo $k, ': ', is_array($v) ? implode(' ', $v) : (is_bool($v) ? ($v ? 'yes' : 'no') : ($v ?? 'none')), "\n";
        }
        if (isset($o['commit'])) {
            echo $bad ? "COMMIT DOES NOT MATCH: this is not the server seed that was shown before the play\n" : "commit matches: the server seed is the one that was shown before the play\n";
        }
    }
    exit($bad ? 1 : 0);
}
