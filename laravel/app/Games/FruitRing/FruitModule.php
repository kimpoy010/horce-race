<?php

namespace App\Games\FruitRing;

use App\Platform\Games\GameModule;

/** Fruit Game as a module of the platform: an instant game (one spin per request, settled inside the player's request), with an optional Small/Big double-up of a win. */
final class FruitModule implements GameModule
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
        return 'Fruit Game';
    }

    public function launchPath(): string
    {
        return '/games/fruit-ring';
    }

    public function rules(): array
    {
        return ['symbols' => Rules::SYMBOLS, 'pays' => Rules::PAYS, 'cells' => 24, 'luckyCells' => 'a Lucky stop gives 3 free spins, or one free spin with 3 lit cells', 'doubleUp' => 'after a win: Small (1-7) or Big (8-14) of 14, a fair 50/50, up to '.Rules::DOUBLE_MAX.' times in a row',
            'paytable' => Rules::PAYTABLE_ID];
    }

    public function clientSettings(): array
    {
        return [
            'limits' => 'optional: {"minBet": n, "maxBet": n} in minor units for the whole stake of a spin, narrowing the server limits for this game',
            'roundWebhooks' => 'optional, default false: also send a round.settled webhook for every spin (a big.win webhook is sent for every big win)',
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
                    throw new \InvalidArgumentException('unknown setting "'.$k.'" for Fruit Game');
            }
        }

        return $out;
    }
}
