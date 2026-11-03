<?php

namespace App\Platform;

/**
 * Every player belongs to one client (platform). Internally a player is "clientId:playerId"; the implicit "default" client's players are just "playerId".
 * (Moved here from the Engine unchanged; Engine::pk() and Engine::splitPk() still exist and call these.)
 */
final class PlayerKey
{
    public static function make(?string $clientId, string $playerId): string
    {
        return ! $clientId || $clientId === 'default' ? $playerId : $clientId.':'.$playerId;
    }

    /** @return array{0:string,1:string} [clientId, playerId] */
    public static function split(string $pk): array
    {
        $i = strpos($pk, ':');

        return $i === false ? ['default', $pk] : [substr($pk, 0, $i), substr($pk, $i + 1)];
    }
}
