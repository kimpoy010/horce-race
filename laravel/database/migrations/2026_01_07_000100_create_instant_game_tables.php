<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * Instant games (Bingo Pinball): one round per play, and the provably fair seeds behind it. ADDITIVE ONLY: two new tables, nothing existing is changed.
 */
return new class extends Migration
{
    public function up(): void
    {
        // the seed pairs of a player in a game. The server seed is stored encrypted (SecretBox); once a pair is revealed the seed is public and the pair is closed.
        Schema::create('player_seeds', function (Blueprint $t) {
            $t->id();
            $t->string('player_key', 100);
            $t->string('game_id', 32);
            $t->text('server_seed');                          // enc:v1:...
            $t->string('commit', 64);                         // sha256 of the server seed, shown before the first play
            $t->string('client_seed', 64);
            $t->unsignedBigInteger('next_nonce')->default(1); // the nonce of the next play under this pair
            $t->string('status', 10)->default('active');      // active | revealed
            $t->unsignedBigInteger('created_at');
            $t->unsignedBigInteger('revealed_at')->nullable();
            $t->index(['player_key', 'game_id', 'status']);
        });

        // one row per play
        Schema::create('instant_rounds', function (Blueprint $t) {
            $t->id();
            $t->string('game_id', 32);
            $t->string('player_key', 100);
            $t->string('client_id', 64);
            $t->unsignedBigInteger('seed_id')->nullable();    // the seed pair of the draw (set when it is drawn)
            $t->unsignedBigInteger('nonce')->nullable();
            $t->unsignedBigInteger('stake');
            $t->string('currency', 8);
            $t->string('brand_id', 64)->nullable();
            $t->string('paytable_id', 32);                    // for example bp-v96-1: what this play was paid under
            $t->unsignedSmallInteger('paytable_version');
            $t->json('holes')->nullable();                    // the holes the balls ended in, in order
            $t->unsignedTinyInteger('best_lit')->nullable();
            $t->unsignedTinyInteger('best_line')->nullable();
            $t->unsignedInteger('multiple')->nullable();
            $t->unsignedBigInteger('payout')->default(0);
            $t->string('status', 10);                         // debiting | settled | void
            $t->string('request_id', 64);                     // chosen by the player's page: a repeated request returns this round
            $t->unsignedBigInteger('created_at');
            $t->unsignedBigInteger('settled_at')->nullable();
            $t->unsignedBigInteger('seen_at')->nullable();    // when the player's page said it showed the result
            $t->unique(['player_key', 'request_id']);
            $t->index(['player_key', 'id']);
            $t->index(['client_id', 'created_at']);
            $t->index(['status', 'created_at']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('instant_rounds');
        Schema::dropIfExists('player_seeds');
    }
};
