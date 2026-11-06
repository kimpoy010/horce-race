#!/usr/bin/env php
<?php
/*
 * Fruit Ring - verify one spin (or one double-up) on your own. Needs nothing but PHP 8 (no framework, no database, no network).
 *
 *   php fruit-verify.php --server-seed <64 hex> --client-seed <text> --nonce <n> [--bets 1,1,1,1,1,1,1,1] [--commit <64 hex>] [--json]
 *   php fruit-verify.php --double --server-seed <64 hex> --client-seed <text> --nonce <n>
 *
 * The draw (the same text is in docs/fruit/MATH.md and in app/Games/FruitRing/Draw.php):
 *   stream = HMAC-SHA256(server seed's 32 bytes, "fruit-ring:" clientSeed ":" nonce ":" counter) for a spin ("fruit-double:" ... for a double-up), four bytes (big endian) at a time
 *   int(n) = uniform in [0, n): throw away 32-bit values v >= 2^32 - (2^32 mod n), the answer is v mod n
 *   spin   = r = int(100000), mapped to a cell by the weights of the 24 cells (docs/fruit/PAR_SHEET.txt); a Lucky stop gives free spins: three numbers int(non-Lucky weight) pick three non-Lucky cells; one Lucky cell (free3) = 3 free spins of one cell each, the other (light3) = one free spin with 3 lit cells
 *   double = int(14) + 1: Small 1-7, Big 8-14
 * The bets are credits on the 8 symbols in the order bar, seven, star, watermelon, bell, lemon, orange, apple. Exit code: 0 = ok, 1 = the commit does not match, 2 = bad input.
 */

const FR_SYMBOLS = ['bar', 'seven', 'star', 'watermelon', 'bell', 'lemon', 'orange', 'apple'];
const FR_PAYS = ['bar' => 30, 'seven' => 10, 'star' => 7, 'watermelon' => 5, 'bell' => 5, 'lemon' => 4, 'orange' => 2, 'apple' => 2];
const FR_RING = [
    ['orange', 1, 8041], ['bell', 1, 3216], ['bar50', 1, 1914], ['bar3', 1, 1914], ['apple', 1, 5744], ['apple', 3, 5744], ['lemon', 1, 4020],
    ['watermelon', 1, 4020], ['watermelon', 3, 4020], ['free3', 1, 1908], ['apple', 1, 5744], ['orange', 3, 8041],
    ['orange', 1, 8041], ['bell', 1, 3216], ['seven', 3, 2010], ['seven', 1, 2010], ['apple', 1, 5744], ['lemon', 3, 4020], ['lemon', 1, 4020],
    ['star', 3, 2872], ['star', 1, 2872], ['light3', 1, 1909], ['apple', 1, 5744], ['bell', 3, 3216],
];

function fr_stream(string $key, string $label): Generator
{
    for ($ctr = 0;; $ctr++) {
        $block = hash_hmac('sha256', $label.':'.$ctr, $key, true);
        for ($i = 0; $i < 32; $i += 4) {
            yield unpack('N', substr($block, $i, 4))[1];
        }
    }
}

function fr_below(Generator $g, int $n): int
{
    $limit = 4294967296 - (4294967296 % $n);
    do {
        $v = $g->current();
        $g->next();
    } while ($v >= $limit);

    return $v % $n;
}

function fr_pick(int $r, array $cells): int
{
    foreach ($cells as $i) {
        if ($r < FR_RING[$i][2]) {
            return $i;
        }
        $r -= FR_RING[$i][2];
    }
    throw new LogicException('weights');
}

function fr_symbol(int $i): string
{
    $c = FR_RING[$i][0];

    return in_array($c, ['bar3', 'bar50'], true) ? 'bar' : (in_array($c, ['free3', 'light3'], true) ? 'lucky' : $c);
}

function fr_cell_pay(int $i): int
{
    [$c, $m] = FR_RING[$i];

    return $c === 'bar3' ? FR_PAYS['bar'] : ($c === 'bar50' ? 12 : (in_array($c, ['free3', 'light3'], true) ? 0 : FR_PAYS[$c] * $m));
}

function fr_spin(string $seedHex, string $client, int $nonce): array
{
    $g = fr_stream(hex2bin($seedHex), 'fruit-ring:'.$client.':'.$nonce);
    $stop = fr_pick(fr_below($g, 100000), range(0, 23));
    $kind = FR_RING[$stop][0];
    if (fr_symbol($stop) !== 'lucky') {
        return [[$stop]];
    }
    $non = array_values(array_filter(range(0, 23), fn ($i) => fr_symbol($i) !== 'lucky'));
    $wn = array_sum(array_map(fn ($i) => FR_RING[$i][2], $non));
    $c = [fr_pick(fr_below($g, $wn), $non), fr_pick(fr_below($g, $wn), $non), fr_pick(fr_below($g, $wn), $non)];

    return $kind === 'free3' ? [[$stop], [$c[0]], [$c[1]], [$c[2]]] : [[$stop], $c];
}

function fr_payouts(array $rounds): array
{
    $out = array_fill_keys(FR_SYMBOLS, 0);
    foreach (array_merge(...$rounds) as $i) {
        if (fr_symbol($i) !== 'lucky') {
            $out[fr_symbol($i)] += fr_cell_pay($i);
        }
    }

    return $out;
}

if (PHP_SAPI === 'cli' && realpath($_SERVER['SCRIPT_FILENAME'] ?? '') === __FILE__) {
    $o = getopt('', ['server-seed:', 'client-seed:', 'nonce:', 'bets:', 'commit:', 'double', 'json']);
    if (! isset($o['server-seed'], $o['client-seed'], $o['nonce']) || ! preg_match('/^[0-9a-f]{64}$/', $o['server-seed']) || ! preg_match('/^[A-Za-z0-9_-]{1,64}$/', $o['client-seed']) || (int) $o['nonce'] < 1) {
        fwrite(STDERR, "usage: php fruit-verify.php [--double] --server-seed <64 lower-case hex> --client-seed <letters, digits, - _> --nonce <n >= 1> [--bets 1,1,1,1,1,1,1,1] [--commit <64 hex>] [--json]\n");
        exit(2);
    }
    $commit = hash('sha256', $o['server-seed']);
    if (isset($o['double'])) {
        $n = fr_below(fr_stream(hex2bin($o['server-seed']), 'fruit-double:'.$o['client-seed'].':'.$o['nonce']), 14) + 1;
        $res = ['commit' => $commit, 'number' => $n, 'side' => $n <= 7 ? 'small' : 'big'];
    } else {
        $lit = fr_spin($o['server-seed'], $o['client-seed'], (int) $o['nonce']);
        $bets = array_map('intval', explode(',', $o['bets'] ?? '1,1,1,1,1,1,1,1'));
        $p = fr_payouts($lit);
        $paid = 0;
        foreach (FR_SYMBOLS as $k => $s) {
            $paid += ($bets[$k] ?? 0) * $p[$s];
        }
        $res = ['commit' => $commit, 'rounds' => $lit, 'symbols' => array_map(fn ($r) => array_map(fn ($i) => fr_symbol($i).(FR_RING[$i][1] === 3 ? 'x3' : ''), $r), $lit), 'payoutPerCredit' => $p, 'paid' => $paid];
    }
    $bad = isset($o['commit']) && strtolower($o['commit']) !== $commit;
    if (isset($o['json'])) {
        echo json_encode($res + ['commitOk' => ! $bad], JSON_UNESCAPED_SLASHES), "\n";
    } else {
        foreach ($res as $k => $v) {
            echo $k, ': ', is_array($v) ? json_encode($v) : $v, "\n";
        }
        if (isset($o['commit'])) {
            echo $bad ? "COMMIT DOES NOT MATCH: this is not the server seed that was shown before the play\n" : "commit matches\n";
        }
    }
    exit($bad ? 1 : 0);
}
