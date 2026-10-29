#!/usr/bin/env python3
"""
Bingo Pinball - an independent implementation of the draw, written only from the specification in docs/bingo/MATH.md (not translated from the PHP code).
It exists so that the PHP implementation can be checked against something that does not share its code: tests/Unit/BingoMathTest.php compares both on
the known-answer vectors in docs/bingo/test-vectors.json, and a testing lab can run it on its own.

  python3 verify_play.py --server-seed <64 hex> --client-seed <text> --nonce <n> [--version 96] [--stake 1000] [--json]
  python3 verify_play.py --make-vectors > test-vectors.json      (how docs/bingo/test-vectors.json was produced)

Only the standard library is used.
"""
import argparse, hashlib, hmac, json, sys

# card layouts (cell i, row by row, shows hole number card[i]) and pays {lit cells: multiple of the stake, stake included}, per RTP version
TABLES = {
    88: ([12, 1, 7, 4, 21, 22, 15, 3, 25, 9, 6, 2, 24, 16, 14, 13, 8, 11, 23, 17, 20, 19, 10, 5, 18], {3: 2, 4: 3, 5: 75}),
    90: ([12, 1, 3, 23, 4, 18, 19, 21, 13, 20, 16, 9, 5, 7, 2, 25, 15, 17, 24, 14, 22, 11, 6, 8, 10], {3: 2, 4: 4, 5: 60}),
    92: ([23, 10, 14, 13, 17, 11, 6, 9, 18, 15, 2, 12, 20, 22, 16, 24, 7, 4, 21, 5, 3, 25, 19, 1, 8], {3: 2, 4: 5, 5: 50}),
    94: ([20, 10, 6, 24, 21, 13, 11, 16, 1, 5, 7, 4, 25, 17, 3, 2, 18, 15, 9, 12, 14, 23, 19, 8, 22], {3: 2, 4: 5, 5: 150}),
    96: ([4, 8, 21, 19, 20, 3, 18, 5, 15, 16, 24, 2, 14, 23, 17, 25, 6, 11, 12, 10, 9, 1, 22, 13, 7], {3: 2, 4: 6, 5: 150}),
}


def lines():
    rows = [[r * 5 + c for c in range(5)] for r in range(5)]
    cols = [[r * 5 + c for r in range(5)] for c in range(5)]
    diag1 = [i * 5 + i for i in range(5)]          # top left to bottom right
    diag2 = [i * 5 + (4 - i) for i in range(5)]    # top right to bottom left (listed bottom left first in the PHP; only the set matters)
    return rows + cols + [diag1, diag2]


def stream_ints(server_seed_hex, label):
    """Yields 32-bit big-endian integers from the stream HMAC-SHA256(key, label ':' counter)."""
    key = bytes.fromhex(server_seed_hex)
    counter = 0
    while True:
        block = hmac.new(key, f"{label}:{counter}".encode(), hashlib.sha256).digest()
        counter += 1
        for i in range(0, 32, 4):
            yield int.from_bytes(block[i:i + 4], "big")


def holes(server_seed_hex, client_seed, nonce):
    ints = stream_ints(server_seed_hex, f"bingo-pinball:{client_seed}:{nonce}")

    def below(n):
        limit = 2 ** 32 - (2 ** 32 % n)
        while True:
            v = next(ints)
            if v < limit:
                return v % n

    a = list(range(1, 26))
    for i in range(5):
        j = i + below(25 - i)
        a[i], a[j] = a[j], a[i]
    return a[:5]


def evaluate(card, five):
    lit = {card.index(h) for h in five}
    best, best_line = 0, None
    for idx, cells in enumerate(lines()):
        n = sum(1 for c in cells if c in lit)
        if n > best:
            best, best_line = n, idx
    return best, best_line, sorted(lit)


def play(server_seed_hex, client_seed, nonce, version, stake=1):
    card, pays = TABLES[version]
    five = holes(server_seed_hex, client_seed, nonce)
    best, line, lit = evaluate(card, five)
    multiple = pays.get(best, 0)
    return {"holes": five, "bestLit": best, "bestLineIndex": line, "litCells": lit, "multiple": multiple, "payout": multiple * stake}


def make_vectors():
    out = []
    seeds = [hashlib.sha256(f"bingo-pinball test vector seed {i}".encode()).hexdigest() for i in range(6)]
    clients = ["demo", "player-seed_01", "A", "x" * 64, "7f3c9a1e", "lucky_horse"]
    for i, seed in enumerate(seeds):
        for nonce in (1, 2, 3, 17, 1000, 1001):
            client = clients[(i + nonce) % len(clients)]
            v = {"serverSeed": seed, "commit": hashlib.sha256(seed.encode()).hexdigest(), "clientSeed": client, "nonce": nonce, "holes": holes(seed, client, nonce), "versions": {}}
            for version in TABLES:
                r = play(seed, client, nonce, version, 1000)
                v["versions"][str(version)] = {"bestLit": r["bestLit"], "bestLineIndex": r["bestLineIndex"], "multiple": r["multiple"], "payout": r["payout"]}
            out.append(v)
    # make sure the vectors contain a win of every size for every version (the card layout differs per version, so each version needs its own search over nonces)
    seed = seeds[0]
    for version in TABLES:
        want = {3: None, 4: None, 5: None}
        for nonce in range(1, 5000000):
            five = holes(seed, "vector-search", nonce)
            best = evaluate(TABLES[version][0], five)[0]
            if best in want and want[best] is None:
                want[best] = nonce
            if all(want.values()):
                break
        for lit, nonce in sorted(want.items()):
            if nonce is None or any(x["serverSeed"] == seed and x["clientSeed"] == "vector-search" and x["nonce"] == nonce for x in out):
                continue
            v = {"serverSeed": seed, "commit": hashlib.sha256(seed.encode()).hexdigest(), "clientSeed": "vector-search", "nonce": nonce, "holes": holes(seed, "vector-search", nonce), "versions": {}}
            for ver in TABLES:
                r = play(seed, "vector-search", nonce, ver, 1000)
                v["versions"][str(ver)] = {"bestLit": r["bestLit"], "bestLineIndex": r["bestLineIndex"], "multiple": r["multiple"], "payout": r["payout"]}
            out.append(v)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--server-seed")
    ap.add_argument("--client-seed")
    ap.add_argument("--nonce", type=int)
    ap.add_argument("--version", type=int, default=96)
    ap.add_argument("--stake", type=int, default=1)
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--make-vectors", action="store_true")
    a = ap.parse_args()
    if a.make_vectors:
        json.dump({"about": "Known-answer vectors for Bingo Pinball, made by docs/bingo/verify_play.py --make-vectors. Never edited by hand.", "vectors": make_vectors()}, sys.stdout, indent=1)
        print()
        return
    if not (a.server_seed and a.client_seed and a.nonce):
        ap.error("--server-seed, --client-seed and --nonce are needed")
    r = play(a.server_seed, a.client_seed, a.nonce, a.version, a.stake)
    r["commit"] = hashlib.sha256(a.server_seed.encode()).hexdigest()
    print(json.dumps(r) if a.json else r)


if __name__ == "__main__":
    main()
