#!/usr/bin/env python3
"""
Bingo Pinball 16 - an independent implementation of the draw and the paytable, written only from the specification in docs/bingo16/MATH.md (not translated from
the PHP code). The PHP implementation is checked against it (tests/Unit/BingoMath16Test.php, on docs/bingo16/test-vectors.json) and a testing lab can run it.
It also computes the exact PAR figures with big integers (no rounding anywhere until the figures are printed).

  python3 verify_play.py --server-seed <64 hex> --client-seed <text> --nonce <n> [--stake 1000] [--json]     re-draw and pay one play
  python3 verify_play.py --par [--json]                                                                          the exact PAR sheet
  python3 verify_play.py --make-vectors > test-vectors.json                                                      how the known-answer plays were made

Only the standard library is used.
"""
import argparse, hashlib, hmac, json, sys
from fractions import Fraction
from itertools import combinations
from math import comb

BALLS, SLOTS, TOTAL, SLOT_W, JP = 16, 16, 10000, 625, 5          # 16 balls; every ball lands in slot k with weight 625 of 10,000 (16 slots = 10,000): there is no OUT
ROWS = [[r * 4 + c for c in range(4)] for r in range(4)]
COLS = [[r * 4 + c for r in range(4)] for c in range(4)]
DIAGS = [[0, 5, 10, 15], [3, 6, 9, 12]]
LINES = ROWS + COLS + DIAGS                                  # the 10 lines (used for the 'lines' figure only)
# The twelve winning patterns, best first: the first one that is complete pays, patterns never add up. (key, name, pay in HALF stakes, the ways it can be made: each a set of cells 0..15, the
# card read row by row). A pay of 1 half-stake is 0.5 x the stake; the payout is floor(stake x halves / 2).
PATTERNS = [
    ('full', 'FULL CARD', 10000, [list(range(16))]),
    ('bigbox', 'BIG BOX', 300, [[0, 1, 2, 3, 4, 7, 8, 11, 12, 13, 14, 15]]),
    ('zshape', 'Z SHAPE', 30, [[0, 1, 2, 3, 6, 9, 12, 13, 14, 15]]),
    ('equal', 'EQUAL', 10, [ROWS[0] + ROWS[3]]),
    ('eleven', 'NUMBER ELEVEN', 10, [COLS[0] + COLS[3]]),
    ('lucky7', 'LUCKY SEVEN', 4, [[0, 1, 2, 3, 6, 9, 12]]),
    ('lshape', 'L SHAPE', 4, [[0, 4, 8, 12, 13, 14, 15]]),
    ('corners', '4 CORNERS', 2, [[0, 3, 12, 15]]),
    ('smallbox', 'SMALL BOX', 2, [[5, 6, 9, 10]]),
    ('diagonal', 'DIAGONAL', 2, DIAGS),
    ('across', 'ACROSS', 1, ROWS),
    ('down', 'DOWN', 1, COLS),
]
PAYS = [(k, name, halves) for k, name, halves, _ in PATTERNS]


def stream_ints(server_seed_hex, label):
    key = bytes.fromhex(server_seed_hex)
    counter = 0
    while True:
        block = hmac.new(key, f"{label}:{counter}".encode(), hashlib.sha256).digest()
        counter += 1
        for i in range(0, 32, 4):
            yield int.from_bytes(block[i:i + 4], "big")


def draw(server_seed_hex, client_seed, nonce):
    """-> (balls, jackpot numbers): balls[i] = slot 1..16; the five jackpot numbers in draw order."""
    ints = stream_ints(server_seed_hex, f"bingo-pinball-16:{client_seed}:{nonce}")

    def below(n):
        limit = 2 ** 32 - (2 ** 32 % n)
        while True:
            v = next(ints)
            if v < limit:
                return v % n

    balls = []
    for _ in range(BALLS):
        balls.append(below(TOTAL) // SLOT_W + 1)
    a = list(range(1, SLOTS + 1))
    for i in range(JP):
        j = i + below(SLOTS - i)
        a[i], a[j] = a[j], a[i]
    return balls, a[:JP]


def pattern(lit):
    """lit: set of cell indexes 0..15 (slot k lights cell k-1) -> (the key of the best complete pattern, the cells that make it) or (None, [])"""
    for key, _, _, ways in PATTERNS:
        for cells in ways:
            if all(c in lit for c in cells):
                return key, cells
    return None, []


def evaluate(balls, jackpot_numbers):
    """a jackpot number counts as lit when its slot holds at least TWO balls; the jackpot is won when all five are lit. 'halves' is the pay in half stakes."""
    lit = {b - 1 for b in balls}
    key, cells = pattern(lit)
    halves = next((h for k, _, h in PAYS if k == key), 0)
    jp_lit = sum(1 for n in jackpot_numbers if balls.count(n) >= 2)
    lines = [i for i, l in enumerate(LINES) if all(c in lit for c in l)]
    return {'lit': sorted(c + 1 for c in lit), 'pattern': key, 'halves': halves, 'cells': sorted(c + 1 for c in cells), 'lines': lines, 'jackpotLit': jp_lit, 'jackpot': jp_lit == JP}


def jackpot_probability():
    """P(five given slots each hold at least two of the 16 balls), exact: the balls are independent and uniform, so the count is 16! times the coefficient of x^16 in (e^x - 1 - x)^5 (e^x)^11"""
    from math import factorial

    def mul(a, b):
        r = [Fraction(0)] * (BALLS + 1)
        for i, x in enumerate(a):
            if x:
                for j, y in enumerate(b):
                    if i + j <= BALLS:
                        r[i + j] += x * y
        return r
    ex = [Fraction(1, factorial(i)) for i in range(BALLS + 1)]
    two = [ex[i] if i >= 2 else Fraction(0) for i in range(BALLS + 1)]
    p = [Fraction(1)] + [Fraction(0)] * BALLS
    for _ in range(JP):
        p = mul(p, two)
    for _ in range(SLOTS - JP):
        p = mul(p, ex)
    return p[BALLS] * factorial(BALLS) / Fraction(SLOTS ** BALLS)


def par():
    """Exact figures. P(the set of lit slots is exactly S) by Moebius inversion of f(S) = P(every ball lands in S) = (|S| / 16)^16, in integers over 16^16."""
    den = SLOTS ** BALLS
    f = [bin(s).count('1') ** BALLS for s in range(1 << SLOTS)]
    g = f[:]
    for i in range(SLOTS):
        b = 1 << i
        for s in range(1 << SLOTS):
            if s & b:
                g[s] -= g[s ^ b]
    assert sum(g) == den
    count = {k: 0 for k, _, _ in PAYS}
    litn = 0
    for s in range(1 << SLOTS):
        litn += g[s] * bin(s).count('1')
        if g[s] == 0:
            continue
        key, _ = pattern({c for c in range(SLOTS) if s >> c & 1})
        if key:
            count[key] += g[s]
    pays = {k: Fraction(m, 2) for k, _, m in PAYS}                                  # multiples of the stake
    rtp = sum(count[k] * pays[k] / den for k in count)
    second = sum(count[k] * pays[k] ** 2 / den for k in count)
    var = second - rtp ** 2
    hit = Fraction(sum(count.values()), den)
    return {'den': den, 'count': count, 'pays': pays, 'rtp': rtp, 'hit': hit, 'variance': var, 'jackpot': jackpot_probability(), 'expectedLit': Fraction(litn, den), 'weights': {'slot': SLOT_W, 'total': TOTAL}}


def par_report(as_json):
    p = par()
    out = {k: str(v) if isinstance(v, Fraction) else v for k, v in p.items() if k not in ('count', 'den', 'pays')}
    out['patterns'] = {k: {'pays': float(p['pays'][k]), 'probability': float(Fraction(p['count'][k], p['den'])), 'oneIn': float(Fraction(p['den'], p['count'][k]))} for k in p['count']}
    out['rtp'] = float(p['rtp']); out['rtpFraction'] = str(p['rtp']); out['hit'] = float(p['hit']); out['standardDeviation'] = float(p['variance']) ** 0.5
    out['jackpot'] = float(p['jackpot']); out['jackpotOneIn'] = float(1 / p['jackpot']); out['expectedLit'] = float(p['expectedLit'])
    out['variance'] = float(p['variance'])
    if as_json:
        return json.dumps(out, indent=2)
    lines = ['Bingo Pinball 16 - paytable b16-v90-2: exact PAR sheet', '',
             f"Each ball lands in slot k with probability {SLOT_W}/{TOTAL} (every ball lands in a slot, there is no OUT). 16 balls per play.", '',
             'Pattern            pays   probability   1 in         share of RTP (best pattern only)']
    for k, name, h in PAYS:
        pr = Fraction(p['count'][k], p['den'])
        lines.append(f"{name:<14} {h / 2:>7g}x   {float(pr):.8f}   {float(1 / pr):>11,.1f}   {float(pr * Fraction(h, 2)) * 100:6.3f}%")
    lines += ['', f"Pattern RTP  {float(p['rtp']) * 100:.4f}%   exact {p['rtp']}", f"Win frequency (any pattern)      {float(p['hit']) * 100:.3f}%",
              f"Standard deviation of a play     {float(p['variance']) ** 0.5:.4f} x stake", f"Expected lit slots per play      {float(p['expectedLit']):.3f} of 16",
              f"Jackpot (all 5 jackpot numbers hold at least 2 balls)  probability {float(p['jackpot']):.6f}  1 in {float(1 / p['jackpot']):,.0f}"]
    return '\n'.join(lines) + '\n'


def make_vectors():
    out = []
    n = 0
    seeds = 0
    want = {None: 4, 'across': 3, 'down': 3, 'diagonal': 3, 'corners': 3, 'smallbox': 3, 'lshape': 3, 'lucky7': 3, 'equal': 2, 'eleven': 2, 'zshape': 2, 'bigbox': 1, 'jackpot': 3}
    got = {k: 0 for k in want}
    while any(got[k] < want[k] for k in want):
        seeds += 1
        server = hashlib.sha256(f"bingo16 vector seed {seeds}".encode()).hexdigest()
        client = f"vector-{seeds}"
        nonce = 1 + seeds % 7
        balls, jpn = draw(server, client, nonce)
        e = evaluate(balls, jpn)
        k = 'jackpot' if e['jackpot'] else e['pattern']
        if got[k] >= want[k]:
            continue
        got[k] += 1
        out.append({'serverSeed': server, 'commit': hashlib.sha256(server.encode()).hexdigest(), 'clientSeed': client, 'nonce': nonce, 'balls': balls, 'jackpotNumbers': jpn,
                    'lit': e['lit'], 'pattern': e['pattern'], 'halves': e['halves'], 'cells': e['cells'], 'jackpotLit': e['jackpotLit'], 'jackpot': e['jackpot']})
    return json.dumps(out, indent=1)


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--server-seed'); ap.add_argument('--client-seed'); ap.add_argument('--nonce', type=int); ap.add_argument('--stake', type=int, default=0)
    ap.add_argument('--par', action='store_true'); ap.add_argument('--make-vectors', action='store_true'); ap.add_argument('--json', action='store_true')
    a = ap.parse_args()
    if a.par:
        print(par_report(a.json)); sys.exit(0)
    if a.make_vectors:
        print(make_vectors()); sys.exit(0)
    if not (a.server_seed and a.client_seed is not None and a.nonce):
        ap.error('give --server-seed, --client-seed and --nonce (or --par)')
    balls, jpn = draw(a.server_seed, a.client_seed, a.nonce)
    e = evaluate(balls, jpn)
    res = {'commit': hashlib.sha256(a.server_seed.encode()).hexdigest(), 'balls': balls, 'jackpotNumbers': jpn, **e, 'patternPay': e['halves'] * a.stake // 2}
    print(json.dumps(res) if a.json else '\n'.join(f"{k}: {v}" for k, v in res.items()))
