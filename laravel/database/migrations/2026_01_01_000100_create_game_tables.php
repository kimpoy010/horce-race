<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        // append-only audit log, hash chained (App\Game\Ledger)
        Schema::create('ledger', function (Blueprint $t) {
            $t->bigIncrements('seq');
            $t->text('line');
            $t->timestamp('created_at')->useCurrent();
        });
        Schema::create('ledger_state', function (Blueprint $t) {
            $t->unsignedTinyInteger('id')->primary();
            $t->string('head', 64);
            $t->unsignedBigInteger('lines')->default(0);
        });

        Schema::create('rounds', function (Blueprint $t) {
            $t->unsignedBigInteger('race_no')->primary();
            $t->string('seed', 64);
            $t->string('commit', 64);
            $t->json('odds');
            $t->decimal('rtp', 6, 4);
            $t->unsignedBigInteger('open_at');
            $t->unsignedBigInteger('bet_close_at');
            $t->string('status', 12)->index();                   // betting | racing | settled
            $t->string('combo', 3)->nullable();
            $t->json('order')->nullable();
            $t->unsignedBigInteger('anim_seed')->nullable();
            $t->unsignedBigInteger('start_at')->nullable();
            $t->unsignedBigInteger('settled_at')->nullable();
            $t->unsignedBigInteger('staked')->default(0);
            $t->unsignedBigInteger('paid')->default(0);
        });

        Schema::create('bets', function (Blueprint $t) {
            $t->string('id', 80)->primary();                     // <batch>:<combo>
            $t->unsignedBigInteger('race_no')->index();
            $t->string('player_key', 100)->index();
            $t->string('combo', 3);
            $t->unsignedBigInteger('stake');
            $t->string('status', 10)->default('open');          // open | won | lost | refunded
            $t->unsignedBigInteger('payout')->default(0);
            $t->string('currency', 8);
            $t->string('brand_id', 64)->nullable();
            $t->unsignedBigInteger('placed_at')->index();
        });

        Schema::create('game_sessions', function (Blueprint $t) {
            $t->string('key', 64)->primary();                    // sha256 of the session id the player holds
            $t->string('player_key', 100)->index();
            $t->string('raw_id', 64);
            $t->string('client_id', 64)->default('default');
            $t->string('brand_id', 64)->nullable();
            $t->string('currency', 8);
            $t->unsignedTinyInteger('decimals')->default(2);
            $t->bigInteger('balance')->nullable();
            $t->text('return_url')->nullable();
            $t->json('limits');
            $t->unsignedInteger('reality_minutes')->default(0);
            $t->unsignedBigInteger('s_staked')->default(0);
            $t->unsignedBigInteger('s_paid')->default(0);
            $t->unsignedBigInteger('created_at');
            $t->unsignedBigInteger('expires_at')->index();
            $t->unsignedBigInteger('refreshed_at');
        });

        // wallet calls still to be delivered: credits (wins, refunds) and rollbacks of debits with an unknown outcome
        Schema::create('pending_ops', function (Blueprint $t) {
            $t->string('tx_id', 120)->primary();
            $t->string('kind', 10);                              // credit | rollback
            $t->string('player_key', 100);
            $t->unsignedBigInteger('amount');
            $t->unsignedBigInteger('race_no')->nullable();
            $t->string('tx_kind', 12)->nullable();               // win | refund
            $t->json('extra')->nullable();
            $t->unsignedBigInteger('since');
            $t->unsignedInteger('tries')->default(0);
            $t->unsignedBigInteger('next_at')->default(0)->index();
        });

        Schema::create('settings', function (Blueprint $t) {
            $t->string('key', 64)->primary();
            $t->text('value');
        });
        Schema::create('blocked_players', function (Blueprint $t) {
            $t->string('player_key', 100)->primary();
            $t->string('who', 64)->nullable();
            $t->timestamp('created_at')->useCurrent();
        });

        // play-money wallet (WALLET=mock only)
        Schema::create('mock_accounts', function (Blueprint $t) {
            $t->string('player_id', 64)->primary();
            $t->bigInteger('balance');
        });
        Schema::create('mock_tx', function (Blueprint $t) {
            $t->string('tx_id', 120)->primary();
            $t->bigInteger('amount');
            $t->boolean('cancelled')->default(false);
        });

        if (DB::getDriverName() === 'pgsql') {          // the ledger cannot be changed afterwards, not even by the application
            DB::unprepared("CREATE FUNCTION ledger_immutable() RETURNS trigger AS \$\$ BEGIN RAISE EXCEPTION 'the ledger is append-only'; END \$\$ LANGUAGE plpgsql");
            DB::unprepared('CREATE TRIGGER ledger_no_change BEFORE UPDATE OR DELETE ON ledger FOR EACH ROW EXECUTE FUNCTION ledger_immutable()');
        }
    }

    public function down(): void
    {
        if (DB::getDriverName() === 'pgsql') {
            DB::unprepared('DROP TRIGGER IF EXISTS ledger_no_change ON ledger');
            DB::unprepared('DROP FUNCTION IF EXISTS ledger_immutable()');
        }
        foreach (['mock_tx', 'mock_accounts', 'blocked_players', 'settings', 'pending_ops', 'game_sessions', 'bets', 'rounds', 'ledger_state', 'ledger'] as $t) {
            Schema::dropIfExists($t);
        }
    }
};
