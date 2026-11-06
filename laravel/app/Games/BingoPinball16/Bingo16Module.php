<?php

namespace App\Games\BingoPinball16;

use App\Platform\Games\GameModule;

/** Bingo Pinball 16 as a module of the platform: an instant game (one round per play, settled inside the player's request) with a progressive jackpot. */
final class Bingo16Module implements GameModule
{
    public function id(): string
    {
        return Rules::ID;
    }

    public function kind(): string
    {
        return 'instant';
    }

    public function name(): string
    {
        return 'Bingo Pinball 16';
    }

    public function launchPath(): string
    {
        return '/games/bingo-pinball-16';
    }

    public function rules(): array
    {
        return ['balls' => Rules::BALLS, 'slots' => Rules::SLOTS, 'card' => '4 x 4', 'patterns' => array_map(fn ($p) => ['name' => $p[0], 'multiple' => $p[1]], array_values(Rules::PATTERNS)),
            'jackpot' => 'one progressive pool for the whole server (PHP): all '.Rules::JACKPOT_NUMBERS.' random jackpot numbers lit win the pool',
            'plunger' => 'cosmetic: how hard the plunger is pulled never changes the result', 'paytable' => Rules::PAYTABLE_ID];
    }

    public function clientSettings(): array
    {
        return [
            'limits' => 'optional: {"minBet": n, "maxBet": n} in minor units, narrowing the server limits for this game',
            'roundWebhooks' => 'optional, default false: also send a round.settled webhook for every play (a big.win webhook is sent for every jackpot and every big win)',
        ];
    }

    public function validateClientSettings(array $settings): array
    {
        $out = [];
        foreach ($settings as $k => $v) {
            switch ($k) {
                case 'limits':
                    if (! is_array($v)) {
                        throw new \InvalidArgumentException('limits must be {"minBet": n, "maxBet": n}');
                    }
                    $lim = [];
                    foreach ($v as $lk => $lv) {
                        if (! in_array($lk, ['minBet', 'maxBet'], true) || ! is_int($lv) || $lv < 1) {
                            throw new \InvalidArgumentException('limits: minBet and maxBet are whole numbers of at least 1');
                        }
                        $lim[$lk] = $lv;
                    }
                    if (isset($lim['minBet'], $lim['maxBet']) && $lim['minBet'] > $lim['maxBet']) {
                        throw new \InvalidArgumentException('limits: minBet is above maxBet');
                    }
                    $out['limits'] = $lim;
                    break;
                case 'roundWebhooks':
                    if (! is_bool($v)) {
                        throw new \InvalidArgumentException('roundWebhooks must be true or false');
                    }
                    $out['roundWebhooks'] = $v;
                    break;
                default:
                    throw new \InvalidArgumentException('unknown setting "'.$k.'" for Bingo Pinball 16');
            }
        }

        return $out;
    }
}
