<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        // alerts that are firing now, and what happened to them (read by the overview, written by the daemon / alerts:check)
        Schema::create('alerts_active', function (Blueprint $t) {
            $t->string('name', 64)->primary();
            $t->string('severity', 10);
            $t->text('message');
            $t->unsignedBigInteger('since');
            $t->unsignedBigInteger('last_notified');
        });
        Schema::create('alert_history', function (Blueprint $t) {
            $t->id();
            $t->unsignedBigInteger('at');
            $t->json('event');
        });
        // running totals of the wallet calls (never pruned: Prometheus counters only go up): per client and operation, with a latency histogram
        Schema::create('wallet_stats', function (Blueprint $t) {
            $t->string('client', 32);
            $t->string('op', 16);
            $t->unsignedBigInteger('ok')->default(0);
            $t->unsignedBigInteger('fail')->default(0);
            $t->unsignedBigInteger('sum_ms')->default(0);
            foreach (['le50', 'le100', 'le250', 'le500', 'le1000', 'le2500', 'le5000', 'le10000'] as $b) {
                $t->unsignedBigInteger($b)->default(0);
            }
            $t->primary(['client', 'op']);
        });
        // the client of a bet, so per-client sums do not have to take the player keys apart
        Schema::table('bets', function (Blueprint $t) {
            $t->string('client_id', 32)->default('default')->index();
        });
        foreach (DB::table('bets')->select('player_key')->distinct()->pluck('player_key') as $pk) {      // bets of an earlier version
            $i = strpos($pk, ':');
            if ($i !== false) {
                DB::table('bets')->where('player_key', $pk)->update(['client_id' => substr($pk, 0, $i)]);
            }
        }
    }

    public function down(): void
    {
        Schema::table('bets', fn (Blueprint $t) => $t->dropColumn('client_id'));
        foreach (['wallet_stats', 'alert_history', 'alerts_active'] as $t) {
            Schema::dropIfExists($t);
        }
    }
};
