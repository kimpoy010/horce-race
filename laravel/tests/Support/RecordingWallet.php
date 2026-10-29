<?php

namespace Tests\Support;

use App\Game\Wallet\Wallet;
use App\Game\Wallet\WalletException;

/** wraps a wallet and writes down every call and its answer (or the refusal), for the golden baseline */
final class RecordingWallet implements Wallet
{
    /** @var list<array<string,mixed>> */
    public array $calls = [];

    public function __construct(private Wallet $inner) {}

    private function rec(string $op, array $args, callable $fn): array
    {
        try {
            $res = $fn();
            $this->calls[] = ['op' => $op] + $args + ['answer' => $res];

            return $res;
        } catch (WalletException $e) {
            $this->calls[] = ['op' => $op] + $args + ['refused' => $e->getMessage()];
            throw $e;
        }
    }

    public function validateToken(string $token): array
    {
        return $this->rec('validate', ['token' => $token], fn () => $this->inner->validateToken($token));
    }

    public function balance(string $playerId): int
    {
        return $this->inner->balance($playerId);
    }

    public function debit(string $playerId, int $amount, string $txId, array $meta = []): array
    {
        return $this->rec('debit', ['playerId' => $playerId, 'amount' => $amount, 'txId' => $txId, 'meta' => $meta], fn () => $this->inner->debit($playerId, $amount, $txId, $meta));
    }

    public function credit(string $playerId, int $amount, string $txId, array $meta = []): array
    {
        return $this->rec('credit', ['playerId' => $playerId, 'amount' => $amount, 'txId' => $txId, 'meta' => $meta], fn () => $this->inner->credit($playerId, $amount, $txId, $meta));
    }

    public function rollback(string $playerId, int $amount, string $txId, array $meta = []): array
    {
        return $this->rec('rollback', ['playerId' => $playerId, 'amount' => $amount, 'txId' => $txId, 'meta' => $meta], fn () => $this->inner->rollback($playerId, $amount, $txId, $meta));
    }
}
