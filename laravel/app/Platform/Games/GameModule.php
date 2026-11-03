<?php

namespace App\Platform\Games;

/**
 * One game on the platform. The platform (sessions, wallet, limits, ledger, webhooks, clients) is shared; a module is what is specific to a game. Two kinds:
 *   'shared'  - rounds that every player of the game takes part in together, moved on by the round loop (php artisan game:run): the horse race
 *   'instant' - one round per play, settled inside the player's own request: Bingo Pinball
 */
interface GameModule
{
    /** the game id used in URLs, sessions, bets, wallet calls and the ledger, for example 'horse-race' */
    public function id(): string;

    /** 'shared' or 'instant' */
    public function kind(): string;

    /** the name shown to people */
    public function name(): string;

    /** where a platform sends a player to play this game (a path on this server) */
    public function launchPath(): string;

    /** the public rules of the game, as the game's page and a platform's integration need them */
    public function rules(): array;

    /**
     * Checks and cleans the settings an operator gives a client for this game (config of the client: "gameSettings": {"<game id>": {...}}).
     *
     * @return array the settings as they are stored
     *
     * @throws \InvalidArgumentException with a message that says what is wrong
     */
    public function validateClientSettings(array $settings): array;

    /**
     * What an operator may set per client for this game, as {setting: description}; an empty list when nothing is per client (the horse race's RTP is one setting for
     * the whole server).
     *
     * @return array<string,string>
     */
    public function clientSettings(): array;
}
