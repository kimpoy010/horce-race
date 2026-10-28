<?php

namespace App\Console\Commands;

use App\Game\Clients\ClientRegistry;
use App\Game\House\HouseWallet;
use Illuminate\Console\Command;

/** Turns on the operator's own site: creates the client "house" (built-in wallet) so players can register and play here. Safe to run again. */
class HouseSetup extends Command
{
    protected $signature = 'house:setup';

    protected $description = "Enable player registration and play on this site (creates the client \"house\" with the built-in wallet)";

    public function handle(ClientRegistry $clients): int
    {
        if ($clients->get(HouseWallet::CLIENT)) {
            $this->info('The client "house" already exists.');
        } else {
            $clients->create(['id' => HouseWallet::CLIENT, 'name' => 'Own site', 'currency' => (string) config('horse.currency'), 'wallet' => ['type' => 'internal']]);
            $this->info('Created the client "house": players can register at /account and play.');
        }
        $this->line('Next: sign in at /admin, open "Players & cashier" and add your payment accounts (GCash, Maya, bank) so players know where to send deposits.');

        return self::SUCCESS;
    }
}
