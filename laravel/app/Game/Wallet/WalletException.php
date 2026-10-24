<?php

namespace App\Game\Wallet;

use RuntimeException;

class WalletException extends RuntimeException
{
    /** @param bool $definitive the platform answered with a refusal (4xx): the call certainly did not apply
     *  @param bool $unsupported the platform does not implement this call (404/405/501) */
    public function __construct(string $message, public readonly bool $definitive = false, public readonly ?int $status = null, public readonly bool $unsupported = false)
    {
        parent::__construct($message);
    }
}
