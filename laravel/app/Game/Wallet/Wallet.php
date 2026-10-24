<?php

namespace App\Game\Wallet;

/**
 * Wallet adapter. All amounts are integers in minor units. A wallet must be idempotent on txId: the same debit or credit
 * sent twice is applied once. (Same contract as server/wallet.js and docs/WALLET_API.md.)
 */
interface Wallet
{
    /** @return array{playerId:string,currency:string,balance:int,returnUrl?:?string,brandId?:?string,decimals?:?int,limits?:?array,realityCheckMinutes?:?int,blocked?:bool} */
    public function validateToken(string $token): array;

    public function balance(string $playerId): int;

    /** @return array{balance:int} @throws WalletException INSUFFICIENT_FUNDS when short */
    public function debit(string $playerId, int $amount, string $txId, array $meta = []): array;

    /** @return array{balance:int} */
    public function credit(string $playerId, int $amount, string $txId, array $meta = []): array;

    /** cancel a debit whose outcome is unknown; the wallet must also refuse a debit with that txId that arrives later
     * @return array{balance:int,status?:string}
     */
    public function rollback(string $playerId, int $amount, string $txId, array $meta = []): array;
}
