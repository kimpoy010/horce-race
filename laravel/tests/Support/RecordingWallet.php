<?php

namespace Tests\Support;

use App\Game\Wallet\Wallet;
use App\Game\Wallet\WalletException;

/** wraps a wallet and writes down every call and its answer (or the refusal), for the golden baseline */
final class RecordingWallet implements Wallet
{
    /** @var list<array<string,mixed>> */
    public array $calls = [];

    /* failures to inject, each used up one call at a time */
    public int $refuseDebits = 0;            // the platform answers with a refusal (4xx): the debit certainly did not happen

    public int $loseDebitAnswers = 0;        // the platform applies the debit but the answer is lost (unknown outcome)

    public int $failCredits = 0;             // a credit gets no answer

    public int $unsupportedRollbacks = 0;    // the platform has no rollback call

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
        if ($this->refuseDebits > 0) {
            $this->refuseDebits--;
            $this->calls[] = ['op' => 'debit', 'playerId' => $playerId, 'amount' => $amount, 'txId' => $txId, 'meta' => $meta, 'refused' => 'REJECTED (injected)'];
            throw new WalletException('REJECTED', true, 400);
        }
        if ($this->loseDebitAnswers > 0) {
            $this->loseDebitAnswers--;
            $res = $this->inner->debit($playerId, $amount, $txId, $meta);                      // applied by the platform ...
            $this->calls[] = ['op' => 'debit', 'playerId' => $playerId, 'amount' => $amount, 'txId' => $txId, 'meta' => $meta, 'answerLost' => $res];
            throw new WalletException('NO_ANSWER');                                          // ... but the answer never came
        }

        return $this->rec('debit', ['playerId' => $playerId, 'amount' => $amount, 'txId' => $txId, 'meta' => $meta], fn () => $this->inner->debit($playerId, $amount, $txId, $meta));
    }

    public function credit(string $playerId, int $amount, string $txId, array $meta = []): array
    {
        if ($this->failCredits > 0) {
            $this->failCredits--;
            $this->calls[] = ['op' => 'credit', 'playerId' => $playerId, 'amount' => $amount, 'txId' => $txId, 'meta' => $meta, 'refused' => 'NO_ANSWER (injected)'];
            throw new WalletException('NO_ANSWER');
        }

        return $this->rec('credit', ['playerId' => $playerId, 'amount' => $amount, 'txId' => $txId, 'meta' => $meta], fn () => $this->inner->credit($playerId, $amount, $txId, $meta));
    }

    public function rollback(string $playerId, int $amount, string $txId, array $meta = []): array
    {
        if ($this->unsupportedRollbacks > 0) {
            $this->unsupportedRollbacks--;
            $this->calls[] = ['op' => 'rollback', 'playerId' => $playerId, 'amount' => $amount, 'txId' => $txId, 'meta' => $meta, 'refused' => 'NOT_SUPPORTED (injected)'];
            throw new WalletException('NOT_SUPPORTED', true, 501, true);
        }

        return $this->rec('rollback', ['playerId' => $playerId, 'amount' => $amount, 'txId' => $txId, 'meta' => $meta], fn () => $this->inner->rollback($playerId, $amount, $txId, $meta));
    }
}
