<?php

namespace App\Game;

use Closure;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;

/**
 * Alerts: rules over the numbers of the game (port of server/alerts.js), evaluated every few seconds by the daemon and every minute by
 * `php artisan alerts:check` (so a dead daemon is reported too). An alert fires when its condition starts, is repeated while it lasts, and
 * resolves when it ends. Every change is written to the log and, with HORSE_ALERT_WEBHOOK_URL, posted as JSON
 * ({ text, status, name, severity, message, since, at, id }; `text` makes it work with Slack / Teams / Discord style incoming webhooks).
 */
final class AlertManager
{
    public function __construct(private Engine $engine, private array $cfg, private ?string $webhookUrl = null, private ?Closure $clock = null) {}

    public function now(): int
    {
        return $this->clock ? ($this->clock)() : $this->engine->now();
    }

    /** what the rules look at */
    private function context(): array
    {
        $snap = $this->engine->opsSnapshot();
        $tick = Cache::get('horse:tick');
        $clients = DB::table('wallet_calls')->where('at', '>=', $this->engine->now() - 300000)->distinct()->pluck('client')->all();
        $perClient = [];
        foreach ($clients as $c) {
            $perClient[$c] = $this->engine->walletWindow(300000, $c);
        }
        $dir = storage_path();

        return ['snapshot' => $snap, 'wallet' => $this->engine->walletWindow(300000), 'walletClients' => $perClient, 'tickAge' => $tick === null ? null : max(0, ($this->engine->now() - $tick) / 1000),
            'diskFreeMb' => ($f = @disk_free_space($dir)) === false ? null : $f / 1048576];
    }

    /** @return list<array{name:string,severity:string,message:string}> */
    public function rules(array $ctx): array
    {
        $cfg = $this->cfg;
        $snap = $ctx['snapshot'];
        $list = [];
        $add = function (string $name, string $severity, bool $bad, string $message) use (&$list) {
            if ($bad) {
                $list[] = ['name' => $name, 'severity' => $severity, 'message' => $message];
            }
        };
        $min = fn ($s) => round($s / 60);
        $add('ledger_broken', 'critical', ! $snap['ledger']['ok'], 'the audit ledger hash chain is broken'.($snap['ledger']['broken'] ? ' at line '.$snap['ledger']['broken']['line'].': '.$snap['ledger']['broken']['reason'] : ''));
        $stalled = $ctx['tickAge'] === null || $ctx['tickAge'] > $cfg['tickStallSeconds'];
        $add('round_loop_stalled', 'critical', $stalled, $ctx['tickAge'] === null ? 'the round loop is not running (php artisan game:run)' : 'the round loop has not run for '.round($ctx['tickAge']).' s');
        $p = $snap['pending'];
        $add('credits_stuck', 'critical', $p['credits']['count'] > 0 && $p['credits']['oldestSeconds'] > $cfg['creditMinutes'] * 60,
            $p['credits']['count'].' win/refund credit(s) not delivered to the wallet, the oldest for '.$min($p['credits']['oldestSeconds']).' min');
        $add('rollbacks_stuck', 'critical', $p['rollbacks']['count'] > 0 && $p['rollbacks']['oldestSeconds'] > $cfg['rollbackMinutes'] * 60,
            $p['rollbacks']['count'].' rollback(s) not confirmed by the wallet, the oldest for '.$min($p['rollbacks']['oldestSeconds']).' min (a player may be charged for a bet that was not placed)');
        $add('webhooks_stuck', 'warning', $p['webhooks']['count'] > 0 && $p['webhooks']['oldestSeconds'] > $cfg['webhookMinutes'] * 60,
            $p['webhooks']['count'].' webhook event(s) not accepted by the platform, the oldest for '.$min($p['webhooks']['oldestSeconds']).' min');
        // one wallet per client: judge each client's wallet on its own, so a healthy client cannot hide a failing one
        $wins = $ctx['walletClients'] ?: ['default' => $ctx['wallet']];
        $single = count($wins) === 1 && isset($wins['default']);
        foreach ($wins as $cid => $w) {
            $sfx = $single ? '' : ':'.$cid;
            $who = $single ? 'wallet' : 'wallet of client '.$cid;
            $add('wallet_failing'.$sfx, 'critical', $w['calls'] >= 5 && $w['failRate'] > $cfg['walletFailRate'], $who.' calls failing: '.round($w['failRate'] * 100).'% of '.$w['calls'].' in the last 5 minutes');
            $add('wallet_slow'.$sfx, 'warning', $w['calls'] >= 5 && $w['p95'] > $cfg['walletP95Ms'], $who.' is slow: the slowest 5% of calls took over '.round($w['p95']).' ms in the last 5 minutes');
        }
        $z = (float) $snap['rtpZ'];
        $add('rtp_drift', 'warning', $snap['rounds'] >= $cfg['rtpMinRounds'] && abs($z) > $cfg['rtpZ'],
            'payouts are '.number_format($z, 1).' standard deviations '.($z > 0 ? 'above' : 'below').' what the odds predict for the bets placed ('.$snap['rounds'].' races)');
        if ($ctx['diskFreeMb'] !== null) {
            $add('disk_low', 'critical', $ctx['diskFreeMb'] < $cfg['diskFreeMb'], 'only '.round($ctx['diskFreeMb']).' MB free where the database and logs are kept');
        }

        return $list;
    }

    /** the alerts that are true right now (what the overview shows), with the time each one started */
    public function current(): array
    {
        $since = DB::table('alerts_active')->pluck('since', 'name');
        $t = $this->now();

        return array_map(fn ($a) => $a + ['since' => (int) ($since[$a['name']] ?? $t)], $this->rules($this->context()));
    }

    /** looks at the rules, writes the changes (firing, still active, resolved) and sends them; returns the active alerts */
    public function evaluate(): array
    {
        $t = $this->now();
        $current = $this->rules($this->context());
        $names = array_column($current, 'name');
        $active = DB::table('alerts_active')->get()->keyBy('name');
        foreach ($current as $a) {
            $prev = $active[$a['name']] ?? null;
            if (! $prev) {
                DB::table('alerts_active')->insert($a + ['since' => $t, 'last_notified' => $t]);
                $this->send('firing', $a + ['since' => $t]);
            } else {
                DB::table('alerts_active')->where('name', $a['name'])->update(['message' => $a['message']]);
                if ($t - $prev->last_notified >= $this->cfg['repeatMinutes'] * 60000) {
                    DB::table('alerts_active')->where('name', $a['name'])->update(['last_notified' => $t]);
                    $this->send('firing', ['name' => $a['name'], 'severity' => $prev->severity, 'message' => $a['message'], 'since' => (int) $prev->since], true);
                }
            }
        }
        foreach ($active as $name => $a) {
            if (! in_array($name, $names, true)) {
                DB::table('alerts_active')->where('name', $name)->delete();
                $this->send('resolved', ['name' => $name, 'severity' => $a->severity, 'message' => $a->message, 'since' => (int) $a->since]);
            }
        }

        return $this->list();
    }

    /** @return list<array{name:string,severity:string,message:string,since:int}> */
    public function list(): array
    {
        return DB::table('alerts_active')->orderBy('since')->get()->map(fn ($a) => ['name' => $a->name, 'severity' => $a->severity, 'message' => $a->message, 'since' => (int) $a->since])->all();
    }

    /** the latest changes, newest first */
    public function recent(int $n = 10): array
    {
        return DB::table('alert_history')->orderByDesc('id')->limit($n)->get()->map(fn ($r) => json_decode($r->event, true))->all();
    }

    private function send(string $status, array $a, bool $reminder = false): void
    {
        $text = ($status === 'firing' ? ($a['severity'] === 'critical' ? '[CRITICAL] ' : '[WARNING] ') : '[RESOLVED] ').'Horse Race: '.$a['name'].($reminder ? ' (still active)' : '').' - '.$a['message'];
        $ev = ['id' => $a['name'].':'.$a['since'], 'status' => $status, 'name' => $a['name'], 'severity' => $a['severity'], 'message' => $a['message'], 'since' => $a['since'], 'at' => $this->now(), 'reminder' => $reminder, 'text' => $text];
        DB::table('alert_history')->insert(['at' => $ev['at'], 'event' => json_encode($ev, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE)]);
        DB::table('alert_history')->where('id', '<=', (int) DB::table('alert_history')->max('id') - 100)->delete();
        Log::channel(config('logging.default'))->warning('ALERT '.$text);
        if ($this->webhookUrl) {
            try {
                Http::timeout(3)->asJson()->post($this->webhookUrl, $ev);
            } catch (\Throwable $e) {
                // a webhook that is away must not stop the game
            }
        }
    }
}
