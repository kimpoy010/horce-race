<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        // people who sign in to a back office (client = a registry client) or to the operator's admin console (client = "_operator")
        Schema::create('staff_users', function (Blueprint $t) {
            $t->id();
            $t->string('client', 32);
            $t->string('username', 64);
            $t->string('role', 10);                       // viewer | support | admin
            $t->string('status', 10)->default('active');  // active | disabled
            $t->string('pass');                           // argon2id hash
            $t->boolean('must_change')->default(false);
            $t->text('totp')->nullable();                 // {"secret": "enc:v1:...", "enabled": bool, "lastStep": int}
            $t->unsignedBigInteger('created_at');
            $t->string('created_by', 64)->nullable();
            $t->unsignedBigInteger('last_login_at')->nullable();
            $t->unique(['client', 'username']);
        });
        Schema::create('staff_sessions', function (Blueprint $t) {
            $t->string('token_hash', 64)->primary();
            $t->string('area', 8);                        // bo | admin (two cookies, two areas)
            $t->string('client', 32);
            $t->string('username', 64);
            $t->string('csrf', 32);
            $t->unsignedBigInteger('created_at');
            $t->unsignedBigInteger('last_seen');
            $t->string('ip', 64)->nullable();
            $t->index(['client', 'username']);
        });
        // what staff did (shown in the back office audit log); the same entries are in the ledger as bo_action
        Schema::create('audit_log', function (Blueprint $t) {
            $t->id();
            $t->string('client', 32)->index();
            $t->unsignedBigInteger('at');
            $t->json('entry');
        });
        // timings of the calls to the platforms' wallets (the overview and /metrics read the last minutes)
        Schema::create('wallet_calls', function (Blueprint $t) {
            $t->id();
            $t->unsignedBigInteger('at')->index();
            $t->string('client', 32);
            $t->string('op', 16);
            $t->unsignedInteger('ms');
            $t->boolean('ok');
        });
    }

    public function down(): void
    {
        foreach (['wallet_calls', 'audit_log', 'staff_sessions', 'staff_users'] as $t) {
            Schema::dropIfExists($t);
        }
    }
};
