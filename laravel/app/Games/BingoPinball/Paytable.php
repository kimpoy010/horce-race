<?php

namespace App\Games\BingoPinball;

/** One frozen paytable version: the pays for 3, 4 and 5 lit cells on the best line, and the card shown to the player. */
final class Paytable
{
    /** @param array<int,int> $pays best-line cell count (3, 4, 5) => stake multiple, stake included
     *  @param list<int> $card 25 hole numbers, row by row */
    public function __construct(public readonly string $id, public readonly int $version, public readonly array $pays, public readonly string $publishedRtp, public readonly array $card)
    {
        Card::check($card);
        if (array_keys($pays) !== [3, 4, 5] || min($pays) < 1 || $pays[3] > $pays[4] || $pays[4] > $pays[5]) {
            throw new \InvalidArgumentException('a paytable pays for 3, 4 and 5 in a line, and more for more');
        }
    }

    public static function fromArray(array $a): self
    {
        return new self($a['id'], $a['version'], $a['pays'], $a['publishedRtp'], $a['card']);
    }

    /** the stake multiple for the best line of $lit cells (0 when it does not pay) */
    public function multiple(int $lit): int
    {
        return $this->pays[$lit] ?? 0;
    }

    /** the payout in minor units (stake included) */
    public function payout(int $stake, int $lit): int
    {
        return $stake * $this->multiple($lit);
    }

    public function maxMultiple(): int
    {
        return max($this->pays);
    }

    /** a stable text of everything that defines the paytable (what the frozen-file check hashes) */
    public function canonical(): string
    {
        return json_encode(['id' => $this->id, 'version' => $this->version, 'pays' => $this->pays, 'publishedRtp' => $this->publishedRtp, 'card' => $this->card], JSON_UNESCAPED_SLASHES);
    }
}
