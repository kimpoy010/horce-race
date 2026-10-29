<?php

namespace App\Games\BingoPinball;

/** The registry of paytable versions (the files in app/Games/BingoPinball/paytables, one per RTP version). */
final class Paytables
{
    public const VERSIONS = [88, 90, 92, 94, 96];

    /** @var array<int,Paytable> */
    private static array $loaded = [];

    public static function get(int $version): Paytable
    {
        if (! in_array($version, self::VERSIONS, true)) {
            throw new \InvalidArgumentException("unknown paytable version $version (".implode(', ', self::VERSIONS).')');
        }

        return self::$loaded[$version] ??= Paytable::fromArray(require __DIR__.'/paytables/v'.$version.'.php');
    }

    /** @return array<int,Paytable> */
    public static function all(): array
    {
        $out = [];
        foreach (self::VERSIONS as $v) {
            $out[$v] = self::get($v);
        }

        return $out;
    }
}
