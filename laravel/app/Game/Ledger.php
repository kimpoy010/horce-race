<?php

namespace App\Game;

use Illuminate\Support\Facades\DB;

/**
 * Tamper-evident audit log (port of server/ledger.js). Every event is a JSON line that carries a hash covering the line and the
 * hash of the line before it:   h = sha256(previousHash + JSON-of-the-event-without-h)
 * Changing, deleting, inserting or re-ordering any line breaks every hash after it. The lines are the same JSON the Node game wrote
 * (verified in tests/Unit/ParityTest.php), so `node scripts/verify-ledger.js` can check a ledger exported from here.
 *
 * Lines live in the `ledger` table (append-only: a trigger refuses UPDATE and DELETE on PostgreSQL); the newest hash and the line
 * count are kept in `ledger_state` and updated in the same transaction, under a row lock, so two writers can never fork the chain.
 */
final class Ledger
{
    public static function sha(string $s): string
    {
        return hash('sha256', $s);
    }

    /** JSON exactly as JavaScript's JSON.stringify writes it (same key order, no escaped slashes or unicode) */
    public static function json(mixed $v): string
    {
        return json_encode($v, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR);
    }

    /** @param array<string,mixed> $ev  returns the stored line */
    public function append(array $ev): string
    {
        return DB::transaction(function () use ($ev) {
            $st = DB::table('ledger_state')->where('id', 1)->lockForUpdate()->first();
            if (! $st) {
                DB::table('ledger_state')->insert(['id' => 1, 'head' => self::sha(''), 'lines' => 0]);
                $st = DB::table('ledger_state')->where('id', 1)->lockForUpdate()->first();
            }
            $h = self::sha($st->head.self::json($ev));
            $line = self::json($ev + ['h' => $h]);
            DB::table('ledger')->insert(['line' => $line]);
            DB::table('ledger_state')->where('id', 1)->update(['head' => $h, 'lines' => $st->lines + 1]);

            return $line;
        });
    }

    public function head(): string
    {
        return DB::table('ledger_state')->where('id', 1)->value('head') ?? self::sha('');
    }

    public function lines(): int
    {
        return (int) (DB::table('ledger_state')->where('id', 1)->value('lines') ?? 0);
    }

    /** @return array{ok:bool,lines:int,chained:int,legacy:int,head:?string,broken:?array} */
    public static function verifyLines(iterable $lines): array
    {
        $res = ['ok' => true, 'lines' => 0, 'chained' => 0, 'legacy' => 0, 'head' => null, 'broken' => null];
        $legacy = '';
        $started = false;
        $head = null;
        $n = 0;
        foreach ($lines as $raw) {
            $n++;
            if ($raw === '' || $raw === null) {
                continue;
            }
            $res['lines']++;
            $ev = json_decode($raw, true);
            if (! is_array($ev)) {
                $res['ok'] = false;
                $res['broken'] = ['line' => $n, 'reason' => 'unreadable line'];
                break;
            }
            if (! isset($ev['h']) || ! is_string($ev['h'])) {
                if ($started) {
                    $res['ok'] = false;
                    $res['broken'] = ['line' => $n, 'reason' => 'line without a hash inside the chain'];
                    break;
                }
                $legacy .= $raw."\n";
                $res['legacy']++;

                continue;
            }
            if (! $started) {
                $started = true;
                $head = self::sha($legacy);
            }
            $h = $ev['h'];
            // the line is re-built from the stored text (not from the decoded array) so number formats cannot change the hash
            $body = self::stripHash($raw);
            if (self::sha($head.$body) !== $h) {
                $res['ok'] = false;
                $res['broken'] = ['line' => $n, 'reason' => 'hash does not match (line changed, or lines removed / inserted before it)'];
                break;
            }
            $head = $h;
            $res['chained']++;
        }
        $res['head'] = $res['broken'] ? null : ($started ? $head : self::sha($legacy));

        return $res;
    }

    /** the stored line without its trailing ,"h":"<hash>" (the hash is always the last key) */
    public static function stripHash(string $line): string
    {
        return preg_replace('/,"h":"[0-9a-f]{64}"\}$/', '}', $line);
    }

    /** @return array{ok:bool,lines:int,chained:int,legacy:int,head:?string,broken:?array} */
    public function verify(): array
    {
        return self::verifyLines(DB::table('ledger')->orderBy('seq')->pluck('line'));
    }
}
