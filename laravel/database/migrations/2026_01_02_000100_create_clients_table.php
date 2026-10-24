<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        // the platforms that offer the game; `data` is the whole client (wallet, webhook, limits, API key hashes) as JSON with its secrets encrypted
        Schema::create('clients', function (Blueprint $t) {
            $t->string('id', 32)->primary();
            $t->string('status', 10)->default('active');
            $t->longText('data');
            $t->unsignedBigInteger('created_at');
            $t->unsignedBigInteger('updated_at');
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('clients');
    }
};
