<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/** Bingo Pinball 16 (additive): the details of a play (balls, jackpot numbers, pattern) and the progressive jackpot pool. Existing tables only gain nullable / defaulted columns. */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('instant_rounds', function (Blueprint $t) {
            $t->json('details')->nullable();                           // a game's own result data (Bingo Pinball 16: balls, jackpot numbers, pattern, pool figures)
            $t->unsignedBigInteger('jackpot_paid')->default(0);       // the part of payout that came from a jackpot pool
        });
        Schema::create('jackpot_pools', function (Blueprint $t) {
            $t->string('id', 64)->primary();                           // <game>:<currency>
            $t->string('game_id', 32);
            $t->string('currency', 8);
            $t->unsignedBigInteger('amount');                          // the pool now (minor units)
            $t->unsignedBigInteger('seed');                            // what the pool restarts from after a win (paid by the operator)
            $t->unsignedBigInteger('contributed')->default(0);        // all stakes' contributions so far
            $t->unsignedBigInteger('paid')->default(0);               // all jackpots paid so far
            $t->unsignedBigInteger('seeded')->default(0);             // all seed money put in by the operator (first seed and every re-seed)
            $t->unsignedInteger('wins')->default(0);
            $t->unsignedBigInteger('last_win_at')->nullable();
            $t->unsignedBigInteger('updated_at');
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('jackpot_pools');
        Schema::table('instant_rounds', function (Blueprint $t) {
            $t->dropColumn(['details', 'jackpot_paid']);
        });
    }
};
