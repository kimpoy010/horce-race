<?php

namespace App\Game\Staff;

/** Time-based one-time passwords (RFC 6238): Google Authenticator, Microsoft Authenticator, 1Password and similar apps. Same as server/users.js. */
final class Totp
{
    private const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

    public static function b32encode(string $bin): string
    {
        $bits = '';
        foreach (str_split($bin) as $c) {
            $bits .= str_pad(decbin(ord($c)), 8, '0', STR_PAD_LEFT);
        }
        $out = '';
        foreach (str_split($bits, 5) as $chunk) {
            $out .= self::B32[bindec(str_pad($chunk, 5, '0'))];
        }

        return $out;
    }

    public static function b32decode(string $s): string
    {
        $bits = '';
        foreach (str_split(strtoupper(rtrim($s, '='))) as $c) {
            $i = strpos(self::B32, $c);
            if ($i === false) {
                throw new \InvalidArgumentException('bad base32');
            }
            $bits .= str_pad(decbin($i), 5, '0', STR_PAD_LEFT);
        }
        $out = '';
        for ($i = 0; $i + 8 <= strlen($bits); $i += 8) {
            $out .= chr(bindec(substr($bits, $i, 8)));
        }

        return $out;
    }

    public static function newSecret(): string
    {
        return self::b32encode(random_bytes(20));
    }

    public static function at(string $secret, int $step): string
    {
        $h = hash_hmac('sha1', pack('J', $step), self::b32decode($secret), true);
        $o = ord($h[19]) & 15;
        $n = ((ord($h[$o]) & 0x7F) << 24) | (ord($h[$o + 1]) << 16) | (ord($h[$o + 2]) << 8) | ord($h[$o + 3]);

        return str_pad((string) ($n % 1000000), 6, '0', STR_PAD_LEFT);
    }

    /** the matching time step (so a code cannot be used twice) or null */
    public static function check(string $secret, mixed $code, int $nowMs, int $lastStep = 0): ?int
    {
        $c = preg_replace('/\s/', '', (string) $code);
        if (! preg_match('/^\d{6}$/', $c)) {
            return null;
        }
        $step = intdiv($nowMs, 30000);
        foreach ([0, -1, 1] as $d) {
            $s = $step + $d;
            if ($s > $lastStep && hash_equals(self::at($secret, $s), $c)) {
                return $s;
            }
        }

        return null;
    }
}
