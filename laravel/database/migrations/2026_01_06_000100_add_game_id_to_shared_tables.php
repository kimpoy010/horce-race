<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Phase 1 of the multi-game platform: the tables every game shares learn which game a row belongs to. ADDITIVE ONLY: new columns with a constant default
 * ('horse-race'), nothing renamed, dropped or changed, so the code that is running now keeps working with the new schema and every existing row is a horse-race row.
 * (On PostgreSQL 11 or later a column with a constant default is added without rewriting the table.)
 */
return new class extends Migration
{
    public function up(): void
    {
        foreach (['game_sessions', 'bets', 'pending_ops'] as $table) {
            Schema::table($table, function (Blueprint $t) {
                $t->string('game_id', 32)->default('horse-race');
            });
        }
        Schema::table('pending_ops', function (Blueprint $t) {
            $t->string('round_ref', 64)->nullable();         // the round of a game that has no race number (an instant round); null for the horse race
        });
    }

    public function down(): void
    {
        Schema::table('pending_ops', function (Blueprint $t) {
            $t->dropColumn('round_ref');
        });
        foreach (['pending_ops', 'bets', 'game_sessions'] as $table) {
            Schema::table($table, function (Blueprint $t) {
                $t->dropColumn('game_id');
            });
        }
    }
};
