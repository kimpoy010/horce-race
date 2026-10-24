<?php

namespace App\Game\Wallet;

use Illuminate\Http\Client\ConnectionException;
use Illuminate\Support\Facades\Http;

/**
 * Talks to the operator's platform over HTTPS/JSON (docs/WALLET_API.md). Auth 'hmac' (default): every request is signed
 * (see Signer, same format as server/sign.js); 'bearer': the shared secret is sent as a Bearer token.
 */
final class HttpWallet implements Wallet
{
    public function __construct(
        private string $url,
        private string $key,
        private string $keyId = '',
        private string $auth = 'hmac',
        private int $timeoutMs = 8000,
        private string $currency = 'PHP',
        private string $gameId = 'horse-race',
    ) {
        $this->url = rtrim($url, '/');
    }

    private function post(string $path, array $body): array
    {
        $text = json_encode($body, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        $headers = ['Content-Type' => 'application/json'];
        if ($this->auth === 'bearer') {
            $headers['Authorization'] = 'Bearer '.$this->key;
        } else {
            $headers += Signer::headers($this->key, $this->keyId, 'POST', parse_url($this->url.$path, PHP_URL_PATH), $text);
        }
        try {
            $res = Http::withHeaders($headers)->timeout(max(1, (int) ceil($this->timeoutMs / 1000)))->withBody($text, 'application/json')->post($this->url.$path);
        } catch (ConnectionException $e) {
            throw new WalletException('NO_ANSWER: '.$e->getMessage());       // unknown outcome: not definitive
        }
        $data = $res->json() ?? [];
        if (! $res->successful() || (is_array($data) && ($data['ok'] ?? true) === false)) {
            $status = $res->status();
            throw new WalletException((string) ($data['error'] ?? 'HTTP_'.$status), $status >= 400 && $status < 500, $status, in_array($status, [404, 405, 501], true));
        }

        return $data;
    }

    public function validateToken(string $token): array
    {
        $d = $this->post('/session/validate', ['token' => $token]);

        return ['playerId' => (string) $d['playerId'], 'currency' => $d['currency'] ?? $this->currency, 'balance' => (int) ($d['balance'] ?? 0), 'returnUrl' => $d['returnUrl'] ?? null,
            'brandId' => $d['brandId'] ?? null, 'decimals' => $d['decimals'] ?? null, 'limits' => $d['limits'] ?? null,
            'realityCheckMinutes' => $d['realityCheckMinutes'] ?? null, 'blocked' => (bool) ($d['blocked'] ?? false)];
    }

    public function balance(string $playerId): int
    {
        return (int) $this->post('/wallet/balance', ['playerId' => $playerId])['balance'];
    }

    /** every transaction names the game, round, bet(s), type, currency and brand, so the platform can show history without parsing meta */
    private function tx(string $playerId, int $amount, string $txId, array $meta, array $extra = []): array
    {
        return array_filter([
            'playerId' => $playerId, 'amount' => $amount, 'txId' => $txId, 'gameId' => $this->gameId, 'transactionType' => $meta['kind'] ?? null,
            'roundId' => $meta['roundId'] ?? null, 'betId' => $meta['betId'] ?? null, 'betIds' => $meta['betIds'] ?? null, 'refTxId' => $meta['refTxId'] ?? null,
            'currency' => $meta['currency'] ?? $this->currency, 'brandId' => $meta['brandId'] ?? null,
        ] + $extra, fn ($v) => $v !== null) + ['meta' => (object) $meta];
    }

    public function debit(string $playerId, int $amount, string $txId, array $meta = []): array
    {
        return $this->post('/wallet/debit', $this->tx($playerId, $amount, $txId, $meta));
    }

    public function credit(string $playerId, int $amount, string $txId, array $meta = []): array
    {
        return $this->post('/wallet/credit', $this->tx($playerId, $amount, $txId, $meta));
    }

    public function rollback(string $playerId, int $amount, string $txId, array $meta = []): array
    {
        return $this->post('/wallet/rollback', $this->tx($playerId, $amount, $txId, $meta, ['rollbackTxId' => 'rollback:'.$txId]));
    }
}
