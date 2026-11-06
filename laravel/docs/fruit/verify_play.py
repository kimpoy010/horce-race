#!/usr/bin/env python3
"""
Fruit Ring - an independent implementation of the draw, the paytable and the double-up, written only from the specification in docs/fruit/MATH.md (not translated from the
PHP code). The PHP implementation is checked against it (tests/Unit/FruitMathTest.php, on docs/fruit/test-vectors.json) and a testing lab can run it. It also computes the exact
PAR figures with big integers (fractions, no rounding until the figures are printed).

  python3 verify_play.py --server-seed <64 hex> --client-seed <text> --nonce <n> [--bets 1,1,1,1,1,1,1,1] [--json]     re-draw one spin and pay the bets
  python3 verify_play.py --double --server-seed ... --client-seed ... --nonce <n>                                      re-draw one double-up number
  python3 verify_play.py --par [--json]                                                                                  the exact PAR sheet
  python3 verify_play.py --make-vectors > test-vectors.json                                                              how the known-answer plays were made

Only the standard library is used.
"""
import argparse, hashlib, hmac, json, sys
from fractions import Fraction

W = 100000                                                  # every stop is one number below 100,000, mapped to a cell by the weights below
SYMBOLS = ['bar', 'seven', 'star', 'watermelon', 'bell', 'lemon', 'orange', 'apple']      # the order of the eight bets (BAR 30 / 77 10 / ...: see PAYS)
PAYS = {'bar': 30, 'seven': 10, 'star': 7, 'watermelon': 5, 'bell': 5, 'lemon': 4, 'orange': 2, 'apple': 2}      # per credit bet on the symbol, stake included
BAR50 = 12                                                  # the BAR x50 cell pays this for a credit on BAR (the BAR BAR BAR cell pays PAYS['bar'])
# the 24 cells clockwise from the top left: (symbol, multiplier, weight out of 100,000). Two Lucky cells pay nothing themselves: 'free3' gives 3 free spins (one lit cell each),
# 'light3' gives one free spin with 3 lit cells. In a free spin the lit cells are drawn among the non-Lucky cells by their weights (so a free spin never gives more free spins).
RING = [('orange', 1, 8041), ('bell', 1, 3216), ('bar50', 1, 1914), ('bar3', 1, 1914), ('apple', 1, 5744), ('apple', 3, 5744), ('lemon', 1, 4020),
        ('watermelon', 1, 4020), ('watermelon', 3, 4020), ('free3', 1, 1908), ('apple', 1, 5744), ('orange', 3, 8041),
        ('orange', 1, 8041), ('bell', 1, 3216), ('seven', 3, 2010), ('seven', 1, 2010), ('apple', 1, 5744), ('lemon', 3, 4020), ('lemon', 1, 4020),
        ('star', 3, 2872), ('star', 1, 2872), ('light3', 1, 1909), ('apple', 1, 5744), ('bell', 3, 3216)]
assert sum(c[2] for c in RING) == W and len(RING) == 24
LUCKY = [i for i, c in enumerate(RING) if c[0] in ('free3', 'light3')]
NON_LUCKY = [i for i in range(24) if i not in LUCKY]
W_NL = sum(RING[i][2] for i in NON_LUCKY)


def symbol_of(i):
    c = RING[i][0]
    return 'bar' if c in ('bar3', 'bar50') else ('lucky' if c in ('free3', 'light3') else c)


def cell_pay(i):
    """credits paid for one credit on the cell's symbol when the cell is lit (a x3 cell pays three times the symbol's pay)"""
    c, m, _ = RING[i]
    if c == 'bar3':
        return PAYS['bar']
    if c == 'bar50':
        return BAR50
    return 0 if c in ('free3', 'light3') else PAYS[c] * m


def stream_ints(server_seed_hex, label):
    key = bytes.fromhex(server_seed_hex)
    counter = 0
    while True:
        block = hmac.new(key, f"{label}:{counter}".encode(), hashlib.sha256).digest()
        counter += 1
        for i in range(0, 32, 4):
            yield int.from_bytes(block[i:i + 4], "big")


def _below(ints, n):
    limit = 2 ** 32 - (2 ** 32 % n)
    while True:
        v = next(ints)
        if v < limit:
            return v % n


def _pick(r, cells):
    for i in cells:
        if r < RING[i][2]:
            return i
        r -= RING[i][2]
    raise AssertionError


def spin(server_seed_hex, client_seed, nonce):
    """-> the rounds of one play, each a list of lit cells. A normal stop: [[stop]]. 'free3': [[stop], [a], [b], [c]] (three free spins). 'light3': [[stop], [a, b, c]] (one free spin, three lit
    cells). Every free-spin cell is drawn from the non-Lucky cells by weight (int(W_NL)), in order, from the same stream after the stop."""
    ints = stream_ints(server_seed_hex, f"fruit-ring:{client_seed}:{nonce}")
    stop = _pick(_below(ints, W), range(24))
    kind = RING[stop][0]
    if kind not in ('free3', 'light3'):
        return [[stop]]
    cells = [_pick(_below(ints, W_NL), NON_LUCKY) for _ in range(3)]
    return [[stop]] + ([[c] for c in cells] if kind == 'free3' else [cells])


def double_number(server_seed_hex, client_seed, nonce):
    """the number 1..14 of one double-up: Small is 1-7, Big is 8-14"""
    return _below(stream_ints(server_seed_hex, f"fruit-double:{client_seed}:{nonce}"), 14) + 1


def payouts(rounds):
    """credits paid for ONE credit on each symbol, for all the cells lit in all the rounds (every lit cell pays; the same cell twice pays twice)"""
    lit = [i for r in rounds for i in r]
    return {s: sum(cell_pay(i) for i in lit if symbol_of(i) == s) for s in SYMBOLS}


def pay_bets(lit, bets):
    p = payouts(lit)
    return sum(bets[k] * p[s] for k, s in enumerate(SYMBOLS))


def par():
    """Exact figures for one credit on each symbol (and on all eight): from every outcome of a spin with its exact probability."""
    outcomes = []            # (probability, rounds)
    for i in NON_LUCKY:
        outcomes.append((Fraction(RING[i][2], W), [[i]]))
    qL = Fraction(sum(RING[i][2] for i in LUCKY), W)
    for L in LUCKY:
        qs = Fraction(RING[L][2], W)
        for a in NON_LUCKY:
            for b in NON_LUCKY:
                for c in NON_LUCKY:
                    p = qs * Fraction(RING[a][2] * RING[b][2] * RING[c][2], W_NL ** 3)
                    outcomes.append((p, [[L], [a], [b], [c]] if RING[L][0] == 'free3' else [[L], [a, b, c]]))
    assert sum(p for p, _ in outcomes) == 1
    res = {}
    cache = [(p, payouts(l)) for p, l in outcomes]
    for s in SYMBOLS:
        ev = sum(p * pay_[s] for p, pay_ in cache)
        ev2 = sum(p * pay_[s] ** 2 for p, pay_ in cache)
        hit = sum(p for p, pay_ in cache if pay_[s] > 0)
        res[s] = {'pay': PAYS[s], 'ev': ev, 'variance': ev2 - ev * ev, 'hit': hit, 'stop': sum(Fraction(RING[i][2], W) for i in range(24) if symbol_of(i) == s)}
    tot = sum(p * sum(pay_.values()) for p, pay_ in cache)
    tot2 = sum(p * sum(pay_.values()) ** 2 for p, pay_ in cache)
    return {'symbols': res, 'luckyShare': qL, 'allEight': {'ev': tot / 8, 'variance': (tot2 - tot * tot) / 64}, 'nOutcomes': len(outcomes)}


def par_report(as_json):
    p = par()
    if as_json:
        out = {'luckyShare': float(p['luckyShare']), 'allEightRtp': float(p['allEight']['ev']), 'symbols': {s: {'pay': v['pay'], 'rtp': float(v['ev']), 'rtpFraction': str(v['ev']), 'hit': float(v['hit']), 'stop': float(v['stop']),
               'standardDeviation': float(v['variance']) ** 0.5} for s, v in p['symbols'].items()}}
        return json.dumps(out, indent=2)
    lines = ['Fruit Ring - paytable fr-v90-2: exact PAR sheet', '', f"24 cells, stop weights out of {W:,}; Lucky cells (share {float(p['luckyShare']) * 100:.3f}%) pay nothing themselves: one gives 3 free spins, the other a free spin with 3 lit cells.",
             'A credit on one symbol:', '', 'symbol       pay    light stops on it    wins (incl. Lucky)    returns      standard deviation']
    for s in SYMBOLS:
        v = p['symbols'][s]
        lines.append(f"{s:<11}  {v['pay']:>3}x   {float(v['stop']) * 100:>13.3f}%   {float(v['hit']) * 100:>16.3f}%   {float(v['ev']) * 100:>9.4f}%   {float(v['variance']) ** 0.5:>10.4f} x")
    lines += ['', f"One credit on each of the eight symbols returns {float(p['allEight']['ev']) * 100:.4f}% (standard deviation of that spin {float(p['allEight']['variance']) ** 0.5 * 8:.3f} credits on 8 staked).",
              f"Double-up: a number 1-14 (Small 1-7, Big 8-14), 50% to double, up to 3 times in a row: returns 100% of what is risked; it does not change the return of the game."]
    return '\n'.join(lines) + '\n'


def make_vectors():
    out = []
    seeds = 0
    want = {'plain': 8, 'x3': 8, 'free3': 6, 'light3': 6, 'bar': 4}
    got = {k: 0 for k in want}
    while any(got[k] < want[k] for k in want):
        seeds += 1
        server = hashlib.sha256(f"fruit vector seed {seeds}".encode()).hexdigest()
        client, nonce = f"vector-{seeds}", 1 + seeds % 9
        lit = spin(server, client, nonce)
        kind = 'free3' if RING[lit[0][0]][0] == 'free3' else ('light3' if RING[lit[0][0]][0] == 'light3' else ('bar' if RING[lit[0][0]][0] in ('bar3', 'bar50') else ('x3' if RING[lit[0][0]][1] == 3 else 'plain')))
        if got[kind] >= want[kind]:
            continue
        got[kind] += 1
        out.append({'serverSeed': server, 'commit': hashlib.sha256(server.encode()).hexdigest(), 'clientSeed': client, 'nonce': nonce, 'rounds': lit, 'payouts': payouts(lit), 'double': double_number(server, client, nonce)})
    return json.dumps(out, indent=1)


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--server-seed'); ap.add_argument('--client-seed'); ap.add_argument('--nonce', type=int); ap.add_argument('--bets', default='1,1,1,1,1,1,1,1')
    ap.add_argument('--double', action='store_true'); ap.add_argument('--par', action='store_true'); ap.add_argument('--make-vectors', action='store_true'); ap.add_argument('--json', action='store_true')
    a = ap.parse_args()
    if a.par:
        print(par_report(a.json)); sys.exit(0)
    if a.make_vectors:
        print(make_vectors()); sys.exit(0)
    if not (a.server_seed and a.client_seed is not None and a.nonce):
        ap.error('give --server-seed, --client-seed and --nonce (or --par)')
    if a.double:
        n = double_number(a.server_seed, a.client_seed, a.nonce)
        res = {'commit': hashlib.sha256(a.server_seed.encode()).hexdigest(), 'number': n, 'side': 'small' if n <= 7 else 'big'}
    else:
        lit = spin(a.server_seed, a.client_seed, a.nonce)
        bets = [int(x) for x in a.bets.split(',')]
        res = {'commit': hashlib.sha256(a.server_seed.encode()).hexdigest(), 'rounds': lit, 'symbols': [[symbol_of(i) + ('x3' if RING[i][1] == 3 else '') for i in r] for r in lit], 'payoutPerCredit': payouts(lit), 'paid': pay_bets(lit, bets)}
    print(json.dumps(res) if a.json else '\n'.join(f"{k}: {v}" for k, v in res.items()))
