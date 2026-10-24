<?php

namespace App\Game\Wallet;

/**
 * Request signing between the game and the platform wallet (HMAC-SHA256), identical to server/sign.js:
 *   X-Signature = hex HMAC-SHA256(secret, timestamp "\n" nonce "\n" METHOD "\n" path "\n" sha256hex(body))
 */
final class Signer
{
    public static function canonical(string $ts, string $nonce, string $method, string $path, string $body): string
    {
        return $ts."\n".$nonce."\n".strtoupper($method)."\n".$path."\n".hash('sha256', $body);
    }

    public static function signature(string $secret, string $ts, string $nonce, string $method, string $path, string $body): string
    {
        return hash_hmac('sha256', self::canonical($ts, $nonce, $method, $path, $body), $secret);
    }

    /** @return array<string,string> */
    public static function headers(string $secret, string $keyId, string $method, string $path, string $body, ?int $nowMs = null): array
    {
        $ts = (string) ($nowMs ?? (int) floor(microtime(true) * 1000));
        $nonce = bin2hex(random_bytes(16));
        $h = ['X-Timestamp' => $ts, 'X-Nonce' => $nonce, 'X-Signature' => self::signature($secret, $ts, $nonce, $method, $path, $body)];
        if ($keyId !== '') {
            $h['X-Key-Id'] = $keyId;
        }

        return $h;
    }
}
