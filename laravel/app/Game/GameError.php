<?php

namespace App\Game;

use RuntimeException;

/** an answer the player's browser or the platform understands: HTTP status + error code (same codes as the Node server) */
final class GameError extends RuntimeException
{
    public function __construct(public readonly int $status, public readonly string $errorCode)
    {
        parent::__construct($errorCode);
    }
}
