<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Fruit Game: figures the consoles and alerts need without reading every round again. ADDITIVE ONLY: new nullable columns, nothing existing is changed.
 *   spin_win     the win of the spin itself, before any double-up (minor units)
 *   exp_win      what the maths expects that spin to win, for the bets of that spin (minor units, double precision)
 *   var_win      an upper bound of the variance of that win (minor units squared)
 *   doubles      double-ups played in the round; doubles_won those that were right
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('instant_rounds', function (Blueprint $t) {
            $t->unsignedBigInteger('spin_win')->nullable();
            $t->double('exp_win')->nullable();
            $t->double('var_win')->nullable();
            $t->unsignedTinyInteger('doubles')->nullable();
            $t->unsignedTinyInteger('doubles_won')->nullable();
        });
    }

    public function down(): void
    {
        Schema::table('instant_rounds', function (Blueprint $t) {
            $t->dropColumn(['spin_win', 'exp_win', 'var_win', 'doubles', 'doubles_won']);
        });
    }
};
