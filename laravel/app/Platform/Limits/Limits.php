<?php

namespace App\Platform\Limits;

use Closure;
use Illuminate\Support\Facades\DB;

/**
 * The limits a player plays under (minimum and maximum bet, maximum stake per round, daily loss limit) and what the player has staked and lost today.
 * Moved out of the Engine unchanged. The daily figures count the horse race's bets today; a second game adds its own rounds here so that the daily loss limit
 * is shared by every game.
 */
final class Limits
{
    /** @param Closure(): int $now the clock in milliseconds */
    public function __construct(private Closure $now, private array $cfg) {}

    /**
     * The limits of a session: the server's defaults, then the table of the currency, the client's settings, the client's table of the currency and last whatever the
     * platform sent for this player (later wins; only valid numbers count).
     */
    public function for(string $currency, ?array $info, array $client = []): array
    {
        $base = ['minBet' => $this->cfg['min_bet'], 'maxBet' => $this->cfg['max_bet'], 'maxRoundStake' => $this->cfg['max_round_stake'], 'dailyLossLimit' => $this->cfg['daily_loss_limit'] ?: 0];
        $pos = fn ($v) => is_int($v) && $v > 0;
        foreach ([($this->cfg['currency_limits'][$currency] ?? null), $client['limits'] ?? null, ($client['currencyLimits'][$currency] ?? null), $info['limits'] ?? null] as $src) {      // server table, the client's settings, then
            if (! is_array($src)) {
                continue;
            }
            foreach (['minBet', 'maxBet', 'maxRoundStake'] as $k) {
                if ($pos($src[$k] ?? null)) {
                    $base[$k] = $src[$k];
                }
            }
            if (isset($src['dailyLossLimit']) && is_int($src['dailyLossLimit']) && $src['dailyLossLimit'] >= 0) {
                $base['dailyLossLimit'] = $src['dailyLossLimit'];
            }
        }
        $base['maxBet'] = max($base['maxBet'], $base['minBet']);
        $base['maxRoundStake'] = max($base['maxRoundStake'], $base['minBet']);

        return $base;
    }

    /** stake and payout of a player today (UTC), for the daily loss limit */
    public function today(string $playerKey): array
    {
        $day = gmdate('Y-m-d', intdiv(($this->now)(), 1000));
        $from = strtotime($day.' 00:00:00 UTC') * 1000;
        $q = DB::table('bets')->where('player_key', $playerKey)->where('placed_at', '>=', $from)->where('placed_at', '<', $from + 86400000)->where('status', '!=', 'refunded');

        return ['staked' => (int) $q->sum('stake'), 'paid' => (int) (clone $q)->sum('payout')];
    }

    /** what the player has lost today (stake minus payout; negative when ahead) */
    public function dayNet(string $playerKey): int
    {
        $d = $this->today($playerKey);

        return $d['staked'] - $d['paid'];
    }
}
