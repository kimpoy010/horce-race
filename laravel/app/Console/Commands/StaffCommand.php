<?php

namespace App\Console\Commands;

use App\Game\Clients\ClientRegistry;
use App\Game\GameError;
use App\Game\Staff\UserStore;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;

/**
 * Back-office logins (port of the user commands of scripts/clients.js).
 *
 * a client's back office (/backoffice):
 *   php artisan staff add-user <client> <username> --role=viewer|support|admin     prints a temporary password (changed at the first sign-in)
 *   php artisan staff list-users <client>
 *   php artisan staff reset-password <client> <username>
 *   php artisan staff disable-user|enable-user <client> <username>
 *   php artisan staff remove-user <client> <username> --yes
 * the operator's own admin console (/admin):
 *   php artisan staff add-operator <username> --role=admin|support|viewer
 *   php artisan staff list-operators | reset-operator-password <username> | disable-operator <username> | enable-operator <username> | remove-operator <username> --yes
 */
class StaffCommand extends Command
{
    protected $signature = 'staff {action : add-user|list-users|reset-password|disable-user|enable-user|remove-user|add-operator|list-operators|reset-operator-password|disable-operator|enable-operator|remove-operator} {a?} {b?} {--role=admin} {--yes}';

    protected $description = 'Manage back-office logins (client staff and the operator\'s admin console staff)';

    public function handle(UserStore $us, ClientRegistry $clients): int
    {
        $action = $this->argument('action');
        $op = str_ends_with($action, '-operator') || $action === 'list-operators';
        $client = $op ? '_operator' : (string) $this->argument('a');
        $name = $op ? (string) $this->argument('a') : (string) $this->argument('b');
        try {
            if (! $client) {
                throw new GameError(400, 'BAD_USER', 'give the client id');
            }
            if (! $op && ! $clients->get($client) && $client !== 'default' && $action !== 'list-users') {
                throw new GameError(404, 'NOT_FOUND', "unknown client $client");
            }
            switch ($action) {
                case 'list-users':
                case 'list-operators':
                    foreach ($us->list($client) as $u) {
                        $this->line(str_pad($u['username'], 24).str_pad($u['role'], 10).str_pad($u['status'], 10).($u['totp'] ? '2fa ' : '    ').($u['mustChange'] ? 'must change password' : ''));
                    }
                    break;
                case 'add-user':
                case 'add-operator':
                    $r = $us->create($client, ['username' => $name, 'role' => $this->option('role')], 'cli');
                    $this->line('created '.$r['user']['username'].' ('.$r['user']['role'].'). Temporary password (shown once, changed at the first sign-in):');
                    $this->line('  '.$r['tempPassword']);
                    break;
                case 'reset-password':
                case 'reset-operator-password':
                    $r = $us->resetPassword($client, $name);
                    $this->line('Temporary password for '.$name.': '.$r['tempPassword']);
                    $this->endSessions($client, $name);
                    break;
                case 'disable-user':
                case 'enable-user':
                case 'disable-operator':
                case 'enable-operator':
                    $off = str_starts_with($action, 'disable');
                    $us->setStatus($client, $name, $off ? 'disabled' : 'active');
                    $this->line($name.($off ? ' disabled' : ' enabled'));
                    if ($off) {
                        $this->endSessions($client, $name);
                    }
                    break;
                case 'remove-user':
                case 'remove-operator':
                    if (! $this->option('yes')) {
                        throw new GameError(400, 'BAD_USER', 'add --yes to remove '.$name);
                    }
                    $us->remove($client, $name);
                    $this->endSessions($client, $name);
                    $this->line($name.' removed');
                    break;
                default:
                    throw new GameError(400, 'BAD_USER', 'unknown action');
            }
        } catch (GameError $e) {
            $this->error('Error: '.$e->getMessage());

            return self::FAILURE;
        }

        return self::SUCCESS;
    }

    private function endSessions(string $client, string $name): void
    {
        DB::table('staff_sessions')->where('client', $client)->where('username', strtolower($name))->delete();
    }
}
