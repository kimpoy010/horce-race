#!/usr/bin/env php
<?php
/*
 * Bingo Pinball - verify one play, on your own.
 *
 * Needs nothing but PHP 8 (no framework, no database, no network). Give it what the game shows you after a seed was revealed:
 *
 *   php bingo-verify.php --server-seed <64 hex> --client-seed <text> --nonce <n> [--version 96] [--stake 1000] [--commit <64 hex>] [--json]
 *
 * It re-draws the five holes from (server seed, client seed, nonce), lights the card, finds the best line and prints what the play pays. With --commit it also
 * checks that the server seed is the one that was shown (sha256 of the seed) before you played. Exit code: 0 = all good, 1 = the commit does not match, 2 = bad input.
 *
 * How the holes are drawn (the same text is in docs/bingo/MATH.md):
 *   key    = the 32 bytes of the server seed
 *   stream = HMAC-SHA256(key, "bingo-pinball:" . clientSeed . ":" . nonce . ":" . counter), counter = 0, 1, 2 ...; read 4 bytes (big endian) at a time
 *   int(n) = uniform in [0, n): take 32-bit values v, throw away v >= 2^32 - (2^32 mod n), the answer is v mod n
 *   holes  = a = [1..25]; for i = 0..4: j = i + int(25 - i); swap a[i], a[j]; the balls end in a[0] ... a[4], in this order
 * A card cell lights when its hole number is among the five. The 12 lines are the 5 rows, 5 columns and 2 diagonals; the best line (most lit cells) pays,
 * 3 / 4 / 5 lit cells pay the multiples of the version's paytable, the stake included; lines do not add up.
 */

const BP_PAYTABLES = [
    88 => ['id' => 'bp-v88-1', 'pays' => [3 => 2, 4 => 3, 5 => 75],
        'card' => [12, 1, 7, 4, 21, 22, 15, 3, 25, 9, 6, 2, 24, 16, 14, 13, 8, 11, 23, 17, 20, 19, 10, 5, 18]],
    90 => ['id' => 'bp-v90-1', 'pays' => [3 => 2, 4 => 4, 5 => 60],
        'card' => [12, 1, 3, 23, 4, 18, 19, 21, 13, 20, 16, 9, 5, 7, 2, 25, 15, 17, 24, 14, 22, 11, 6, 8, 10]],
    92 => ['id' => 'bp-v92-1', 'pays' => [3 => 2, 4 => 5, 5 => 50],
        'card' => [23, 10, 14, 13, 17, 11, 6, 9, 18, 15, 2, 12, 20, 22, 16, 24, 7, 4, 21, 5, 3, 25, 19, 1, 8]],
    94 => ['id' => 'bp-v94-1', 'pays' => [3 => 2, 4 => 5, 5 => 150],
        'card' => [20, 10, 6, 24, 21, 13, 11, 16, 1, 5, 7, 4, 25, 17, 3, 2, 18, 15, 9, 12, 14, 23, 19, 8, 22]],
    96 => ['id' => 'bp-v96-1', 'pays' => [3 => 2, 4 => 6, 5 => 150],
        'card' => [4, 8, 21, 19, 20, 3, 18, 5, 15, 16, 24, 2, 14, 23, 17, 25, 6, 11, 12, 10, 9, 1, 22, 13, 7]],
];

const BP_LINES = [
    [0, 1, 2, 3, 4], [5, 6, 7, 8, 9], [10, 11, 12, 13, 14], [15, 16, 17, 18, 19], [20, 21, 22, 23, 24],
    [0, 5, 10, 15, 20], [1, 6, 11, 16, 21], [2, 7, 12, 17, 22], [3, 8, 13, 18, 23], [4, 9, 14, 19, 24],
    [0, 6, 12, 18, 24], [4, 8, 12, 16, 20],
];

/** @return callable(int): int  a function returning a uniform integer in [0, n) from the seeded stream */
function bp_stream(string $serverSeedHex, string $label): callable
{
    $key = hex2bin($serverSeedHex);
    $ctr = 0;
    $buf = '';
    $pos = 0;
    $byte = function () use (&$ctr, &$buf, &$pos, $key, $label): int {
        if ($pos >= strlen($buf)) {
            $buf = hash_hmac('sha256', $label . ':' . $ctr++, $key, true);
            $pos = 0;
        }

        return ord($buf[$pos++]);
    };

    return function (int $n) use ($byte): int {
        $limit = 4294967296 - (4294967296 % $n);
        do {
            $v = ($byte() << 24) | ($byte() << 16) | ($byte() << 8) | $byte();
        } while ($v >= $limit);

        return $v % $n;
    };
}

/** @return list<int> */
function bp_holes(string $serverSeedHex, string $clientSeed, int $nonce): array
{
    $int = bp_stream($serverSeedHex, 'bingo-pinball:' . $clientSeed . ':' . $nonce);
    $a = range(1, 25);
    for ($i = 0; $i < 5; $i++) {
        $j = $i + $int(25 - $i);
        [$a[$i], $a[$j]] = [$a[$j], $a[$i]];
    }

    return array_slice($a, 0, 5);
}

/** @return array{lit:int, line:?int, litCells:list<int>} */
function bp_evaluate(array $card, array $holes): array
{
    $lit = [];
    foreach ($holes as $h) {
        $lit[array_search($h, $card, true)] = true;
    }
    $best = 0;
    $line = null;
    foreach (BP_LINES as $i => $cells) {
        $n = count(array_filter($cells, fn ($c) => isset($lit[$c])));
        if ($n > $best) {
            $best = $n;
            $line = $i;
        }
    }
    $cells = array_keys($lit);
    sort($cells);

    return ['lit' => $best, 'line' => $line, 'litCells' => $cells];
}

function bp_line_name(int $line): string
{
    return $line < 5 ? 'row ' . ($line + 1) : ($line < 10 ? 'column ' . ($line - 4) : 'diagonal ' . ($line - 9));
}

/** the whole verification as data: what the game must have shown for this play */
function bp_verify(string $serverSeed, string $clientSeed, int $nonce, int $version, int $stake = 1): array
{
    $t = BP_PAYTABLES[$version];
    $holes = bp_holes($serverSeed, $clientSeed, $nonce);
    $e = bp_evaluate($t['card'], $holes);
    $multiple = $t['pays'][$e['lit']] ?? 0;

    return ['version' => $version, 'paytable' => $t['id'], 'commit' => hash('sha256', $serverSeed), 'holes' => $holes, 'litCells' => $e['litCells'], 'bestLit' => $e['lit'],
        'bestLine' => $e['line'] === null ? null : bp_line_name($e['line']), 'multiple' => $multiple, 'stake' => $stake, 'payout' => $stake * $multiple];
}

function bp_main(array $argv): int
{
    $o = getopt('', ['server-seed:', 'client-seed:', 'nonce:', 'version:', 'stake:', 'commit:', 'json']);
    $seed = (string) ($o['server-seed'] ?? '');
    $client = (string) ($o['client-seed'] ?? '');
    $nonce = (int) ($o['nonce'] ?? 0);
    $version = (int) ($o['version'] ?? 96);
    $stake = (int) ($o['stake'] ?? 1);
    if (! preg_match('/^[0-9a-f]{64}$/', $seed) || ! preg_match('/^[A-Za-z0-9_-]{1,64}$/', $client) || $nonce < 1 || ! isset(BP_PAYTABLES[$version]) || $stake < 1) {
        fwrite(STDERR, "usage: php bingo-verify.php --server-seed <64 lower-case hex> --client-seed <1-64 letters, digits, - or _> --nonce <1,2,...> [--version " . implode('|', array_keys(BP_PAYTABLES)) . "] [--stake <minor units>] [--commit <64 hex>] [--json]\n");

        return 2;
    }
    $r = bp_verify($seed, $client, $nonce, $version, $stake);
    $commitOk = ! isset($o['commit']) || hash_equals(strtolower((string) $o['commit']), $r['commit']);
    if (isset($o['json'])) {
        echo json_encode($r + ['commitChecked' => isset($o['commit']), 'commitMatches' => $commitOk], JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES), "\n";

        return $commitOk ? 0 : 1;
    }
    $card = BP_PAYTABLES[$version]['card'];
    echo "Server seed commit (sha256 of the seed): {$r['commit']}\n";
    if (isset($o['commit'])) {
        echo $commitOk ? "Commit CHECKED: it is the commit that was shown before the play.\n" : "Commit DOES NOT MATCH the commit you gave. This is not the seed that was committed.\n";
    }
    echo "Paytable {$r['paytable']}, client seed \"$client\", nonce $nonce\n";
    echo 'Balls ended in holes: ' . implode(', ', $r['holes']) . "\n\nCard (lit cells in [ ]):\n";
    for ($row = 0; $row < 5; $row++) {
        $cells = [];
        for ($col = 0; $col < 5; $col++) {
            $i = $row * 5 + $col;
            $cells[] = in_array($i, $r['litCells'], true) ? sprintf('[%2d]', $card[$i]) : sprintf(' %2d ', $card[$i]);
        }
        echo '  ' . implode(' ', $cells) . "\n";
    }
    echo "\n" . ($r['bestLit'] >= 3 ? "Best line: {$r['bestLine']} with {$r['bestLit']} lit cells: pays {$r['multiple']}x the stake (stake included): {$r['payout']} for a stake of $stake.\n"
        : "No winning line (best line has {$r['bestLit']} lit cells): pays nothing.\n");

    return $commitOk ? 0 : 1;
}

if (PHP_SAPI === 'cli' && isset($_SERVER['argv'][0]) && realpath($_SERVER['argv'][0]) === __FILE__) {
    exit(bp_main($_SERVER['argv']));
}
