<?php

namespace App\Games\HorseRace;

use App\Game\Engine;
use App\Platform\Games\GameModule;

/**
 * The horse race as a module of the platform. It describes the game; the game itself (rounds, odds, draw, settlement) is still App\Game\Engine, unchanged.
 * Not enforced yet: a client's "games" list does not switch the horse race off, so every client plays it exactly as before.
 */
final class HorseRaceModule implements GameModule
{
    public const ID = 'horse-race';

    public function __construct(private Engine $engine) {}

    public function id(): string
    {
        return self::ID;
    }

    public function kind(): string
    {
        return 'shared';
    }

    public function name(): string
    {
        return 'Horse Race';
    }

    public function launchPath(): string
    {
        return '/';
    }

    public function rules(): array
    {
        return $this->engine->rules();
    }

    public function clientSettings(): array
    {
        return [];
    }
}
