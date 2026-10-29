<?php

/*
 * Test support only (never loaded by the application): makes the live code's random identifiers reproducible, so a scenario can be replayed
 * byte for byte. The horse race draws its randomness through an unqualified random_bytes() call inside the namespaces App\Game, App\Game\Wallet
 * and App\Game\Clients; PHP looks a function up in the current namespace first, so defining it there is enough, and no production file changes.
 * While DeterministicRandom::$on is false (the default) every call goes to the real random_bytes().
 *
 * This file must be loaded before any application code runs (tests/TestCase.php does it): PHP remembers where a call resolved the first time.
 */

namespace Tests\Support {
    final class DeterministicRandom
    {
        public static bool $on = false;

        private static int $counter = 0;

        public static function start(string $label = 'golden'): void
        {
            self::$counter = 0;
            self::$on = true;
            self::$label = $label;
        }

        public static function stop(): void
        {
            self::$on = false;
        }

        private static string $label = 'golden';

        public static function bytes(int $length): string
        {
            $out = '';
            while (strlen($out) < $length) {
                $out .= hash_hmac('sha256', (string) self::$counter++, 'deterministic-random:'.self::$label, true);
            }

            return substr($out, 0, $length);
        }
    }
}

namespace App\Game {
    function random_bytes(int $length): string
    {
        return \Tests\Support\DeterministicRandom::$on ? \Tests\Support\DeterministicRandom::bytes($length) : \random_bytes($length);
    }
}

namespace App\Game\Wallet {
    function random_bytes(int $length): string
    {
        return \Tests\Support\DeterministicRandom::$on ? \Tests\Support\DeterministicRandom::bytes($length) : \random_bytes($length);
    }
}

namespace App\Game\Clients {
    function random_bytes(int $length): string
    {
        return \Tests\Support\DeterministicRandom::$on ? \Tests\Support\DeterministicRandom::bytes($length) : \random_bytes($length);
    }
}
