<?php

namespace App\Game\Wallet;

use Illuminate\Support\Facades\DB;

/** Play-money wallet for local testing: anyone who opens ?token=demo-<name> gets free credit. Never use in production. */
final class MockWallet implements Wallet
{
    /** @param string $scope separates the players of different clients (each client has its own accounts) */
    public function __construct(private int $startBalance = 1000000, private string $currency = 'PHP', private string $scope = '') {}

    private function k(string $id): string
    {
        return $this->scope === '' ? $id : $this->scope.':'.$id;
    }

    private function account(string $id): int
    {
        $id = $this->k($id);
        DB::table('mock_accounts')->insertOrIgnore(['player_id' => $id, 'balance' => $this->startBalance]);

        return (int) DB::table('mock_accounts')->where('player_id', $id)->value('balance');
    }

    public function validateToken(string $token): array
    {
        if (! preg_match('/^demo-([a-z0-9_]{1,32})$/i', $token, $m)) {
            throw new WalletException('INVALID_TOKEN');
        }
        $id = strtolower($m[1]);

        return ['playerId' => $id, 'currency' => $this->currency, 'balance' => $this->account($id)];
    }

    public function balance(string $playerId): int
    {
        return $this->account($playerId);
    }

    public function debit(string $playerId, int $amount, string $txId, array $meta = []): array
    {
        return DB::transaction(function () use ($playerId, $amount, $txId) {
            if (DB::table('mock_tx')->where('tx_id', $this->k($txId))->where('cancelled', true)->exists()) {
                throw new WalletException('TX_ROLLED_BACK', true);
            }
            $bal = $this->account($playerId);
            if (DB::table('mock_tx')->where('tx_id', $this->k($txId))->exists()) {
                return ['balance' => $bal];
            }
            if ($bal < $amount) {
                throw new WalletException('INSUFFICIENT_FUNDS');
            }
            DB::table('mock_accounts')->where('player_id', $this->k($playerId))->update(['balance' => $bal - $amount]);
            DB::table('mock_tx')->insert(['tx_id' => $this->k($txId), 'amount' => -$amount, 'cancelled' => false]);

            return ['balance' => $bal - $amount];
        });
    }

    public function credit(string $playerId, int $amount, string $txId, array $meta = []): array
    {
        return DB::transaction(function () use ($playerId, $amount, $txId) {
            $bal = $this->account($playerId);
            if (DB::table('mock_tx')->where('tx_id', $this->k($txId))->exists()) {
                return ['balance' => $bal];
            }
            DB::table('mock_accounts')->where('player_id', $this->k($playerId))->update(['balance' => $bal + $amount]);
            DB::table('mock_tx')->insert(['tx_id' => $this->k($txId), 'amount' => $amount, 'cancelled' => false]);

            return ['balance' => $bal + $amount];
        });
    }

    public function rollback(string $playerId, int $amount, string $txId, array $meta = []): array
    {
        return DB::transaction(function () use ($playerId, $txId) {
            $bal = $this->account($playerId);
            $tx = DB::table('mock_tx')->where('tx_id', $this->k($txId))->first();
            if ($tx && $tx->cancelled) {
                return ['balance' => $bal, 'status' => 'already_rolled_back'];
            }
            if (! $tx) {
                DB::table('mock_tx')->insert(['tx_id' => $this->k($txId), 'amount' => 0, 'cancelled' => true]);

                return ['balance' => $bal, 'status' => 'not_found'];
            }
            DB::table('mock_accounts')->where('player_id', $this->k($playerId))->update(['balance' => $bal - $tx->amount]);
            DB::table('mock_tx')->where('tx_id', $this->k($txId))->update(['cancelled' => true]);

            return ['balance' => $bal - $tx->amount, 'status' => 'rolled_back'];
        });
    }
}
