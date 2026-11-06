<?php

namespace App\Game;

use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;

/** Prometheus text rendering of the game state (GET /metrics, operator key as X-Controller-Key or Bearer token). Names follow the Node server's /metrics. */
final class Metrics
{
    private const BUCKETS = [50 => '0.05', 100 => '0.1', 250 => '0.25', 500 => '0.5', 1000 => '1', 2500 => '2.5', 5000 => '5', 10000 => '10'];

    private static function esc(string $v): string
    {
        return str_replace(['\\', '"', "\n"], ['\\\\', '\\"', '\\n'], $v);
    }

    private static function line(string $name, int|float $value, array $labels = []): string
    {
        $l = $labels ? '{'.implode(',', array_map(fn ($k, $v) => $k.'="'.self::esc((string) $v).'"', array_keys($labels), $labels)).'}' : '';

        return $name.$l.' '.(is_finite((float) $value) ? $value : 0);
    }

    /** @param list<array> $alerts the firing alerts */
    public static function render(Engine $engine, array $alerts = []): string
    {
        $out = [];
        $help = function (string $n, string $t, string $ty = 'gauge') use (&$out) {
            $out[] = '# HELP '.$n.' '.$t;
            $out[] = '# TYPE '.$n.' '.$ty;
        };
        $rep = $engine->opsSnapshot();
        $health = $engine->health();
        $tick = Cache::get('horse:tick');
        $started = Cache::get('horse:started');

        $help('horse_up', 'the game application answers');
        $out[] = self::line('horse_up', 1);
        $help('horse_role', 'active = the round loop runs, down = it does not (see horse_tick_age_seconds)');
        $out[] = self::line('horse_role', 1, ['role' => $health['ok'] ? 'active' : 'down']);
        $help('process_uptime_seconds', 'seconds since the round loop (php artisan game:run) started');
        $out[] = self::line('process_uptime_seconds', $started ? max(0, ($engine->now() - $started) / 1000) : 0);
        $help('horse_tick_age_seconds', 'seconds since the round loop last completed (should stay under 1)');
        $out[] = self::line('horse_tick_age_seconds', $tick === null ? 999999 : max(0, ($engine->now() - $tick) / 1000));
        $help('horse_round_number', 'current race number');
        $out[] = self::line('horse_round_number', $rep['round']);
        $help('horse_rounds_total', 'settled races', 'counter');
        $out[] = self::line('horse_rounds_total', $rep['rounds']);
        $help('horse_bets_total', 'bets placed in settled races', 'counter');
        $out[] = self::line('horse_bets_total', $rep['bets']);
        $help('horse_staked_total', 'amount staked (minor units) in settled races', 'counter');
        $help('horse_paid_total', 'amount paid out (minor units) in settled races', 'counter');
        foreach ((array) $rep['byCurrency'] as $c => $v) {
            $out[] = self::line('horse_staked_total', $v['staked'], ['currency' => $c]);
            $out[] = self::line('horse_paid_total', $v['paid'], ['currency' => $c]);
        }
        $help('horse_rtp_setting', 'RTP setting');
        $out[] = self::line('horse_rtp_setting', $rep['rtpSetting']);
        $help('horse_rtp_actual', 'paid / staked since the start');
        $out[] = self::line('horse_rtp_actual', $rep['rtpActual'] ?? 0);
        $help('horse_rtp_zscore', 'how many standard deviations the payouts are from what the odds predict for the bets placed');
        $out[] = self::line('horse_rtp_zscore', $rep['rtpZ']);
        $help('horse_sessions_active', 'player sessions');
        $out[] = self::line('horse_sessions_active', $rep['sessions']);
        $help('horse_pending_credits', 'wins and refunds not yet confirmed by the wallet');
        $out[] = self::line('horse_pending_credits', $rep['pending']['credits']['count']);
        $help('horse_pending_rollbacks', 'rollbacks not yet confirmed by the wallet');
        $out[] = self::line('horse_pending_rollbacks', $rep['pending']['rollbacks']['count']);
        $help('horse_pending_webhooks', 'webhook events not yet accepted by the platform');
        $out[] = self::line('horse_pending_webhooks', $rep['pending']['webhooks']['count']);
        $help('horse_pending_oldest_seconds', 'age of the oldest unconfirmed item');
        foreach (['credits', 'rollbacks', 'webhooks'] as $k) {
            $out[] = self::line('horse_pending_oldest_seconds', $rep['pending'][$k]['oldestSeconds'], ['queue' => $k]);
        }
        $help('horse_ledger_ok', '1 when the ledger hash chain is intact');
        $out[] = self::line('horse_ledger_ok', $rep['ledger']['ok'] ? 1 : 0);
        $help('horse_ledger_lines', 'ledger lines');
        $out[] = self::line('horse_ledger_lines', $rep['ledger']['lines']);

        $stats = DB::table('wallet_stats')->orderBy('client')->orderBy('op')->get();
        $help('horse_wallet_calls_total', 'wallet calls by result', 'counter');
        foreach ($stats as $c) {
            $out[] = self::line('horse_wallet_calls_total', $c->ok, ['client' => $c->client, 'op' => $c->op, 'result' => 'ok']);
            $out[] = self::line('horse_wallet_calls_total', $c->fail, ['client' => $c->client, 'op' => $c->op, 'result' => 'fail']);
        }
        $help('horse_wallet_latency_seconds', 'wallet call duration', 'histogram');
        foreach ($stats as $c) {
            $l = ['client' => $c->client, 'op' => $c->op];
            foreach (self::BUCKETS as $ms => $le) {
                $out[] = self::line('horse_wallet_latency_seconds_bucket', $c->{'le'.$ms}, ['le' => $le] + $l);
            }
            $n = $c->ok + $c->fail;
            $out[] = self::line('horse_wallet_latency_seconds_bucket', $n, ['le' => '+Inf'] + $l);
            $out[] = self::line('horse_wallet_latency_seconds_sum', $c->sum_ms / 1000, $l);
            $out[] = self::line('horse_wallet_latency_seconds_count', $n, $l);
        }

        $help('horse_client_staked_total', 'amount staked (minor units) per client', 'counter');
        $help('horse_client_paid_total', 'amount paid out (minor units) per client', 'counter');
        $help('horse_client_bets_total', 'bets per client', 'counter');
        $per = DB::table('bets')->whereIn('status', ['won', 'lost'])->groupBy('client_id')->selectRaw('client_id, count(*) as n, sum(stake) as s, sum(payout) as p')->orderBy('client_id')->get();
        foreach ($per as $c) {
            $out[] = self::line('horse_client_staked_total', (int) $c->s, ['client' => $c->client_id]);
            $out[] = self::line('horse_client_paid_total', (int) $c->p, ['client' => $c->client_id]);
            $out[] = self::line('horse_client_bets_total', (int) $c->n, ['client' => $c->client_id]);
        }
        // one set per game (Phase 5): the names above are the horse race's and stay as they are
        $reports = app(\App\Games\GameReports::class)->summary();
        $help('horse_game_plays_total', 'settled plays (a bet of the horse race, a play of an instant game) per game', 'counter');
        $help('horse_game_staked_total', 'amount staked (minor units) per game and currency', 'counter');
        $help('horse_game_paid_total', 'amount paid out (minor units) per game and currency', 'counter');
        $help('horse_game_rtp_actual', 'paid / staked since the start, per game');
        $help('horse_game_rtp_theoretical', 'the return the maths predicts for the plays made, per game');
        $help('horse_game_rtp_zscore', 'how many standard deviations the payouts are from what the maths predicts, per game');
        $help('horse_game_hit_frequency', 'share of plays that won, per game (instant games)');
        $help('horse_game_pending_credits', 'wins and refunds not yet confirmed by the wallet, per game');
        $help('horse_game_pending_rollbacks', 'rollbacks not yet confirmed by the wallet, per game');
        $help('horse_game_pending_oldest_seconds', 'age of the oldest unconfirmed credit or rollback, per game');
        foreach ($reports as $g) {
            $l = ['game' => $g['game']];
            $out[] = self::line('horse_game_plays_total', $g['plays'], $l);
            foreach ((array) $g['byCurrency'] as $c => $v) {
                $out[] = self::line('horse_game_staked_total', $v['staked'], $l + ['currency' => $c]);
                $out[] = self::line('horse_game_paid_total', $v['paid'], $l + ['currency' => $c]);
            }
            $out[] = self::line('horse_game_rtp_actual', $g['rtpActual'] ?? 0, $l);
            $out[] = self::line('horse_game_rtp_theoretical', $g['rtpTheoretical'] ?? 0, $l);
            $out[] = self::line('horse_game_rtp_zscore', $g['rtpZ'] ?? 0, $l);
            if (isset($g['hitFrequency'])) {
                $out[] = self::line('horse_game_hit_frequency', $g['hitFrequency'], $l);
            }
            $out[] = self::line('horse_game_pending_credits', $g['pending']['credits']['count'], $l);
            $out[] = self::line('horse_game_pending_rollbacks', $g['pending']['rollbacks']['count'], $l);
            $out[] = self::line('horse_game_pending_oldest_seconds', max($g['pending']['credits']['oldestSeconds'], $g['pending']['rollbacks']['oldestSeconds']), $l);
        }
        // Fruit Game: its double-ups (an even chance) and the wins still held
        $fr = $reports[\App\Games\GameReports::FRUIT];
        $help('horse_fruit_doubles_total', 'double-ups played in Fruit Game');
        $help('horse_fruit_doubles_won_total', 'double-ups that were right');
        $help('horse_fruit_double_zscore', 'how many standard deviations the double-ups won are from 50%');
        $help('horse_fruit_open_rounds', 'wins held and not yet collected');
        $help('horse_fruit_open_oldest_seconds', 'age of the oldest held win');
        $out[] = self::line('horse_fruit_doubles_total', $fr['doubles']['count'], ['game' => $fr['game']]);
        $out[] = self::line('horse_fruit_doubles_won_total', $fr['doubles']['won'], ['game' => $fr['game']]);
        $out[] = self::line('horse_fruit_double_zscore', $fr['doubles']['z'], ['game' => $fr['game']]);
        $out[] = self::line('horse_fruit_open_rounds', $fr['open']['count'], ['game' => $fr['game']]);
        $out[] = self::line('horse_fruit_open_oldest_seconds', $fr['open']['oldestSeconds'], ['game' => $fr['game']]);
        // the progressive jackpot of Bingo Pinball 16 (one pool per currency for the whole server)
        $b16 = $reports[\App\Games\GameReports::BINGO16];
        $help('horse_jackpot_pool', 'the jackpot pool now (minor units), per game and currency');
        $help('horse_jackpot_wins_total', 'jackpots won so far', 'counter');
        $help('horse_jackpot_contributed_total', 'stake contributions put into the pool so far (minor units)', 'counter');
        $help('horse_jackpot_paid_total', 'jackpots paid out so far (minor units)', 'counter');
        $help('horse_jackpot_seeded_total', 'seed money put in by the operator so far (minor units): the first seed and every re-seed after a win', 'counter');
        $help('horse_jackpot_balanced', '1 when pool = seed money + contributions - jackpots paid');
        $help('horse_jackpot_zscore', 'how many standard deviations the number of jackpots won is from what the PAR sheet predicts');
        foreach ((array) $b16['pools'] as $cur => $pl) {
            $l = ['game' => $b16['game'], 'currency' => $cur];
            $out[] = self::line('horse_jackpot_pool', $pl['amount'], $l);
            $out[] = self::line('horse_jackpot_wins_total', $pl['wins'], $l);
            $out[] = self::line('horse_jackpot_contributed_total', $pl['contributed'], $l);
            $out[] = self::line('horse_jackpot_paid_total', $pl['paid'], $l);
            $out[] = self::line('horse_jackpot_seeded_total', $pl['seeded'], $l);
            $out[] = self::line('horse_jackpot_balanced', $pl['balanced'] ? 1 : 0, $l);
        }
        $out[] = self::line('horse_jackpot_zscore', $b16['jackpotZ'], ['game' => $b16['game']]);
        $help('horse_alert_firing', '1 for every active alert');
        foreach ($alerts as $a) {
            $out[] = self::line('horse_alert_firing', 1, ['name' => $a['name'], 'severity' => $a['severity']]);
        }

        return implode("\n", $out)."\n";
    }
}
