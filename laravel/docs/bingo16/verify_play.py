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

BALLS, SLOTS, TOTAL, SLOT_W, JP = 16, 16, 10000, 184, 5          # 16 balls; every ball: slot k with weight 184 of 10,000 (16 slots = 2,944), else OUT (7,056)
PAYS = [('lines2', '2+ LINES', 30), ('corners', '4 CORNERS', 15), ('fullline', 'FULL LINE', 5), ('square', '2x2 SQUARE', 2), ('three', '3 ON LINE', 2)]   # best first
ROWS = [[r * 4 + c for c in range(4)] for r in range(4)]
COLS = [[r * 4 + c for r in range(4)] for c in range(4)]
LINES = ROWS + COLS + [[0, 5, 10, 15], [3, 6, 9, 12]]
CORNERS = [0, 3, 12, 15]
SQUARES = [[r * 4 + c, r * 4 + c + 1, (r + 1) * 4 + c, (r + 1) * 4 + c + 1] for r in range(3) for c in range(3)]


def stream_ints(server_seed_hex, label):
    key = bytes.fromhex(server_seed_hex)
    counter = 0
    while True:
        block = hmac.new(key, f"{label}:{counter}".encode(), hashlib.sha256).digest()
        counter += 1
        for i in range(0, 32, 4):
            yield int.from_bytes(block[i:i + 4], "big")


def draw(server_seed_hex, client_seed, nonce):
    """-> (balls, jackpot numbers): balls[i] = slot 1..16 or 0 (drained OUT); the five jackpot numbers in draw order."""
    ints = stream_ints(server_seed_hex, f"bingo-pinball-16:{client_seed}:{nonce}")

    def below(n):
        limit = 2 ** 32 - (2 ** 32 % n)
        while True:
            v = next(ints)
            if v < limit:
                return v % n

    balls = []
    for _ in range(BALLS):
        r = below(TOTAL)
        balls.append(r // SLOT_W + 1 if r < SLOT_W * SLOTS else 0)
    a = list(range(1, SLOTS + 1))
    for i in range(JP):
        j = i + below(SLOTS - i)
        a[i], a[j] = a[j], a[i]
    return balls, a[:JP]


def pattern(lit):
    """lit: set of cell indexes 0..15 (slot k lights cell k-1) -> the best pattern key or None"""
    full = sum(1 for l in LINES if all(c in lit for c in l))
    if full >= 2:
        return 'lines2'
    if all(c in lit for c in CORNERS):
        return 'corners'
    if full == 1:
        return 'fullline'
    if any(all(c in lit for c in q) for q in SQUARES):
        return 'square'
    if any(sum(1 for c in l if c in lit) >= 3 for l in LINES):
        return 'three'
    return None


def evaluate(balls, jackpot_numbers):
    lit = {b - 1 for b in balls if b > 0}
    key = pattern(lit)
    mult = next((m for k, _, m in PAYS if k == key), 0)
    jp_lit = sum(1 for n in jackpot_numbers if (n - 1) in lit)
    return {'lit': sorted(c + 1 for c in lit), 'pattern': key, 'multiple': mult, 'jackpotLit': jp_lit, 'jackpot': jp_lit == JP}


def par():
    """Exact figures. P(the set of lit slots is exactly S) by Moebius inversion of f(S) = P(every ball is OUT or in S) = ((OUT + |S| * 184) / 10,000)^16."""
    den = TOTAL ** BALLS
    f = [(TOTAL - SLOT_W * SLOTS + SLOT_W * bin(s).count('1')) ** BALLS for s in range(1 << SLOTS)]
    g = f[:]
    for i in range(SLOTS):
        b = 1 << i
        for s in range(1 << SLOTS):
            if s & b:
                g[s] -= g[s ^ b]
    assert sum(g) == den
    count = {k: 0 for k, _, _ in PAYS}
    jp = 0
    litn = 0
    for s in range(1 << SLOTS):
        n = bin(s).count('1')
        litn += g[s] * n
        jp += g[s] * comb(n, JP)
        if g[s] == 0:
            continue
        key = pattern({c for c in range(SLOTS) if s >> c & 1})
        if key:
            count[key] += g[s]
    pays = {k: m for k, _, m in PAYS}
    rtp = sum(Fraction(count[k] * pays[k], den) for k in count)
    second = sum(Fraction(count[k] * pays[k] ** 2, den) for k in count)
    var = second - rtp ** 2
    hit = Fraction(sum(count.values()), den)
    pj = Fraction(jp, den * comb(SLOTS, JP))
    return {'den': den, 'count': count, 'pays': pays, 'rtp': rtp, 'hit': hit, 'variance': var, 'jackpot': pj, 'expectedLit': Fraction(litn, den), 'weights': {'slot': SLOT_W, 'out': TOTAL - SLOT_W * SLOTS, 'total': TOTAL}}


def par_report(as_json):
    p = par()
    out = {k: str(v) if isinstance(v, Fraction) else v for k, v in p.items() if k not in ('count', 'den')}
    out['patterns'] = {k: {'pays': p['pays'][k], 'probability': float(Fraction(p['count'][k], p['den'])), 'oneIn': float(Fraction(p['den'], p['count'][k]))} for k in p['count']}
    out['rtp'] = float(p['rtp']); out['rtpFraction'] = str(p['rtp']); out['hit'] = float(p['hit']); out['standardDeviation'] = float(p['variance']) ** 0.5
    out['jackpot'] = float(p['jackpot']); out['jackpotOneIn'] = float(1 / p['jackpot']); out['expectedLit'] = float(p['expectedLit'])
    out['variance'] = float(p['variance'])
    if as_json:
        return json.dumps(out, indent=2)
    lines = ['Bingo Pinball 16 - paytable b16-v90-1: exact PAR sheet', '',
             f"Each ball: slot k with probability {SLOT_W}/{TOTAL} (16 slots: {SLOT_W * SLOTS}/{TOTAL}), drains OUT with probability {TOTAL - SLOT_W * SLOTS}/{TOTAL}. 16 balls per play.", '',
             'Pattern          pays   probability   1 in       share of RTP']
    for k, name, m in PAYS:
        pr = Fraction(p['count'][k], p['den'])
        lines.append(f"{name:<14} {m:>5}x   {float(pr):.8f}   {float(1 / pr):>9,.1f}   {float(pr * m) * 100:6.3f}%")
    lines += ['', f"Pattern RTP (best pattern only)  {float(p['rtp']) * 100:.4f}%   exact {p['rtp']}", f"Win frequency (any pattern)      {float(p['hit']) * 100:.3f}%",
              f"Standard deviation of a play     {float(p['variance']) ** 0.5:.4f} x stake", f"Expected lit slots per play      {float(p['expectedLit']):.3f} of 16",
              f"Jackpot (all 5 jackpot numbers lit)  probability {float(p['jackpot']):.6f}  1 in {float(1 / p['jackpot']):,.0f}"]
    return '\n'.join(lines) + '\n'


def make_vectors():
    out = []
    n = 0
    seeds = 0
    want = {None: 6, 'three': 6, 'square': 6, 'fullline': 6, 'corners': 6, 'lines2': 6, 'jackpot': 6}
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
                    'lit': e['lit'], 'pattern': e['pattern'], 'multiple': e['multiple'], 'jackpotLit': e['jackpotLit'], 'jackpot': e['jackpot']})
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
    res = {'commit': hashlib.sha256(a.server_seed.encode()).hexdigest(), 'balls': balls, 'jackpotNumbers': jpn, **e, 'patternPay': e['multiple'] * a.stake}
    print(json.dumps(res) if a.json else '\n'.join(f"{k}: {v}" for k, v in res.items()))
