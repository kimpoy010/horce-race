<?php

namespace Tests\Feature;

use App\Game\Clients\ClientRegistry;
use App\Game\Engine;
use App\Game\Ledger;
use App\Game\Odds;
use App\Game\Wallet\MockWallet;
use App\Game\Webhook;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\Client\ConnectionException;
use Illuminate\Http\Client\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Http;
use Tests\Support\DeterministicRandom;
use Tests\Support\RecordingWallet;
use Tests\TestCase;

/**
 * THE HORSE-RACE GOLDEN BASELINE.
 *
 * The horse race runs live with real money; operators reconcile against its URLs, answers, wallet transaction ids, ledger lines, webhook bodies and
 * metric names. This test replays two fixed scenarios (every identifier made reproducible, see tests/Support/DeterministicRandom.php) and compares
 * everything byte for byte with tests/golden/horse-baseline.json, which was recorded from the code as it ran in production before any other game was
 * added. If this test fails, the horse race now behaves differently: that is a bug unless the change was meant to be visible to operators.
 *
 * Never regenerate the file just to make the test pass. A deliberate, agreed change is recorded with UPDATE_GOLDEN=1 php artisan test --filter=HorseBaselineTest
 * and the diff of the JSON goes into the review.
 */
class HorseBaselineTest extends TestCase
{
    use RefreshDatabase;

    private const DEFAULT_CLIENT = __DIR__.'/../golden/horse-default-client.json';

    private const PLATFORM_CLIENT = __DIR__.'/../golden/horse-platform-client.json';

    private const PAYOUTS = __DIR__.'/../golden/horse-odds-and-payouts.json';

    private const T0 = 1_800_000_000_000;

    private int $t = self::T0;

    /** @var list<array<string,mixed>> */
    private array $api = [];

    protected function setUp(): void
    {
        parent::setUp();
        DeterministicRandom::start('horse-baseline');
        // every setting the scenarios depend on is stated here, so a developer's .env cannot change the recording
        config(['horse.wallet' => 'mock', 'horse.controller_key' => 'golden-controller-key', 'horse.clients_key' => 'golden-clients-key-0123456789', 'horse.rtp' => 0.9, 'horse.min_bet' => 100,
            'horse.max_bet' => 100000, 'horse.max_round_stake' => 500000, 'horse.daily_loss_limit' => 0, 'horse.big_win_min' => 1, 'horse.reality_check_minutes' => 0, 'horse.bet_ms' => 25000,
            'horse.currency' => 'PHP', 'horse.mock_start_balance' => 1000000, 'horse.odds' => null, 'horse.shuffle_odds' => true, 'horse.currency_limits' => []]);
    }

    protected function tearDown(): void
    {
        DeterministicRandom::stop();
        parent::tearDown();
    }

    /* ---------- recording helpers ---------- */

    /** one API call, written down with its answer */
    private function hit(string $label, string $method, string $path, ?array $body = null, array $headers = []): array
    {
        $r = $this->json($method, $path, $body ?? [], $headers);
        $json = $r->headers->get('content-type') && str_contains((string) $r->headers->get('content-type'), 'json') ? $r->json() : null;
        $this->api[] = ['label' => $label, 'request' => ['method' => $method, 'path' => $path] + ($body === null ? [] : ['body' => $body]), 'status' => $r->status(), 'answer' => $this->masked($json) ?? $r->getContent()];

        return $json ?? [];
    }

    /** values that depend on the machine, not on the game (measured latency, free disk space) are replaced, so the recording is the same everywhere */
    private function masked(mixed $v): mixed
    {
        if (! is_array($v)) {
            return $v;
        }
        foreach ($v as $k => $x) {
            $v[$k] = in_array($k, ['p95', 'diskFreeMb'], true) ? '<measured on this machine>' : $this->masked($x);
        }

        return $v;
    }

    private function bearer(string $session): array
    {
        return ['Authorization' => 'Bearer '.$session];
    }

    private function advance(int $ms, Engine $engine): void
    {
        $this->t += $ms;
        $engine->tick();
    }

    private function ledgerLines(): array
    {
        return DB::table('ledger')->orderBy('seq')->pluck('line')->all();
    }

    private function metricNames(): array
    {
        $text = $this->get('/metrics', ['X-Controller-Key' => 'golden-controller-key'])->assertOk()->getContent();
        preg_match_all('/^# TYPE (\S+) (\S+)$/m', $text, $m, PREG_SET_ORDER);

        return array_map(fn ($x) => $x[1].' '.$x[2], $m);
    }

    /** the requests the game sent to a platform: exact body, path, the headers that do not depend on the clock */
    private function sent(array $hosts): array
    {
        $out = [];
        foreach (Http::recorded() as [$req, $res]) {
            /** @var Request $req */
            $url = parse_url($req->url());
            if (! in_array($url['host'], $hosts, true)) {
                continue;
            }
            $out[] = ['host' => $url['host'], 'path' => $url['path'], 'contentType' => $req->header('Content-Type')[0] ?? null, 'keyId' => $req->header('X-Key-Id')[0] ?? null,
                'signed' => isset($req->header('X-Signature')[0]) && strlen($req->header('X-Signature')[0]) === 64, 'body' => $req->body(), 'status' => $res ? $res->status() : null];
        }

        return $out;
    }

    /* ---------- scenario A: the default client, play-money wallet, webhook, controller commands ---------- */

    private function scenarioDefaultClient(): array
    {
        $this->api = [];
        Http::fake(['https://hook.default.test/*' => Http::response('ok', 200)]);
        $wallet = new RecordingWallet(new MockWallet(1000000, 'PHP'));
        $hook = new Webhook('https://hook.default.test/events', 'default-webhook-secret-0123456789', 'dk1', 'round.settled,big.win');
        $engine = new Engine($wallet, new Ledger, config('horse'), fn () => $this->t, null, $hook);
        $this->app->instance(Engine::class, $engine);

        $engine->tick();                                                                                     // race 1 opens
        $this->hit('public: betting', 'GET', '/api/public');
        $alice = $this->hit('auth alice', 'POST', '/api/auth', ['token' => 'demo-alice'])['session'];
        $bob = $this->hit('auth bob', 'POST', '/api/auth', ['token' => 'demo-bob'])['session'];
        $this->hit('me alice', 'GET', '/api/me', null, $this->bearer($alice));
        $this->hit('bet alice', 'POST', '/api/bet', ['bets' => [['combo' => '1-2', 'stake' => 1000], ['combo' => '3-4', 'stake' => 500], ['combo' => '5-6', 'stake' => 200]]], $this->bearer($alice));
        $this->hit('bet bob', 'POST', '/api/bet', ['bets' => array_map(fn ($c) => ['combo' => $c, 'stake' => 300], array_slice(Odds::combos(), 0, 8))], $this->bearer($bob));
        $this->hit('bet refused: below the minimum', 'POST', '/api/bet', ['bets' => [['combo' => '1-2', 'stake' => 50]]], $this->bearer($alice));
        $this->hit('bet refused: above the maximum', 'POST', '/api/bet', ['bets' => [['combo' => '1-2', 'stake' => 100001]]], $this->bearer($alice));
        $this->hit('bet refused: unknown combination', 'POST', '/api/bet', ['bets' => [['combo' => '1-9', 'stake' => 1000]]], $this->bearer($alice));
        $this->hit('bet refused: no session', 'POST', '/api/bet', ['bets' => [['combo' => '1-2', 'stake' => 1000]]]);
        $this->hit('auth refused: bad token', 'POST', '/api/auth', ['token' => 'nope']);

        $this->advance(25000, $engine);                                                                      // betting closes, the race is drawn
        $this->hit('public: closed', 'GET', '/api/public');
        $this->hit('bet refused: betting closed', 'POST', '/api/bet', ['bets' => [['combo' => '1-2', 'stake' => 1000]]], $this->bearer($alice));
        $this->advance(10000, $engine);
        $this->hit('public: racing', 'GET', '/api/public');
        $this->advance(26000, $engine);                                                                      // the race is over: settled, credits and webhooks
        $this->hit('public: results', 'GET', '/api/public');
        $this->hit('round 1 proof', 'GET', '/api/round/1');
        $this->hit('history alice', 'GET', '/api/history', null, $this->bearer($alice));
        $this->hit('me alice after race 1', 'GET', '/api/me', null, $this->bearer($alice));
        $this->hit('me bob after race 1', 'GET', '/api/me', null, $this->bearer($bob));

        $this->advance(10000, $engine);                                                                      // race 2 opens
        $this->hit('command: setRtp', 'POST', '/api/command', ['cmd' => 'setRtp', 'rtp' => 0.92], ['X-Controller-Key' => 'golden-controller-key']);
        $this->hit('command refused: wrong key', 'POST', '/api/command', ['cmd' => 'setRtp', 'rtp' => 0.5], ['X-Controller-Key' => 'wrong']);
        $this->hit('command: block bob', 'POST', '/api/command', ['cmd' => 'blockPlayer', 'playerId' => 'bob'], ['X-Controller-Key' => 'golden-controller-key']);
        $this->hit('bet refused: blocked player', 'POST', '/api/bet', ['bets' => [['combo' => '1-2', 'stake' => 1000]]], $this->bearer($bob));
        $this->hit('command: unblock bob', 'POST', '/api/command', ['cmd' => 'unblockPlayer', 'playerId' => 'bob'], ['X-Controller-Key' => 'golden-controller-key']);
        $this->hit('public: race 2 betting', 'GET', '/api/public');
        $bob2 = $this->hit('auth bob again', 'POST', '/api/auth', ['token' => 'demo-bob'])['session'];
        $this->hit('bet bob race 2', 'POST', '/api/bet', ['bets' => [['combo' => '2-3', 'stake' => 700]]], $this->bearer($bob2));
        $this->advance(25000, $engine);
        $this->advance(36000, $engine);
        $this->hit('round 2 proof', 'GET', '/api/round/2');
        $this->hit('history bob', 'GET', '/api/history', null, $this->bearer($bob2));
        $this->hit('report', 'GET', '/api/report', null, ['X-Controller-Key' => 'golden-controller-key']);

        return ['api' => $this->api, 'wallet' => $wallet->calls, 'webhooks' => $this->sent(['hook.default.test']), 'ledger' => $this->ledgerLines(), 'metrics' => $this->metricNames(),
            'pending' => ['credits' => DB::table('pending_ops')->where('kind', 'credit')->count(), 'rollbacks' => DB::table('pending_ops')->where('kind', 'rollback')->count()]];
    }

    /* ---------- scenario B: a platform client with an HTTP wallet, a webhook, a lost debit answer, the client API ---------- */

    private function scenarioPlatformClient(): array
    {
        $this->api = [];
        $balance = 100000;
        $lose = 0;                                                                                            // number of debit answers to lose
        Http::fake(function (Request $req) use (&$balance, &$lose) {
            $path = parse_url($req->url(), PHP_URL_PATH);
            $b = json_decode($req->body(), true) ?: [];
            if (str_starts_with((string) parse_url($req->url(), PHP_URL_HOST), 'hook.')) {
                return Http::response('ok', 200);
            }
            switch ($path) {
                case '/api/session/validate':
                    return Http::response(['ok' => true, 'playerId' => 'p-77', 'currency' => 'PHP', 'balance' => $balance, 'brandId' => 'brand-a'], 200);
                case '/api/wallet/debit':
                    if ($lose > 0) {
                        $lose--;
                        throw new ConnectionException('timeout');
                    }
                    $balance -= $b['amount'];

                    return Http::response(['ok' => true, 'balance' => $balance], 200);
                case '/api/wallet/credit':
                    $balance += $b['amount'];

                    return Http::response(['ok' => true, 'balance' => $balance], 200);
                case '/api/wallet/rollback':
                    return Http::response(['ok' => true, 'status' => 'not_found', 'balance' => $balance], 200);
            }

            return Http::response(['ok' => false, 'error' => 'NOT_FOUND'], 404);
        });
        $reg = new ClientRegistry('golden-clients-key-0123456789', allowMock: false, allowHttp: false, clock: fn () => $this->t, cacheMs: 0);
        $this->app->instance(ClientRegistry::class, $reg);
        $engine = new Engine(null, new Ledger, config('horse'), fn () => $this->t, $reg, null);
        $this->app->instance(Engine::class, $engine);
        $made = $reg->create(['id' => 'acme', 'name' => 'Acme', 'currency' => 'PHP', 'wallet' => ['url' => 'https://wallet.acme.test/api', 'secret' => 'acme-wallet-secret-0123456789', 'keyId' => 'w1'],
            'webhook' => ['url' => 'https://hook.acme.test/events', 'secret' => 'acme-webhook-secret-0123456789', 'keyId' => 'h1', 'events' => 'round.settled,big.win'], 'bigWinMin' => 1]);
        $key = ['Authorization' => 'Bearer '.$made['apiKey']];

        $engine->tick();
        $s = $this->hit('auth', 'POST', '/api/auth', ['client' => 'acme', 'token' => 'launch-token-1'])['session'];
        // every combination: exactly one of them wins, so the race always ends with a credit and a big win to deliver
        $this->hit('bet 1', 'POST', '/api/bet', ['bets' => array_map(fn ($c) => ['combo' => $c, 'stake' => 200], Odds::combos())], $this->bearer($s));
        $lose = 2;                                                                                            // the platform applies the next debit but the answer is lost, twice
        $this->hit('bet 2: debit answer lost', 'POST', '/api/bet', ['bets' => [['combo' => '3-6', 'stake' => 500]]], $this->bearer($s));
        $this->hit('client info', 'GET', '/api/client/info', null, $key);
        $this->advance(25000, $engine);                                                                      // draw; the queued rollback is delivered
        $this->advance(36000, $engine);                                                                      // settle: credits and webhooks
        $this->hit('me', 'GET', '/api/me', null, $this->bearer($s));
        $this->hit('history', 'GET', '/api/history', null, $this->bearer($s));
        $this->hit('client report', 'GET', '/api/client/report', null, $key);
        $this->hit('client history', 'GET', '/api/client/history?playerId=p-77&limit=10', null, $key);
        $this->hit('client: block player', 'POST', '/api/client/players/block', ['playerId' => 'p-77'], $key);
        $this->hit('bet refused: blocked by the client', 'POST', '/api/bet', ['bets' => [['combo' => '1-2', 'stake' => 1000]]], $this->bearer($s));
        $this->hit('client: unblock player', 'POST', '/api/client/players/unblock', ['playerId' => 'p-77'], $key);
        $this->hit('round 1 proof', 'GET', '/api/round/1');

        return ['api' => $this->api, 'platformRequests' => $this->sent(['wallet.acme.test', 'hook.acme.test']), 'ledger' => $this->ledgerLines(), 'metrics' => $this->metricNames(),
            'pending' => ['credits' => DB::table('pending_ops')->where('kind', 'credit')->count(), 'rollbacks' => DB::table('pending_ops')->where('kind', 'rollback')->count()]];
    }

    /* ---------- the comparison ---------- */

    private function compare(string $file, array $recorded): void
    {
        $actual = json_encode(['about' => 'Recorded from the horse race as it ran in production. Do not edit by hand. See tests/Feature/HorseBaselineTest.php.'] + $recorded,
            JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_PRESERVE_ZERO_FRACTION)."\n";
        if (getenv('UPDATE_GOLDEN') === '1') {
            file_put_contents($file, $actual);
        }
        $this->assertFileExists($file, 'the baseline is missing: record it once with UPDATE_GOLDEN=1');
        $this->assertSame(file_get_contents($file), $actual, 'The horse race no longer matches '.basename($file).'. Compare the two (the first differing line is the first change an operator would see).');
    }

    public function test_the_default_client_still_behaves_exactly_as_recorded(): void
    {
        $this->compare(self::DEFAULT_CLIENT, $this->scenarioDefaultClient());
    }

    public function test_a_platform_client_with_an_http_wallet_still_behaves_exactly_as_recorded(): void
    {
        $this->compare(self::PLATFORM_CLIENT, $this->scenarioPlatformClient());
    }

    /** the odds the game can issue at several RTP settings, and what every one of them pays for several stakes (pins the rounding of every payout) */
    public function test_odds_tables_and_payouts_are_unchanged_for_every_rtp_and_stake(): void
    {
        $base = Odds::build(null);
        $out = ['stakes' => [100, 101, 333, 1000, 1234, 9999, 12345, 100000], 'rtps' => []];
        foreach ([0.88, 0.89, 0.90, 0.91, 0.92, 0.93, 0.94, 0.95, 0.96, 0.97, 0.98, 0.99] as $rtp) {
            $t = Odds::buildForRtp($base['odds'], $rtp);
            $row = ['uniformRtp' => $t['uniform'], 'combos' => []];
            foreach (Odds::combos() as $c) {
                $odds = $t['odds'][$c];
                $row['combos'][$c] = ['odds' => $odds, 'probability' => $t['prob'][$c], 'pays' => array_map(fn ($stake) => Engine::payoutFor($stake, $odds), $out['stakes'])];
            }
            $out['rtps'][sprintf('%.2f', $rtp)] = $row;
        }
        $this->compare(self::PAYOUTS, $out);
    }

    public function test_the_baseline_covers_what_operators_reconcile_against(): void
    {
        $a = json_decode((string) file_get_contents(self::DEFAULT_CLIENT), true);
        $b = json_decode((string) file_get_contents(self::PLATFORM_CLIENT), true);
        $ops = array_column($a['wallet'], 'op');
        $this->assertContains('debit', $ops);
        $this->assertContains('credit', $ops);
        $debit = array_values(array_filter($a['wallet'], fn ($w) => $w['op'] === 'debit'))[0];
        $this->assertMatchesRegularExpression('/^bet:1:[0-9a-f]{16}$/', $debit['txId'], 'the transaction id of a bet is bet:<race>:<batch>');
        $events = array_map(fn ($l) => json_decode($l, true)['e'], $a['ledger']);
        foreach (['open', 'bet', 'draw', 'settled'] as $e) {
            $this->assertContains($e, $events, "the ledger has $e events");
        }
        $this->assertGreaterThan(20, count($a['ledger']));
        $types = array_map(fn ($w) => json_decode($w['body'], true)['type'], $a['webhooks']);
        $this->assertContains('round.settled', $types);
        $this->assertContains('big.win', $types);
        $this->assertGreaterThan(15, count($a['api']));
        $this->assertContains('horse_up gauge', $a['metrics']);
        $paths = array_column($b['platformRequests'], 'path');
        $this->assertSame(['big.win', 'round.settled'], collect($b['platformRequests'])->where('path', '/events')->map(fn ($r) => json_decode($r['body'], true)['type'])->sort()->values()->all());
        $this->assertSame(200, collect($b['api'])->firstWhere('label', 'client history')['status']);
        foreach (['/api/session/validate', '/api/wallet/debit', '/api/wallet/credit', '/api/wallet/rollback', '/events'] as $p) {
            $this->assertContains($p, $paths, "the platform is called on $p");
        }
        $this->assertNotEmpty(array_filter($b['api'], fn ($x) => str_starts_with($x['label'], 'client ')), 'the client API is covered');
    }
}
