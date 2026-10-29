<?php

namespace App\Games\BingoPinball;

/** Which cells light up for five holes, and the best line. Only the best line pays; lines never add up. */
final class Evaluator
{
    /**
     * @param  list<int>  $card  25 hole numbers, row by row
     * @param  list<int>  $holes  the five holes the balls ended in (distinct, 1..25)
     * @return array{lit:int, line:?int, litCells:list<int>, lineCells:list<int>}
     *   lit = lit cells on the best line (1..5); line = index of that line (lowest index when several lines tie), litCells = every lit cell of the card (cell indexes),
     *   lineCells = the lit cells of the best line
     */
    public static function evaluate(array $card, array $holes): array
    {
        if (count($holes) !== Card::BALLS || count(array_unique($holes)) !== Card::BALLS) {
            throw new \InvalidArgumentException('five distinct holes are needed');
        }
        $cellOf = array_flip($card);              // hole number => cell index
        $lit = [];
        foreach ($holes as $h) {
            if (! isset($cellOf[$h])) {
                throw new \InvalidArgumentException("hole $h is not on the card");
            }
            $lit[$cellOf[$h]] = true;
        }
        $best = 0;
        $bestLine = null;
        $bestCells = [];
        foreach (Card::LINES as $i => $cells) {
            $on = array_values(array_filter($cells, fn ($c) => isset($lit[$c])));
            if (count($on) > $best) {
                $best = count($on);
                $bestLine = $i;
                $bestCells = $on;
            }
        }
        $litCells = array_keys($lit);
        sort($litCells);

        return ['lit' => $best, 'line' => $bestLine, 'litCells' => $litCells, 'lineCells' => $bestCells];
    }
}
