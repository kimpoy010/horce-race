<?php

namespace App\Game\Clients;

/**
 * Secrets at rest: AES-256-GCM, the format of server/clients.js ("enc:v1:<iv>:<tag>:<ciphertext>", base64, key = sha256(CLIENTS_KEY)),
 * so a client list exported from the Node server can be read here and the other way round.
 */
final class SecretBox
{
    private static function key(string $secret): string
    {
        return hash('sha256', $secret, true);
    }

    public static function encrypt(?string $plain, string $secret): ?string
    {
        if ($secret === '' || $plain === null) {
            return $plain;
        }
        $iv = random_bytes(12);
        $ct = openssl_encrypt($plain, 'aes-256-gcm', self::key($secret), OPENSSL_RAW_DATA, $iv, $tag, '', 16);

        return 'enc:v1:'.base64_encode($iv).':'.base64_encode($tag).':'.base64_encode($ct);
    }

    public static function decrypt(?string $text, string $secret): ?string
    {
        if (! is_string($text) || ! str_starts_with($text, 'enc:v1:')) {
            return $text;
        }
        if ($secret === '') {
            throw new \RuntimeException('HORSE_CLIENTS_KEY is needed to read the client secrets');
        }
        [$iv, $tag, $ct] = array_map('base64_decode', explode(':', substr($text, 7)));
        $plain = openssl_decrypt($ct, 'aes-256-gcm', self::key($secret), OPENSSL_RAW_DATA, $iv, $tag);
        if ($plain === false) {
            throw new \RuntimeException('a client secret cannot be decrypted: wrong HORSE_CLIENTS_KEY?');
        }

        return $plain;
    }
}
