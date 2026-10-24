<?php

namespace App\Game;

/** Deterministic byte stream: HMAC-SHA256(seed, label:counter) */
final class RngStream
{
    private string $key;

    private int $ctr = 0;

    private string $buf = '';

    private int $pos = 0;

    public function __construct(string $seedHex, private string $label)
    {
        $this->key = hex2bin($seedHex);
    }

    public function byte(): int
    {
        if ($this->pos >= strlen($this->buf)) {
            $this->buf = hash_hmac('sha256', $this->label.':'.$this->ctr++, $this->key, true);
            $this->pos = 0;
        }

        return ord($this->buf[$this->pos++]);
    }

    public function uint32(): int
    {
        $a = $this->byte();
        $b = $this->byte();
        $c = $this->byte();
        $d = $this->byte();

        return ($a << 24) | ($b << 16) | ($c << 8) | $d;
    }

    /** uniform integer in [0, max) */
    public function int(int $max): int
    {
        $limit = 4294967296 - (4294967296 % $max);
        do {
            $v = $this->uint32();
        } while ($v >= $limit);

        return $v % $max;
    }
}
