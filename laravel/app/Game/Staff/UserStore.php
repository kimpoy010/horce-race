<?php

namespace App\Game\Staff;

use App\Game\Clients\SecretBox;
use App\Game\GameError;
use Closure;
use Illuminate\Support\Facades\DB;

/**
 * Back-office users: a login per person, per client, with a role (port of server/users.js).
 *   viewer   reads the reports, rounds and players
 *   support  also blocks / unblocks players and ends their sessions
 *   admin    also manages the users of the client, rotates its API key and reads the audit log
 * Passwords are argon2id hashes (the Node server used scrypt: those hashes cannot be carried over, reset the passwords). The optional second
 * factor is a standard TOTP; its secret is stored encrypted with HORSE_CLIENTS_KEY.
 */
final class UserStore
{
    public const ROLES = ['viewer' => 1, 'support' => 2, 'admin' => 3];

    private const USER_RE = '/^[a-z0-9][a-z0-9._@-]{2,63}$/';

    public function __construct(private string $secret = '', private ?Closure $clock = null, private array $argon = []) {}

    public function now(): int
    {
        return $this->clock ? ($this->clock)() : (int) floor(microtime(true) * 1000);
    }

    public static function hash(string $pw, array $argon = []): string
    {
        return password_hash($pw, PASSWORD_ARGON2ID, $argon ?: ['memory_cost' => 65536, 'time_cost' => 4, 'threads' => 1]);
    }

    public function check(string $pw, ?string $stored): bool
    {
        return $stored !== null && password_verify($pw, $stored);
    }

    public function hashPassword(string $pw): string
    {
        return self::hash($pw, $this->argon);
    }

    public static function passwordProblem(string $pw, ?string $username = null): ?string
    {
        if (mb_strlen($pw) < 12) {
            return 'The password must be at least 12 characters.';
        }
        if (mb_strlen($pw) > 128) {
            return 'The password is too long (128 characters at most).';
        }
        if (count(array_unique(mb_str_split($pw))) < 5) {
            return 'The password is too simple.';
        }
        if ($username && str_contains(strtolower($pw), strtolower($username))) {
            return 'The password must not contain the username.';
        }

        return null;
    }

    /** 4 groups of 4 letters / digits without look-alikes: easy to read out, 80 bits */
    public static function tempPassword(): string
    {
        $al = 'abcdefghjkmnpqrstuvwxyz23456789';
        $g = [];
        for ($i = 0; $i < 4; $i++) {
            $s = '';
            for ($j = 0; $j < 4; $j++) {
                $s .= $al[random_int(0, strlen($al) - 1)];
            }
            $g[] = $s;
        }

        return implode('-', $g);
    }

    private static function bad(string $m, int $status = 400, string $code = 'BAD_USER'): GameError
    {
        return new GameError($status, $code, $m);
    }

    /* ---------- reading ---------- */

    public function get(string $client, string $username): ?object
    {
        $u = DB::table('staff_users')->where('client', $client)->where('username', strtolower($username))->first();
        if ($u && $u->totp) {
            $t = json_decode($u->totp, true);
            if (! empty($t['secret'])) {
                $t['secret'] = SecretBox::decrypt($t['secret'], $this->secret);
            }
            $u->totp = $t;
        }

        return $u;
    }

    public function view(object $u): array
    {
        return ['username' => $u->username, 'role' => $u->role, 'status' => $u->status, 'mustChange' => (bool) $u->must_change, 'totp' => $this->totpEnabled($u),
            'createdAt' => (int) $u->created_at, 'lastLoginAt' => $u->last_login_at === null ? null : (int) $u->last_login_at, 'createdBy' => $u->created_by];
    }

    private function totpEnabled(object $u): bool
    {
        $t = is_string($u->totp) ? json_decode($u->totp, true) : $u->totp;

        return ! empty($t['enabled']);
    }

    /** @return list<array> */
    public function list(string $client): array
    {
        return DB::table('staff_users')->where('client', $client)->orderBy('username')->get()->map(fn ($u) => $this->view($u))->all();
    }

    public function count(string $client): int
    {
        return (int) DB::table('staff_users')->where('client', $client)->count();
    }

    public function activeAdmins(string $client): int
    {
        return (int) DB::table('staff_users')->where('client', $client)->where('role', 'admin')->where('status', 'active')->count();
    }

    private function need(string $client, string $username): object
    {
        return $this->get($client, $username) ?? throw self::bad('unknown user', 404, 'NOT_FOUND');
    }

    /* ---------- changes ---------- */

    /** creates a user; without a password a temporary one is generated (returned once) and must be changed at the first login */
    public function create(string $client, array $input, ?string $by = null): array
    {
        $username = strtolower((string) ($input['username'] ?? ''));
        if (! preg_match(self::USER_RE, $username)) {
            throw self::bad('The username needs 3 to 64 characters: letters, digits and . _ @ -');
        }
        if (! isset(self::ROLES[$input['role'] ?? ''])) {
            throw self::bad('The role must be viewer, support or admin.');
        }
        if ($this->get($client, $username)) {
            throw self::bad('This username is taken.', 409, 'USER_EXISTS');
        }
        $pw = $input['password'] ?? null;
        $temp = null;
        if ($pw) {
            if ($p = self::passwordProblem($pw, $username)) {
                throw self::bad($p, 400, 'WEAK_PASSWORD');
            }
        } else {
            $pw = $temp = self::tempPassword();
        }
        DB::table('staff_users')->insert(['client' => $client, 'username' => $username, 'role' => $input['role'], 'status' => 'active', 'pass' => $this->hashPassword($pw),
            'must_change' => empty($input['password']), 'created_at' => $this->now(), 'created_by' => $by]);

        return ['user' => $this->view($this->get($client, $username)), 'tempPassword' => $temp];
    }

    public function setRole(string $client, string $username, string $role): array
    {
        $this->need($client, $username);
        if (! isset(self::ROLES[$role])) {
            throw self::bad('bad role');
        }
        DB::table('staff_users')->where('client', $client)->where('username', strtolower($username))->update(['role' => $role]);

        return $this->view($this->get($client, $username));
    }

    public function setStatus(string $client, string $username, string $status): array
    {
        $this->need($client, $username);
        DB::table('staff_users')->where('client', $client)->where('username', strtolower($username))->update(['status' => $status === 'disabled' ? 'disabled' : 'active']);

        return $this->view($this->get($client, $username));
    }

    public function resetPassword(string $client, string $username): array
    {
        $this->need($client, $username);
        $pw = self::tempPassword();
        DB::table('staff_users')->where('client', $client)->where('username', strtolower($username))->update(['pass' => $this->hashPassword($pw), 'must_change' => true]);

        return ['user' => $this->view($this->get($client, $username)), 'tempPassword' => $pw];
    }

    public function changePassword(string $client, string $username, string $next): void
    {
        $this->need($client, $username);
        if ($p = self::passwordProblem($next, $username)) {
            throw self::bad($p, 400, 'WEAK_PASSWORD');
        }
        DB::table('staff_users')->where('client', $client)->where('username', strtolower($username))->update(['pass' => $this->hashPassword($next), 'must_change' => false]);
    }

    public function remove(string $client, string $username): void
    {
        $this->need($client, $username);
        DB::table('staff_users')->where('client', $client)->where('username', strtolower($username))->delete();
    }

    public function recordLogin(string $client, string $username): void
    {
        DB::table('staff_users')->where('client', $client)->where('username', strtolower($username))->update(['last_login_at' => $this->now()]);
    }

    /* ---------- second factor ---------- */

    private function saveTotp(string $client, string $username, ?array $t): void
    {
        if ($t && ! empty($t['secret'])) {
            $t['secret'] = SecretBox::encrypt($t['secret'], $this->secret);
        }
        DB::table('staff_users')->where('client', $client)->where('username', strtolower($username))->update(['totp' => $t ? json_encode($t) : null]);
    }

    public function totpStart(string $client, string $username): string
    {
        $this->need($client, $username);
        $secret = Totp::newSecret();
        $this->saveTotp($client, $username, ['secret' => $secret, 'enabled' => false, 'lastStep' => 0]);

        return $secret;
    }

    public function totpEnable(string $client, string $username, mixed $code): bool
    {
        $u = $this->need($client, $username);
        if (empty($u->totp['secret'])) {
            return false;
        }
        $step = Totp::check($u->totp['secret'], $code, $this->now(), 0);
        if (! $step) {
            return false;
        }
        $this->saveTotp($client, $username, ['secret' => $u->totp['secret'], 'enabled' => true, 'lastStep' => $step]);

        return true;
    }

    public function totpVerify(string $client, string $username, mixed $code): bool
    {
        $u = $this->need($client, $username);
        $step = Totp::check($u->totp['secret'], $code, $this->now(), (int) ($u->totp['lastStep'] ?? 0));
        if (! $step) {
            return false;
        }
        $this->saveTotp($client, $username, ['secret' => $u->totp['secret'], 'enabled' => true, 'lastStep' => $step]);

        return true;
    }

    public function totpDisable(string $client, string $username): void
    {
        $this->need($client, $username);
        $this->saveTotp($client, $username, null);
    }
}
