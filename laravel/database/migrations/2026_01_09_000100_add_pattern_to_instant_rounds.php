<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/** Bingo Pinball 16 (additive): the pattern of a play as a column of its own, so the consoles can count patterns without reading JSON. Existing plays are filled in from their details. */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('instant_rounds', function (Blueprint $t) {
            $t->string('pattern', 12)->nullable();
            $t->index(['game_id', 'status', 'pattern']);
        });
        DB::table('instant_rounds')->where('game_id', 'bingo-pinball-16')->whereNotNull('details')->orderBy('id')->chunkById(500, function ($rows) {
            foreach ($rows as $r) {
                $p = json_decode($r->details, true)['pattern'] ?? null;
                if ($p !== null) {
                    DB::table('instant_rounds')->where('id', $r->id)->update(['pattern' => $p]);
                }
            }
        });
    }

    public function down(): void
    {
        Schema::table('instant_rounds', function (Blueprint $t) {
            $t->dropIndex(['game_id', 'status', 'pattern']);
            $t->dropColumn('pattern');
        });
    }
};
