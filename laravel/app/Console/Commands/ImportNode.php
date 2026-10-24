<?php

namespace App\Console\Commands;

use App\Game\Clients\ClientRegistry;
use App\Game\Engine;
use App\Game\Ledger;
use App\Game\Odds;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\Artisan;
use Illuminate\Support\Facades\DB;

/**
 * Takes over the data of the Node server (cutover, see ../docs/CUTOVER.md). Stop the Node server cleanly first (SIGTERM), then:
 *
 *   php artisan import:node --dir=/path/to/data [--dry-run]
 *
 * - checks the ledger hash chain and refuses a broken one (nothing is written)
 * - copies the ledger line by line, so the chain simply continues: the first Laravel line is hashed onto the last Node line
 * - rebuilds the races (seed, commit, odds, draw, result: the draw proofs keep working), the bets and the player history from it
 * - rebuilds what is still owed: wins / refunds not yet confirmed by the wallet, rollbacks, webhook events
 * - a race that was still taking bets is cancelled and every stake goes back (as the Node server does after a restart); a race that was drawn
 *   but not settled is left to the round loop, which settles it
 * - takes over the clients (needs the same HORSE_CLIENTS_KEY as CLIENTS_KEY on the Node server), the block list and the RTP setting
 * Race numbers continue where the Node server stopped, so no wallet transaction id is ever used twice. Player sessions are not carried over:
 * players open the game again. Staff passwords cannot be carried over (a different hash): reset them with `php artisan staff reset-password`.
 */
class ImportNode extends Command
{
    protected $signature = 'import:node {--dir= : the Node server\'s data directory (ledger.jsonl, clients.json, blocked.json, settings.json)} {--dry-run : read and check everything, write nothing}';

    protected $description = 'Take over the ledger, races, bets, clients and block list of the Node server';

    public function handle(Engine $engine): int
    {
        $dir = rtrim((string) ($this->option('dir') ?: base_path('../data')), '/');
        $file = $dir.'/ledger.jsonl';
        if (! is_file($file)) {
            $this->error("no ledger at $file");

            return self::FAILURE;
        }
        $lines = array_values(array_filter(explode("\n", (string) file_get_contents($file)), fn ($l) => $l !== ''));
        $v = Ledger::verifyLines($lines);
        if (! $v['ok']) {
            $this->error('the hash chain of '.$file.' is broken at line '.$v['broken']['line'].' ('.$v['broken']['reason'].'): fix or restore it first (node scripts/verify-ledger.js). Nothing was written.');

            return self::FAILURE;
        }
        $this->line('ledger:   '.count($lines).' lines, chain intact, head '.$v['head']);
        if (DB::table('rounds')->exists() || DB::table('ledger')->exists()) {
            $this->error('this database already has races or ledger lines: import into an empty database (php artisan migrate:fresh) so the two ledgers cannot mix.');

            return self::FAILURE;
        }
        $dry = (bool) $this->option('dry-run');
        $result = null;
        try {
            DB::transaction(function () use ($lines, $v, $dir, $engine, $dry, &$result) {
                $result = $this->import($lines, $v, $dir, $engine);
                if ($dry) {
                    throw new \RuntimeException('dry-run');
                }
            });
        } catch (\RuntimeException $e) {
            if ($e->getMessage() !== 'dry-run') {
                throw $e;
            }
        }
        $r = $result;
        $this->line(sprintf('races:    %d (%d settled, %d drawn but not settled, %d cancelled)', $r['rounds'], $r['settled'], $r['racing'], $r['voided']));
        $this->line(sprintf('bets:     %d, %d stakes refunded for the cancelled race(s)', $r['bets'], $r['refunded']));
        $this->line(sprintf('owed:     %d credit(s), %d rollback(s), %d webhook event(s) still to deliver', $r['credits'], $r['rollbacks'], $r['webhooks']));
        $this->line(sprintf('clients:  %s; blocked players: %d; RTP setting: %s', $r['clients'], $r['blocked'], $r['rtp'] ?? 'default'));
        if ($dry) {
            $this->info('dry run: nothing was written');

            return self::SUCCESS;
        }
        $check = $engine->ledger()->verify();
        if (! $check['ok']) {
            $this->error('the ledger does not verify after the import: '.json_encode($check['broken']));

            return self::FAILURE;
        }
        $this->info('done. ledger head '.$check['head'].' ('.$check['lines'].' lines): start the round loop (php artisan game:run).');

        return self::SUCCESS;
    }

    private function import(array $lines, array $v, string $dir, Engine $engine): array
    {
        // 1. the ledger itself: the same lines, so the Node server's hashes carry on
        foreach (array_chunk($lines, 500) as $chunk) {
            DB::table('ledger')->insert(array_map(fn ($l) => ['line' => $l], $chunk));
        }
        DB::table('ledger_state')->insert(['id' => 1, 'head' => $v['head'], 'lines' => count($lines)]);

        // 2. replay the events
        $rounds = [];
        $bets = [];
        $credits = [];
        $creditOk = [];
        $rb = [];
        $rbDone = [];
        $wh = [];
        $whDone = [];
        foreach ($lines as $line) {
            $ev = json_decode($line, true);
            $r = $ev['raceNo'] ?? null;
            switch ($ev['e'] ?? '') {
                case 'open':
                    $rounds[$r] = ['race_no' => $r, 'seed' => $ev['seed'], 'commit' => $ev['commit'], 'odds' => json_encode($ev['odds']), 'rtp' => $ev['rtp'], 'open_at' => $ev['openAt'], 'bet_close_at' => $ev['betCloseAt'], 'status' => 'betting',
                        'combo' => null, 'order' => null, 'anim_seed' => null, 'start_at' => null, 'settled_at' => null, 'staked' => 0, 'paid' => 0];
                    break;
                case 'bet':
                    if (isset($rounds[$r])) {
                        $pk = (string) $ev['playerId'];
                        $bets[$ev['id']] = ['id' => $ev['id'], 'race_no' => $r, 'player_key' => $pk, 'combo' => $ev['combo'], 'stake' => $ev['stake'], 'status' => 'open', 'payout' => 0, 'currency' => $ev['currency'] ?? config('horse.currency'),
                            'brand_id' => $ev['brandId'] ?? null, 'placed_at' => $ev['t'], 'client_id' => Engine::splitPk($pk)[0]];
                    }
                    break;
                case 'draw':
                    if (isset($rounds[$r])) {
                        $rounds[$r] = ['status' => 'racing', 'combo' => $ev['combo'], 'order' => json_encode($ev['order']), 'anim_seed' => $ev['animSeed'], 'start_at' => $ev['startAt']] + $rounds[$r];
                    }
                    break;
                case 'settled':
                    if (isset($rounds[$r])) {
                        $rounds[$r] = ['status' => 'settled', 'staked' => $ev['staked'], 'paid' => $ev['paid'], 'settled_at' => $ev['t']] + $rounds[$r];
                    }
                    break;
                case 'void':
                    if (isset($rounds[$r])) {
                        $rounds[$r]['status'] = 'void';
                    }
                    break;
                case 'credit_due':
                    $credits[$ev['txId']] = $ev;
                    break;
                case 'credit_ok':
                    $creditOk[$ev['txId']] = true;
                    break;
                case 'rollback_due':
                    $rb[$ev['txId']] = $ev;
                    break;
                case 'rollback_ok':
                case 'rollback_unsupported':
                    $rbDone[$ev['txId']] = true;
                    break;
                case 'webhook_due':
                    $wh[$ev['ev']['id']] = $ev['ev'];
                    break;
                case 'webhook_ok':
                case 'webhook_dropped':
                    $whDone[$ev['id']] = true;
                    break;
            }
        }
        // 3. results of every bet of a settled race, the way the Node server works them out
        $out = ['rounds' => 0, 'settled' => 0, 'racing' => 0, 'voided' => 0, 'bets' => count($bets), 'refunded' => 0, 'credits' => 0, 'rollbacks' => 0, 'webhooks' => 0, 'clients' => 'none', 'blocked' => 0, 'rtp' => null];
        foreach ($bets as &$b) {
            $rd = $rounds[$b['race_no']];
            if ($rd['status'] === 'settled') {
                $o = json_decode($rd['odds'], true);
                $won = $b['combo'] === $rd['combo'];
                $b['status'] = $won ? 'won' : 'lost';
                $b['payout'] = $won ? Engine::payoutFor($b['stake'], $o[$b['combo']]) : 0;
            } elseif ($rd['status'] === 'void') {
                $b['status'] = 'refunded';
            }
        }
        unset($b);
        ksort($rounds);
        foreach ($rounds as $rd) {
            DB::table('rounds')->insert($rd);
        }
        $out['rounds'] = count($rounds);
        foreach (array_chunk(array_values($bets), 500) as $chunk) {
            DB::table('bets')->insert($chunk);
        }
        foreach ($credits as $txId => $ev) {
            if (! isset($creditOk[$txId])) {
                DB::table('pending_ops')->insert(['tx_id' => $txId, 'kind' => 'credit', 'player_key' => $ev['playerId'], 'amount' => $ev['amount'], 'race_no' => $ev['raceNo'], 'tx_kind' => $ev['kind'],
                    'extra' => json_encode($ev['extra'] ?? new \stdClass), 'since' => $ev['t'], 'tries' => 0, 'next_at' => 0]);
                $out['credits']++;
            }
        }
        foreach ($rb as $txId => $ev) {
            if (! isset($rbDone[$txId])) {
                DB::table('pending_ops')->insert(['tx_id' => 'rb:'.$txId, 'kind' => 'rollback', 'player_key' => $ev['playerId'], 'amount' => $ev['amount'], 'race_no' => $ev['raceNo'],
                    'extra' => json_encode($ev['extra'] ?? new \stdClass), 'since' => $ev['t'], 'tries' => 0, 'next_at' => 0]);
                $out['rollbacks']++;
            }
        }
        foreach ($wh as $id => $ev) {
            if (! isset($whDone[$id])) {
                DB::table('pending_ops')->insert(['tx_id' => $id, 'kind' => 'webhook', 'player_key' => '', 'amount' => 0, 'race_no' => $ev['data']['raceNo'] ?? null,
                    'extra' => json_encode($ev, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE), 'since' => $ev['createdAt'], 'tries' => 0, 'next_at' => 0]);
                $out['webhooks']++;
            }
        }

        // 4. settings, block list, clients
        if (is_file($dir.'/settings.json')) {
            $st = json_decode((string) file_get_contents($dir.'/settings.json'), true);
            if (isset($st['rtp']) && $st['rtp'] >= Odds::MIN_RTP && $st['rtp'] <= Odds::MAX_RTP) {
                DB::table('settings')->insert(['key' => 'rtp', 'value' => (string) $st['rtp']]);
                $out['rtp'] = $st['rtp'];
            }
        }
        if (is_file($dir.'/blocked.json')) {
            foreach ((array) json_decode((string) file_get_contents($dir.'/blocked.json'), true) as $pk) {
                DB::table('blocked_players')->insertOrIgnore(['player_key' => $pk, 'who' => 'node-import']);
                $out['blocked']++;
            }
        }
        if (is_file($dir.'/clients.json')) {
            Artisan::call('clients', ['action' => 'import', 'id' => $dir.'/clients.json']);
            $out['clients'] = (string) DB::table('clients')->count();
            app(ClientRegistry::class)->forgetAll();
        }
        $engine->rebuildRtpTrack();

        // 5. a race that was still taking bets is cancelled (the Node server does the same after a restart): every stake goes back
        $last = DB::table('rounds')->orderByDesc('race_no')->first();
        if ($last && $last->status === 'betting') {
            $out['refunded'] = $engine->voidRound($last->race_no, 'cutover');
            $out['voided']++;
            $out['credits'] += DB::table('pending_ops')->where('tx_id', 'like', 'refund:'.$last->race_no.':%')->count();
        }
        $out['racing'] = (int) DB::table('rounds')->where('status', 'racing')->count();
        $out['settled'] = (int) DB::table('rounds')->where('status', 'settled')->count();
        $out['voided'] = (int) DB::table('rounds')->where('status', 'void')->count();

        return $out;
    }
}
