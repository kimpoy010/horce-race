<?php

namespace App\Game\House;

use App\Game\Engine;
use App\Game\GameError;
use App\Game\Staff\UserStore;
use App\Game\Wallet\WalletException;
use Illuminate\Database\UniqueConstraintViolationException;
use Illuminate\Support\Facades\DB;

/**
 * The operator's own site: player accounts and the cashier. Players deposit by sending money to one of the operator's accounts (GCash, Maya, bank)
 * and telling us the reference number; staff approve the deposit in the admin console and the balance is credited. A withdrawal holds the amount at
 * once and staff pay it out by hand, then mark it paid (or reject it: the amount goes back). Every movement is one idempotent wallet_tx row.
 */
final class House
{
    public const DECIMALS = 2;

    public const DEFAULTS = [
        'methods' => [],                       // [{id, label, accountName, accountNumber, note}]
        'minDeposit' => 10000, 'maxDeposit' => 5000000,
        'minWithdraw' => 20000, 'maxWithdraw' => 5000000,
        'registration' => true,                // false = closed for new players
    ];

    public function __construct(private Engine $engine, private array $argon = []) {}

    private function now(): int
    {
        return $this->engine->now();
    }

    private static function bad(string $code, string $message, int $status = 400): GameError
    {
        return new GameError($status, $code, $message);
    }

    /* ---------- settings ---------- */

    public function settings(): array
    {
        $raw = DB::table('settings')->where('key', 'house.payment')->value('value');
        $s = $raw ? json_decode($raw, true) : [];

        return array_merge(self::DEFAULTS, is_array($s) ? $s : []);
    }

    /** what a player may see: the accounts to pay to and the limits */
    public function publicSettings(): array
    {
        $s = $this->settings();

        return ['methods' => $s['methods'], 'minDeposit' => $s['minDeposit'], 'maxDeposit' => $s['maxDeposit'], 'minWithdraw' => $s['minWithdraw'], 'maxWithdraw' => $s['maxWithdraw'],
            'registration' => (bool) $s['registration'], 'enabled' => $this->engine->clientActive(HouseWallet::CLIENT), 'decimals' => self::DECIMALS, 'currency' => (string) config('horse.currency')];
    }

    public function saveSettings(array $in): array
    {
        $s = $this->settings();
        foreach (['minDeposit', 'maxDeposit', 'minWithdraw', 'maxWithdraw'] as $k) {
            if (array_key_exists($k, $in)) {
                if (! is_int($in[$k]) || $in[$k] < 100 || $in[$k] > 1000000000) {
                    throw self::bad('BAD_SETTINGS', "$k must be a whole number of centavos (at least 100)");
                }
                $s[$k] = $in[$k];
            }
        }
        if ($s['minDeposit'] > $s['maxDeposit'] || $s['minWithdraw'] > $s['maxWithdraw']) {
            throw self::bad('BAD_SETTINGS', 'a minimum is above its maximum');
        }
        if (array_key_exists('registration', $in)) {
            $s['registration'] = (bool) $in['registration'];
        }
        if (array_key_exists('methods', $in)) {
            if (! is_array($in['methods']) || count($in['methods']) > 8) {
                throw self::bad('BAD_SETTINGS', 'methods: a list of at most 8 payment accounts');
            }
            $ids = [];
            $s['methods'] = array_map(function ($m) use (&$ids) {
                $id = strtolower((string) ($m['id'] ?? ''));
                if (! preg_match('/^[a-z0-9]{2,20}$/', $id) || in_array($id, $ids, true)) {
                    throw self::bad('BAD_SETTINGS', 'each method needs a unique id (letters and digits, 2 to 20), for example gcash');
                }
                $ids[] = $id;
                $label = trim((string) ($m['label'] ?? ''));
                $num = trim((string) ($m['accountNumber'] ?? ''));
                if ($label === '' || $num === '') {
                    throw self::bad('BAD_SETTINGS', "method $id needs a label and an account number");
                }

                return ['id' => $id, 'label' => mb_substr($label, 0, 40), 'accountName' => mb_substr(trim((string) ($m['accountName'] ?? '')), 0, 80),
                    'accountNumber' => mb_substr($num, 0, 40), 'note' => mb_substr(trim((string) ($m['note'] ?? '')), 0, 200)];
            }, $in['methods']);
        }
        DB::table('settings')->updateOrInsert(['key' => 'house.payment'], ['value' => json_encode($s, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES)]);

        return $s;
    }

    private function method(string $id): array
    {
        foreach ($this->settings()['methods'] as $m) {
            if ($m['id'] === $id) {
                return $m;
            }
        }
        throw self::bad('BAD_METHOD', 'Choose one of the payment methods shown.');
    }

    /* ---------- players ---------- */

    public static function normaliseMobile(string $m): string
    {
        $m = preg_replace('/[\s\-()]/', '', $m);
        if (preg_match('/^\+639(\d{9})$/', $m, $x) || preg_match('/^639(\d{9})$/', $m, $x)) {
            return '09'.$x[1];
        }

        return $m;
    }

    public function checkPassword(string $pw, string $username = ''): void
    {
        if (strlen($pw) < 8 || strlen($pw) > 200) {
            throw self::bad('WEAK_PASSWORD', 'The password must be at least 8 characters.');
        }
        if ($username !== '' && strtolower($pw) === strtolower($username)) {
            throw self::bad('WEAK_PASSWORD', 'The password must not be your username.');
        }
    }

    public function hash(string $pw): string
    {
        return UserStore::hash($pw, $this->argon);
    }

    /** @return object the new player row */
    public function register(array $in, string $ip): object
    {
        if (! $this->settings()['registration']) {
            throw self::bad('REGISTRATION_CLOSED', 'Registration is closed right now.', 403);
        }
        $user = strtolower(trim((string) ($in['username'] ?? '')));
        if (! preg_match('/^[a-z][a-z0-9_]{3,19}$/', $user)) {
            throw self::bad('BAD_USERNAME', 'The username needs 4 to 20 letters, digits or _, starting with a letter.');
        }
        $mobile = self::normaliseMobile((string) ($in['mobile'] ?? ''));
        if (! preg_match('/^09\d{9}$/', $mobile)) {
            throw self::bad('BAD_MOBILE', 'Enter a Philippine mobile number such as 09171234567.');
        }
        $email = trim((string) ($in['email'] ?? ''));
        if ($email !== '' && (! filter_var($email, FILTER_VALIDATE_EMAIL) || strlen($email) > 120)) {
            throw self::bad('BAD_EMAIL', 'That e-mail address does not look right.');
        }
        $this->checkPassword((string) ($in['password'] ?? ''), $user);
        if (empty($in['over18']) || empty($in['terms'])) {
            throw self::bad('CONSENT_REQUIRED', 'You must be 18 or older and accept the terms.');
        }
        $t = $this->now();
        try {
            $row = ['username' => $user, 'mobile' => $mobile, 'email' => $email ?: null, 'pass' => $this->hash((string) $in['password']),
                'status' => 'active', 'balance' => 0, 'terms_at' => $t, 'over18_at' => $t, 'created_at' => $t, 'created_ip' => $ip];
            $id = DB::transaction(fn () => DB::table('players')->insertGetId($row));          // own savepoint: a duplicate must not poison an outer PostgreSQL transaction
        } catch (UniqueConstraintViolationException $e) {
            $dup = DB::table('players')->where('username', $user)->exists();
            throw self::bad($dup ? 'USERNAME_TAKEN' : 'MOBILE_TAKEN', $dup ? 'That username is taken.' : 'That mobile number is already registered.', 409);
        }
        $this->engine->log(['e' => 'player_registered', 'playerId' => 'p'.$id]);

        return DB::table('players')->where('id', $id)->first();
    }

    public function player(int $id): ?object
    {
        return DB::table('players')->where('id', $id)->first();
    }

    /** what a player sees about themselves */
    public function view(object $p): array
    {
        return ['username' => $p->username, 'mobile' => $p->mobile, 'email' => $p->email, 'balance' => (int) $p->balance, 'status' => $p->status];
    }

    public function launchToken(object $p): string
    {
        if ($p->status !== 'active') {
            throw self::bad('ACCOUNT_SUSPENDED', 'This account is suspended. Contact support.', 403);
        }
        $token = bin2hex(random_bytes(24));
        DB::table('launch_tokens')->where('expires_at', '<', $this->now())->delete();
        DB::table('launch_tokens')->insert(['token_hash' => hash('sha256', $token), 'player_id' => $p->id, 'expires_at' => $this->now() + 60000]);

        return $token;
    }

    public function changePassword(object $p, string $current, string $next): void
    {
        if (! password_verify($current, $p->pass)) {
            throw self::bad('BAD_PASSWORD', 'The current password is wrong.', 403);
        }
        $this->checkPassword($next, $p->username);
        DB::table('players')->where('id', $p->id)->update(['pass' => $this->hash($next)]);
    }

    /* ---------- deposits ---------- */

    public function requestDeposit(object $p, array $in): int
    {
        if ($p->status !== 'active') {
            throw self::bad('ACCOUNT_SUSPENDED', 'This account is suspended. Contact support.', 403);
        }
        $s = $this->settings();
        $m = $this->method((string) ($in['method'] ?? ''));
        $amount = $in['amount'] ?? null;
        if (! is_int($amount) || $amount < $s['minDeposit'] || $amount > $s['maxDeposit']) {
            throw self::bad('BAD_AMOUNT', 'The deposit must be between '.self::fmt($s['minDeposit']).' and '.self::fmt($s['maxDeposit']).'.');
        }
        $name = trim((string) ($in['senderName'] ?? ''));
        $ref = strtoupper(trim((string) ($in['reference'] ?? '')));
        if ($name === '' || mb_strlen($name) > 80) {
            throw self::bad('BAD_SENDER', 'Enter the name of the account you paid from.');
        }
        if (! preg_match('/^[A-Z0-9\-]{4,40}$/', $ref)) {
            throw self::bad('BAD_REFERENCE', 'Enter the reference number of your payment (4 to 40 letters and digits).');
        }
        if (DB::table('deposits')->where('player_id', $p->id)->where('status', 'pending')->count() >= 3) {
            throw self::bad('TOO_MANY_PENDING', 'You already have 3 deposits waiting for approval.', 429);
        }
        try {
            $row = ['player_id' => $p->id, 'amount' => $amount, 'method' => $m['id'], 'sender_name' => $name,
                'sender_number' => mb_substr(trim((string) ($in['senderNumber'] ?? '')), 0, 40) ?: null, 'reference' => $ref, 'status' => 'pending', 'created_at' => $this->now()];

            return (int) DB::transaction(fn () => DB::table('deposits')->insertGetId($row));
        } catch (UniqueConstraintViolationException $e) {
            throw self::bad('REFERENCE_USED', 'That reference number was already submitted.', 409);
        }
    }

    public function decideDeposit(int $id, bool $approve, string $who, string $note = ''): object
    {
        return DB::transaction(function () use ($id, $approve, $who, $note) {
            $d = DB::table('deposits')->where('id', $id)->lockForUpdate()->first();
            if (! $d) {
                throw self::bad('NOT_FOUND', 'Unknown deposit.', 404);
            }
            if ($d->status !== 'pending') {
                throw self::bad('ALREADY_DECIDED', 'This deposit was already '.$d->status.'.', 409);
            }
            if ($approve) {
                HouseWallet::post((int) $d->player_id, (int) $d->amount, 'dep:'.$id, 'deposit', $d->method.' '.$d->reference);
            }
            DB::table('deposits')->where('id', $id)->update(['status' => $approve ? 'approved' : 'rejected', 'decided_by' => $who, 'decided_at' => $this->now(), 'note' => mb_substr($note, 0, 200) ?: null]);
            $this->engine->log(['e' => $approve ? 'deposit_approved' : 'deposit_rejected', 'playerId' => 'p'.$d->player_id, 'depositId' => $id, 'amount' => (int) $d->amount, 'who' => $who]);

            return DB::table('deposits')->where('id', $id)->first();
        });
    }

    /* ---------- withdrawals ---------- */

    public function requestWithdrawal(object $p, array $in): int
    {
        if ($p->status !== 'active') {
            throw self::bad('ACCOUNT_SUSPENDED', 'This account is suspended. Contact support.', 403);
        }
        $s = $this->settings();
        $m = $this->method((string) ($in['method'] ?? ''));
        $amount = $in['amount'] ?? null;
        if (! is_int($amount) || $amount < $s['minWithdraw'] || $amount > $s['maxWithdraw']) {
            throw self::bad('BAD_AMOUNT', 'The withdrawal must be between '.self::fmt($s['minWithdraw']).' and '.self::fmt($s['maxWithdraw']).'.');
        }
        $name = trim((string) ($in['accountName'] ?? ''));
        $num = trim((string) ($in['accountNumber'] ?? ''));
        if ($name === '' || mb_strlen($name) > 80 || ! preg_match('/^[0-9A-Za-z\- ]{4,40}$/', $num)) {
            throw self::bad('BAD_ACCOUNT', 'Enter the name and number of the account to pay.');
        }

        return DB::transaction(function () use ($p, $m, $amount, $name, $num) {
            DB::table('players')->where('id', $p->id)->lockForUpdate()->first();
            if (DB::table('withdrawals')->where('player_id', $p->id)->where('status', 'pending')->exists()) {
                throw self::bad('PENDING_EXISTS', 'You already have a withdrawal waiting to be paid.', 429);
            }
            $id = (int) DB::table('withdrawals')->insertGetId(['player_id' => $p->id, 'amount' => $amount, 'method' => $m['id'], 'account_name' => $name, 'account_number' => $num, 'status' => 'pending', 'created_at' => $this->now()]);
            try {
                HouseWallet::post((int) $p->id, -$amount, 'wd:'.$id, 'withdraw_hold', $m['id']);       // the money leaves the balance now
            } catch (WalletException $e) {
                throw self::bad('INSUFFICIENT_FUNDS', 'Your balance is too low for this withdrawal.', 402);
            }

            return $id;
        });
    }

    public function decideWithdrawal(int $id, bool $pay, string $who, string $payoutRef = '', string $note = ''): object
    {
        return DB::transaction(function () use ($id, $pay, $who, $payoutRef, $note) {
            $w = DB::table('withdrawals')->where('id', $id)->lockForUpdate()->first();
            if (! $w) {
                throw self::bad('NOT_FOUND', 'Unknown withdrawal.', 404);
            }
            if ($w->status !== 'pending') {
                throw self::bad('ALREADY_DECIDED', 'This withdrawal was already '.$w->status.'.', 409);
            }
            if ($pay && trim($payoutRef) === '') {
                throw self::bad('REFERENCE_REQUIRED', 'Enter the reference of the payout you made.');
            }
            if (! $pay) {
                HouseWallet::post((int) $w->player_id, (int) $w->amount, 'wdr:'.$id, 'withdraw_release', 'rejected');      // the held amount goes back
            }
            DB::table('withdrawals')->where('id', $id)->update(['status' => $pay ? 'paid' : 'rejected', 'decided_by' => $who, 'decided_at' => $this->now(),
                'payout_ref' => $pay ? mb_substr(trim($payoutRef), 0, 60) : null, 'note' => mb_substr($note, 0, 200) ?: null]);
            $this->engine->log(['e' => $pay ? 'withdrawal_paid' : 'withdrawal_rejected', 'playerId' => 'p'.$w->player_id, 'withdrawalId' => $id, 'amount' => (int) $w->amount, 'who' => $who]);

            return DB::table('withdrawals')->where('id', $id)->first();
        });
    }

    /* ---------- staff actions ---------- */

    public function adjust(int $playerId, int $amount, string $reason, string $who): int
    {
        if ($amount === 0 || abs($amount) > 1000000000 || trim($reason) === '') {
            throw self::bad('BAD_REQUEST', 'Give a non-zero amount and a reason.');
        }
        try {
            [$bal] = HouseWallet::post($playerId, $amount, 'adj:'.bin2hex(random_bytes(8)), 'adjust', mb_substr($who.': '.$reason, 0, 200));
        } catch (WalletException $e) {
            throw self::bad('INSUFFICIENT_FUNDS', 'The balance cannot go below zero.', 402);
        }
        $this->engine->log(['e' => 'wallet_adjusted', 'playerId' => 'p'.$playerId, 'amount' => $amount, 'reason' => mb_substr($reason, 0, 200), 'who' => $who]);

        return $bal;
    }

    public function setStatus(int $playerId, string $status, string $who): void
    {
        if (! in_array($status, ['active', 'suspended'], true) || ! $this->player($playerId)) {
            throw self::bad('NOT_FOUND', 'Unknown player or status.', 404);
        }
        DB::table('players')->where('id', $playerId)->update(['status' => $status]);
        $pk = Engine::pk(HouseWallet::CLIENT, 'p'.$playerId);
        if ($status === 'suspended') {
            DB::table('player_sessions')->where('player_id', $playerId)->delete();
            $this->engine->blockPlayer($pk, $who);                          // ends the live game sessions, refuses new bets
        } else {
            $this->engine->unblockPlayer($pk, $who);
        }
    }

    public function resetPassword(int $playerId): string
    {
        $temp = substr(bin2hex(random_bytes(8)), 0, 10).'Aa1';
        DB::table('players')->where('id', $playerId)->update(['pass' => $this->hash($temp)]);
        DB::table('player_sessions')->where('player_id', $playerId)->delete();

        return $temp;
    }

    public function note(int $playerId, string $note): void
    {
        DB::table('players')->where('id', $playerId)->update(['note' => mb_substr($note, 0, 500) ?: null]);
    }

    /* ---------- lists ---------- */

    public static function fmt(int $minor): string
    {
        return number_format($minor / 100, 2);
    }

    public function summary(): array
    {
        $d = DB::table('deposits');
        $w = DB::table('withdrawals');

        return ['players' => (int) DB::table('players')->count(), 'suspended' => (int) DB::table('players')->where('status', 'suspended')->count(),
            'balances' => (int) DB::table('players')->sum('balance'),
            'pendingDeposits' => (int) (clone $d)->where('status', 'pending')->count(), 'pendingDepositAmount' => (int) (clone $d)->where('status', 'pending')->sum('amount'),
            'pendingWithdrawals' => (int) (clone $w)->where('status', 'pending')->count(), 'pendingWithdrawalAmount' => (int) (clone $w)->where('status', 'pending')->sum('amount'),
            'deposited' => (int) (clone $d)->where('status', 'approved')->sum('amount'), 'withdrawn' => (int) (clone $w)->where('status', 'paid')->sum('amount'),
            'registrationOpen' => (bool) $this->settings()['registration']];
    }

    public function players(string $q = '', int $limit = 50): array
    {
        $r = DB::table('players')->orderByDesc('id')->limit(max(1, min(200, $limit)));
        if ($q !== '') {
            $like = '%'.str_replace(['%', '_'], ['\\%', '\\_'], strtolower($q)).'%';
            $r->where(fn ($w) => $w->where('username', 'like', $like)->orWhere('mobile', 'like', $like));
        }

        return $r->get()->map(fn ($p) => ['id' => (int) $p->id, 'username' => $p->username, 'mobile' => $p->mobile, 'status' => $p->status, 'balance' => (int) $p->balance,
            'createdAt' => (int) $p->created_at, 'lastLoginAt' => $p->last_login_at ? (int) $p->last_login_at : null])->all();
    }

    public function detail(int $id): ?array
    {
        $p = $this->player($id);
        if (! $p) {
            return null;
        }

        return ['player' => ['id' => (int) $p->id, 'username' => $p->username, 'mobile' => $p->mobile, 'email' => $p->email, 'status' => $p->status, 'balance' => (int) $p->balance,
            'createdAt' => (int) $p->created_at, 'lastLoginAt' => $p->last_login_at ? (int) $p->last_login_at : null, 'createdIp' => $p->created_ip, 'note' => $p->note],
            'tx' => $this->txOf($id, 50), 'deposits' => $this->depositsOf($id, 20), 'withdrawals' => $this->withdrawalsOf($id, 20)];
    }

    public function txOf(int $id, int $limit = 30): array
    {
        return DB::table('wallet_tx')->where('player_id', $id)->orderByDesc('id')->limit($limit)->get()
            ->map(fn ($t) => ['at' => (int) $t->created_at, 'type' => $t->type, 'amount' => (int) $t->amount, 'balance' => (int) $t->balance_after, 'ref' => $t->ref])->all();
    }

    public function depositsOf(int $id, int $limit = 20): array
    {
        return DB::table('deposits')->where('player_id', $id)->orderByDesc('id')->limit($limit)->get()
            ->map(fn ($d) => ['id' => (int) $d->id, 'at' => (int) $d->created_at, 'amount' => (int) $d->amount, 'method' => $d->method, 'reference' => $d->reference, 'status' => $d->status, 'note' => $d->note])->all();
    }

    public function withdrawalsOf(int $id, int $limit = 20): array
    {
        return DB::table('withdrawals')->where('player_id', $id)->orderByDesc('id')->limit($limit)->get()
            ->map(fn ($w) => ['id' => (int) $w->id, 'at' => (int) $w->created_at, 'amount' => (int) $w->amount, 'method' => $w->method, 'account' => $w->account_number, 'status' => $w->status, 'note' => $w->note, 'payoutRef' => $w->payout_ref])->all();
    }

    /** the cashier queues (staff) */
    public function queue(string $kind, string $status): array
    {
        $table = $kind === 'withdrawals' ? 'withdrawals' : 'deposits';
        $rows = DB::table($table)->join('players', 'players.id', '=', $table.'.player_id')->where($table.'.status', $status)->orderBy($table.'.id', $status === 'pending' ? 'asc' : 'desc')->limit(200)
            ->get([$table.'.*', 'players.username', 'players.balance as player_balance']);

        return $rows->map(function ($r) use ($kind) {
            $o = ['id' => (int) $r->id, 'playerId' => (int) $r->player_id, 'username' => $r->username, 'at' => (int) $r->created_at, 'amount' => (int) $r->amount, 'method' => $r->method, 'status' => $r->status,
                'note' => $r->note, 'decidedBy' => $r->decided_by, 'decidedAt' => $r->decided_at ? (int) $r->decided_at : null];

            return $kind === 'withdrawals'
                ? $o + ['accountName' => $r->account_name, 'accountNumber' => $r->account_number, 'payoutRef' => $r->payout_ref]
                : $o + ['senderName' => $r->sender_name, 'senderNumber' => $r->sender_number, 'reference' => $r->reference];
        })->all();
    }
}
