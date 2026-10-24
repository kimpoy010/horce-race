<?php

namespace App\Game;

use RuntimeException;

/** an answer the player's browser or the platform understands: HTTP status + error code (same codes as the Node server) */
final class GameError extends RuntimeException
{
    public function __construct(public readonly int $status, public readonly string $errorCode, string $message = '')
    {
        parent::__construct($message !== '' ? $message : $errorCode);
    }

    /** a refused client setting (HTTP 400, code BAD_CLIENT, with a message that says what is wrong) */
    public static function badClient(string $message, int $status = 400, string $code = 'BAD_CLIENT'): self
    {
        return new self($status, $code, $message);
    }
}
