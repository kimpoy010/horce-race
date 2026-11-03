<?php

namespace App\Platform\Ledger;

use App\Game\Ledger;
use Closure;

/**
 * Writes the events of every game into the one hash-chained ledger: each line gets the time ("t") and is chained to the one before (App\Game\Ledger does the
 * chaining and the verification). The horse race's events stay as they have always been; an event of another game carries a "game" field.
 */
final class Journal
{
    /** @param Closure(): int $now the clock in milliseconds */
    public function __construct(private Ledger $ledger, private Closure $now) {}

    public function ledger(): Ledger
    {
        return $this->ledger;
    }

    /** @param string|null $game null or 'horse-race' for the horse race: nothing is added to its events */
    public function log(array $ev, ?string $game = null): void
    {
        if ($game !== null && $game !== 'horse-race') {
            $ev = isset($ev['e']) ? ['e' => $ev['e'], 'game' => $game] + $ev : ['game' => $game] + $ev;        // the game follows the event name
        }
        $ev['t'] = ($this->now)();
        $this->ledger->append($ev);
    }
}
