<?php

namespace App\Game\House;

use App\Game\Wallet\Wallet;
use App\Game\Wallet\WalletException;
use Illuminate\Support\Facades\DB;

/**
 * The built-in wallet of the operator's own site (client "house"): the balance lives in players.balance and every movement is a row of
 * wallet_tx. Idempotent on txId like any platform wallet; a rolled-back debit is refused if it arrives later. Players are "p<id>".
 */
final class HouseWallet implements Wallet
{
    public const CLIENT = 'house';

    public function __construct(private string $currency = 'PHP') {}

    private static function now(): int
    {
        return (int) floor(microtime(true) * 1000);
    }

    private static function id(string $playerId): int
    {
        if (! preg_match('/^p(\d{1,12})$/', $playerId, $m)) {
            throw new WalletException('UNKNOWN_PLAYER', true);
        }

        return (int) $m[1];
    }

    /**
     * Applies one movement exactly once. Returns [balance, applied]; a repeated txId changes nothing.
     *
     * @throws WalletException INSUFFICIENT_FUNDS when a debit would make the balance negative
     */
    public static function post(int $playerId, int $delta, string $txId, string $type, ?string $ref = null): array
    {
        return DB::transaction(function () use ($playerId, $delta, $txId, $type, $ref) {
            $p = DB::table('players')->where('id', $playerId)->lockForUpdate()->first();
            if (! $p) {
                throw new WalletException('UNKNOWN_PLAYER', true);
            }
            if (DB::table('wallet_tx')->where('tx_id', $txId)->exists()) {
                return [(int) $p->balance, false];
            }
            $bal = (int) $p->balance + $delta;
            if ($bal < 0) {
                throw new WalletException('INSUFFICIENT_FUNDS', true);
            }
            DB::table('players')->where('id', $playerId)->update(['balance' => $bal]);
            DB::table('wallet_tx')->insert(['player_id' => $playerId, 'tx_id' => $txId, 'type' => $type, 'amount' => $delta, 'balance_after' => $bal, 'ref' => $ref, 'created_at' => self::now()]);

            return [$bal, true];
        });
    }

    public function validateToken(string $token): array
    {
        $h = hash('sha256', $token);
        $p = DB::transaction(function () use ($h) {
            $t = DB::table('launch_tokens')->where('token_hash', $h)->lockForUpdate()->first();
            if (! $t || (int) $t->expires_at < self::now()) {
                throw new WalletException('INVALID_TOKEN', true);
            }
            DB::table('launch_tokens')->where('token_hash', $h)->delete();          // used once

            return DB::table('players')->where('id', $t->player_id)->first();
        });
        if (! $p) {
            throw new WalletException('INVALID_TOKEN', true);
        }

        return ['playerId' => 'p'.$p->id, 'currency' => $this->currency, 'balance' => (int) $p->balance, 'returnUrl' => '/account', 'decimals' => 2, 'blocked' => $p->status !== 'active'];
    }

    public function balance(string $playerId): int
    {
        return (int) DB::table('players')->where('id', self::id($playerId))->value('balance');
    }

    public function debit(string $playerId, int $amount, string $txId, array $meta = []): array
    {
        $id = self::id($playerId);
        if (DB::table('wallet_tx')->where('tx_id', 'rb:'.$txId)->exists()) {
            throw new WalletException('TX_ROLLED_BACK', true);
        }

        return ['balance' => self::post($id, -$amount, $txId, 'bet', isset($meta['raceNo']) ? 'race '.$meta['raceNo'] : null)[0]];
    }

    public function credit(string $playerId, int $amount, string $txId, array $meta = []): array
    {
        return ['balance' => self::post(self::id($playerId), $amount, $txId, 'win', isset($meta['raceNo']) ? 'race '.$meta['raceNo'] : null)[0]];
    }

    public function rollback(string $playerId, int $amount, string $txId, array $meta = []): array
    {
        $id = self::id($playerId);

        return DB::transaction(function () use ($id, $txId) {
            DB::table('players')->where('id', $id)->lockForUpdate()->first();
            $orig = DB::table('wallet_tx')->where('tx_id', $txId)->first();
            if (DB::table('wallet_tx')->where('tx_id', 'rb:'.$txId)->exists()) {
                return ['balance' => $this->balance('p'.$id), 'status' => 'already_rolled_back'];
            }
            if (! $orig) {                                                           // the debit never arrived: refuse it if it does
                [$bal] = self::post($id, 0, 'rb:'.$txId, 'rollback');

                return ['balance' => $bal, 'status' => 'not_found'];
            }
            [$bal] = self::post($id, -(int) $orig->amount, 'rb:'.$txId, 'rollback', $txId);

            return ['balance' => $bal, 'status' => 'rolled_back'];
        });
    }
}
