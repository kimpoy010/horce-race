<?php

namespace App\Console\Commands;

use App\Game\Clients\ClientRegistry;
use App\Game\GameError;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;

/**
 * Manage the clients (platforms) that offer the game (port of scripts/clients.js). A running game picks the change up within seconds.
 *
 *   php artisan clients list
 *   php artisan clients show <id>
 *   php artisan clients add <id> --name="Acme Casino" --wallet-url=https://acme.example/horse-api [--wallet-secret=<16+ chars>] [options]
 *   php artisan clients update <id> [options]
 *   php artisan clients rotate-key <id> [--grace-hours=24]       new API key; the old ones keep working for the grace time (0 = revoke now)
 *   php artisan clients revoke-key <id> <keyId>
 *   php artisan clients rotate-wallet-secret <id> | rotate-webhook-secret <id>
 *   php artisan clients disable <id> | enable <id>                a disabled client's launches and sessions stop working
 *   php artisan clients remove <id> --yes
 *   php artisan clients import <clients.json>                     takes over the clients of the Node server (same HORSE_CLIENTS_KEY as CLIENTS_KEY there)
 *
 * options: --name --currency=PHP --wallet-url --wallet-secret --wallet-key-id --wallet-auth=hmac|bearer --webhook-url --webhook-secret --webhook-events=a,b
 *          --min-bet --max-bet --max-round-stake --daily-loss-limit (minor units) --reality-check-min --big-win-min --ips=a,b --return-hosts=a,b --mock
 */
class ClientsCommand extends Command
{
    protected $signature = 'clients {action=list : list|show|add|update|rotate-key|revoke-key|rotate-wallet-secret|rotate-webhook-secret|disable|enable|remove|import} {id?} {extra?}
        {--name=} {--currency=} {--wallet-url=} {--wallet-secret=} {--wallet-key-id=} {--wallet-auth=} {--webhook-url=} {--webhook-secret=} {--webhook-events=}
        {--min-bet=} {--max-bet=} {--max-round-stake=} {--daily-loss-limit=} {--reality-check-min=} {--big-win-min=} {--ips=} {--return-hosts=} {--mock} {--grace-hours=} {--yes}';

    protected $description = 'Manage the client platforms: list, add, update, rotate keys, disable, remove';

    public function handle(ClientRegistry $reg): int
    {
        $id = $this->argument('id');
        try {
            switch ($this->argument('action')) {
                case 'list':
                    $list = $reg->list();
                    if (! $list) {
                        $this->line('no clients yet. Add one: php artisan clients add <id> --name="..." --wallet-url=https://...');
                    }
                    foreach ($list as $c) {
                        $this->line(str_pad($c['id'], 20).str_pad($c['status'], 10).str_pad($c['currency'] ?? '-', 6).($c['wallet']['type'] === 'mock' ? 'mock wallet' : $c['wallet']['url']).(isset($c['webhook']) ? '   webhook '.$c['webhook']['url'] : ''));
                    }
                    break;
                case 'show':
                    $c = $reg->get($this->need($id)) ?? throw GameError::badClient('unknown client', 404, 'NOT_FOUND');
                    $this->show($reg->publicView($c));
                    break;
                case 'add':
                    $c = $this->build($reg, null);
                    $c['id'] = $this->need($id);
                    if (empty($c['wallet'])) {
                        $this->error('give --wallet-url (or --mock)');

                        return self::FAILURE;
                    }
                    $r = $reg->create($c);
                    $this->show($r['client']);
                    $this->secrets($r);
                    break;
                case 'update':
                    $cur = $reg->get($this->need($id)) ?? throw GameError::badClient('unknown client', 404, 'NOT_FOUND');
                    $this->show($reg->update($id, $this->build($reg, $cur)));
                    break;
                case 'rotate-key':
                    $g = $this->option('grace-hours');
                    $r = $reg->rotateKey($this->need($id), $g === null ? null : (int) round((float) $g * 3600000));
                    $this->secrets($r);
                    $this->line('Old keys: valid for '.($g ?? 24).' h more (list them with: clients show '.$id.').');
                    break;
                case 'revoke-key':
                    $this->show($reg->revokeKey($this->need($id), (string) $this->argument('extra')));
                    break;
                case 'rotate-wallet-secret':
                    $r = $reg->rotateWalletSecret($this->need($id));
                    $this->line("New wallet signing secret (give it to the client at the same time):\n  ".$r['walletSecret']);
                    break;
                case 'rotate-webhook-secret':
                    $r = $reg->rotateWebhookSecret($this->need($id));
                    $this->line("New webhook signing secret:\n  ".$r['webhookSecret']);
                    break;
                case 'disable':
                case 'enable':
                    $reg->setStatus($this->need($id), $this->argument('action') === 'disable' ? 'disabled' : 'active');
                    $this->line($id.($this->argument('action') === 'disable' ? ' disabled' : ' enabled'));
                    break;
                case 'remove':
                    if (! $this->option('yes')) {
                        $this->error('add --yes to remove '.$id.' (use disable to keep the history)');

                        return self::FAILURE;
                    }
                    $reg->remove($this->need($id));
                    $this->line($id.' removed');
                    break;
                case 'import':
                    return $this->import((string) $id);
                default:
                    $this->error('unknown action. See the header of '.__FILE__);

                    return self::FAILURE;
            }
        } catch (GameError $e) {
            $this->error('Error: '.$e->getMessage());

            return self::FAILURE;
        }

        return self::SUCCESS;
    }

    private function need(?string $id): string
    {
        if (! $id) {
            throw GameError::badClient('give the client id');
        }

        return $id;
    }

    private function num(string $name): ?int
    {
        $v = $this->option($name);
        if ($v === null) {
            return null;
        }
        if (! is_numeric($v)) {
            throw GameError::badClient("--$name must be a number");
        }

        return (int) $v;
    }

    private function list(string $v): array
    {
        return array_values(array_filter(array_map('trim', explode(',', $v))));
    }

    private function build(ClientRegistry $reg, ?array $base): array
    {
        $c = [];
        if ($this->option('name') !== null) {
            $c['name'] = (string) $this->option('name');
        }
        if ($this->option('currency') !== null) {
            $c['currency'] = strtoupper((string) $this->option('currency'));
        }
        if ($this->option('mock')) {
            $c['wallet'] = ['type' => 'mock'];
        } elseif ($this->option('wallet-url') || $this->option('wallet-secret') || $this->option('wallet-key-id') || $this->option('wallet-auth')) {
            $w = [];
            foreach (['url' => 'wallet-url', 'secret' => 'wallet-secret', 'keyId' => 'wallet-key-id', 'auth' => 'wallet-auth'] as $k => $o) {
                if ($this->option($o) !== null) {
                    $w[$k] = (string) $this->option($o);
                }
            }
            $c['wallet'] = $w;
        }
        if ($this->option('webhook-url') || $this->option('webhook-secret') || $this->option('webhook-events')) {
            $h = $base['webhook'] ?? [];
            foreach (['url' => 'webhook-url', 'secret' => 'webhook-secret'] as $k => $o) {
                if ($this->option($o) !== null) {
                    $h[$k] = (string) $this->option($o);
                }
            }
            if ($this->option('webhook-events') !== null) {
                $h['events'] = implode(',', $this->list((string) $this->option('webhook-events')));
            }
            $c['webhook'] = $h;
        }
        $lim = [];
        foreach (['minBet' => 'min-bet', 'maxBet' => 'max-bet', 'maxRoundStake' => 'max-round-stake', 'dailyLossLimit' => 'daily-loss-limit'] as $k => $o) {
            if (($v = $this->num($o)) !== null) {
                $lim[$k] = $v;
            }
        }
        if ($lim) {
            $c['limits'] = $lim + ($base['limits'] ?? []);
        }
        if (($v = $this->num('reality-check-min')) !== null) {
            $c['realityCheckMinutes'] = $v;
        }
        if (($v = $this->num('big-win-min')) !== null) {
            $c['bigWinMin'] = $v;
        }
        if ($this->option('ips') !== null) {
            $c['allowedIps'] = $this->list((string) $this->option('ips'));
        }
        if ($this->option('return-hosts') !== null) {
            $c['returnUrlHosts'] = $this->list((string) $this->option('return-hosts'));
        }

        return $c;
    }

    private function show(array $c): void
    {
        $this->line(json_encode($c, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
    }

    private function secrets(array $r): void
    {
        $this->newLine();
        $this->line('API key (shown once, give it to the client; the game keeps only a hash):');
        $this->line('  '.$r['apiKey']);
        if (isset($r['walletSecret'])) {
            $this->line("Wallet signing secret (the client's platform uses it to verify the game's signed wallet calls):");
            $this->line('  '.$r['walletSecret']);
        }
    }

    /** the clients.json of the Node server (secrets encrypted with the same key) */
    private function import(string $file): int
    {
        if (! is_file($file)) {
            $this->error("cannot read $file");

            return self::FAILURE;
        }
        $raw = json_decode((string) file_get_contents($file), true);
        $n = 0;
        foreach ($raw['clients'] ?? [] as $c) {
            foreach (['wallet', 'webhook'] as $k) {
                if (isset($c[$k]['secret'])) {
                    $c[$k]['secret'] = \App\Game\Clients\SecretBox::decrypt($c[$k]['secret'], (string) config('horse.clients_key'));
                }
            }
            $reg = app(ClientRegistry::class);
            $c = $reg->normalize($c);
            if (DB::table('clients')->where('id', $c['id'])->exists()) {
                $this->line($c['id'].': exists, skipped');

                continue;
            }
            $stored = $c;
            foreach (['wallet', 'webhook'] as $k) {
                if (isset($stored[$k]['secret'])) {
                    $stored[$k]['secret'] = \App\Game\Clients\SecretBox::encrypt($stored[$k]['secret'], (string) config('horse.clients_key'));
                }
            }
            DB::table('clients')->insert(['id' => $c['id'], 'status' => $c['status'], 'data' => json_encode($stored, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT), 'created_at' => $c['createdAt'] ?: (int) (microtime(true) * 1000), 'updated_at' => $c['updatedAt'] ?: (int) (microtime(true) * 1000)]);
            $this->line($c['id'].': imported (API keys keep working: only their hashes are stored)');
            $n++;
        }
        $this->info("$n client(s) imported");

        return self::SUCCESS;
    }
}
