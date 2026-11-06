<?php

namespace App\Games\BingoPinball;

use App\Platform\Games\GameModule;

/**
 * Bingo Pinball as a module of the platform: an instant game (one round per play, settled inside the player's request).
 * Every client plays it with the server's default paytable unless an operator gives the client its own paytable (the RTP version) or narrows the stake limits.
 */
final class BingoPinballModule implements GameModule
{
    public const ID = 'bingo-pinball';

    public function id(): string
    {
        return self::ID;
    }

    public function kind(): string
    {
        return 'instant';
    }

    public function name(): string
    {
        return 'Bingo Pinball';
    }

    public function launchPath(): string
    {
        return '/games/bingo-pinball';
    }

    public function rules(): array
    {
        return ['holes' => Card::SIZE, 'balls' => Card::BALLS, 'lines' => 12, 'pays' => 'the best line pays 3, 4 or 5 lit cells; see the paytable of the client',
            'plunger' => 'cosmetic: how hard the plunger is pulled never changes the result', 'versions' => Paytables::VERSIONS];
    }

    public function clientSettings(): array
    {
        return [
            'paytable' => 'optional: the RTP version of the paytable this client plays, one of '.implode(', ', Paytables::VERSIONS).'. Without it the server default applies (BINGO_DEFAULT_PAYTABLE, 90)',
            'limits' => 'optional: {"minBet": n, "maxBet": n} in minor units, narrowing the server limits for this game',
            'roundWebhooks' => 'optional, default false: also send a round.settled webhook for every play (a big.win webhook is sent for every big win)',
        ];
    }

    public function validateClientSettings(array $settings): array
    {
        $out = [];
        foreach ($settings as $k => $v) {
            switch ($k) {
                case 'paytable':
                    if (! is_int($v) || ! in_array($v, Paytables::VERSIONS, true)) {
                        throw new \InvalidArgumentException('paytable must be one of '.implode(', ', Paytables::VERSIONS));
                    }
                    $out['paytable'] = $v;
                    break;
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
                    throw new \InvalidArgumentException('unknown setting "'.$k.'" for Bingo Pinball');
            }
        }

        return $out;
    }
}
