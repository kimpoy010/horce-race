<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/** The operator's own site: player accounts, the built-in wallet and the cashier (manual deposits and withdrawals). Money is integer centavos. */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('players', function (Blueprint $t) {
            $t->id();
            $t->string('username', 32)->unique();           // lower case
            $t->string('mobile', 20)->nullable()->unique(); // 09xxxxxxxxx
            $t->string('email', 120)->nullable();
            $t->string('pass');                             // argon2id
            $t->string('status', 10)->default('active');    // active | suspended
            $t->bigInteger('balance')->default(0);          // centavos
            $t->unsignedBigInteger('terms_at');
            $t->unsignedBigInteger('over18_at');
            $t->unsignedBigInteger('created_at');
            $t->unsignedBigInteger('last_login_at')->nullable();
            $t->string('created_ip', 64)->nullable();
            $t->text('note')->nullable();                   // staff note
        });
        Schema::create('player_sessions', function (Blueprint $t) {
            $t->string('token_hash', 64)->primary();
            $t->unsignedBigInteger('player_id')->index();
            $t->string('csrf', 32);
            $t->unsignedBigInteger('created_at');
            $t->unsignedBigInteger('last_seen');
            $t->string('ip', 64)->nullable();
        });
        Schema::create('launch_tokens', function (Blueprint $t) {   // one-time tokens that start a game session for a signed-in player
            $t->string('token_hash', 64)->primary();
            $t->unsignedBigInteger('player_id');
            $t->unsignedBigInteger('expires_at')->index();
        });
        // every change of a balance, once (tx_id is unique: a repeated call is applied once)
        Schema::create('wallet_tx', function (Blueprint $t) {
            $t->id();
            $t->unsignedBigInteger('player_id')->index();
            $t->string('tx_id', 100)->unique();
            $t->string('type', 20);                         // bet | win | rollback | deposit | withdraw_hold | withdraw_release | adjust
            $t->bigInteger('amount');                       // signed
            $t->bigInteger('balance_after');
            $t->string('ref', 200)->nullable();
            $t->unsignedBigInteger('created_at');
        });
        Schema::create('deposits', function (Blueprint $t) {
            $t->id();
            $t->unsignedBigInteger('player_id')->index();
            $t->bigInteger('amount');
            $t->string('method', 20);
            $t->string('sender_name', 80);
            $t->string('sender_number', 40)->nullable();
            $t->string('reference', 40);                    // the payment's own reference number
            $t->string('status', 10)->default('pending')->index();   // pending | approved | rejected
            $t->string('note', 200)->nullable();
            $t->string('decided_by', 64)->nullable();
            $t->unsignedBigInteger('decided_at')->nullable();
            $t->unsignedBigInteger('created_at');
            $t->unique(['method', 'reference']);            // one receipt, one deposit
        });
        Schema::create('withdrawals', function (Blueprint $t) {
            $t->id();
            $t->unsignedBigInteger('player_id')->index();
            $t->bigInteger('amount');
            $t->string('method', 20);
            $t->string('account_name', 80);
            $t->string('account_number', 40);
            $t->string('status', 10)->default('pending')->index();  // pending | paid | rejected
            $t->string('note', 200)->nullable();
            $t->string('payout_ref', 60)->nullable();
            $t->string('decided_by', 64)->nullable();
            $t->unsignedBigInteger('decided_at')->nullable();
            $t->unsignedBigInteger('created_at');
        });
        if (DB::getDriverName() === 'pgsql') {          // wallet movements cannot be changed afterwards
            DB::unprepared("CREATE OR REPLACE FUNCTION wallet_tx_immutable() RETURNS trigger AS \$\$ BEGIN RAISE EXCEPTION 'wallet_tx is append-only'; END \$\$ LANGUAGE plpgsql");
            DB::unprepared('CREATE TRIGGER wallet_tx_no_change BEFORE UPDATE OR DELETE ON wallet_tx FOR EACH ROW EXECUTE FUNCTION wallet_tx_immutable()');
        }
    }

    public function down(): void
    {
        if (DB::getDriverName() === 'pgsql') {
            DB::unprepared('DROP TRIGGER IF EXISTS wallet_tx_no_change ON wallet_tx');
            DB::unprepared('DROP FUNCTION IF EXISTS wallet_tx_immutable()');
        }
        foreach (['withdrawals', 'deposits', 'wallet_tx', 'launch_tokens', 'player_sessions', 'players'] as $t) {
            Schema::dropIfExists($t);
        }
    }
};
