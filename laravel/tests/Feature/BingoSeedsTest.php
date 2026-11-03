<?php

namespace Tests\Feature;

use App\Game\GameError;
use App\Game\Ledger;
use App\Games\BingoPinball\Draw;
use App\Games\BingoPinball\SeedService;
use App\Platform\Ledger\Journal;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Tests\TestCase;

/** The provably fair seed pairs (Phase 3b) */
class BingoSeedsTest extends TestCase
{
    use RefreshDatabase;

    private int $t = 1_800_000_000_000;

    private SeedService $seeds;

    private const KEY = 'seed-test-clients-key-0123456789';

    protected function setUp(): void
    {
        parent::setUp();
        $this->seeds = new SeedService(new Journal(new Ledger, fn () => $this->t), fn () => $this->t, self::KEY, 3);
    }

    private function events(): array
    {
        return array_map(fn ($l) => json_decode($l, true), DB::table('ledger')->orderBy('seq')->pluck('line')->all());
    }

    public function test_the_first_pair_is_made_with_a_commit_a_random_client_seed_and_an_encrypted_server_seed(): void
    {
        $s = $this->seeds->active('acme:alice');
        $this->assertMatchesRegularExpression('/^[0-9a-f]{64}$/', $s->commit);
        $this->assertMatchesRegularExpression(Draw::CLIENT_SEED_RE, $s->client_seed);
        $this->assertSame([1, 'active'], [(int) $s->next_nonce, $s->status]);
        $this->assertStringStartsWith('enc:v1:', $s->server_seed, 'the server seed is not stored in clear text');
        $server = $this->seeds->serverSeed($s);
        $this->assertSame($s->commit, Draw::commitOf($server), 'the commit is the sha256 of the server seed');
        $this->assertStringNotContainsString($server, json_encode(DB::table('player_seeds')->get()->all()), 'the secret is nowhere in the table');
        $this->assertSame($s->id, $this->seeds->active('acme:alice')->id, 'asking again gives the same pair');
        $this->assertNotSame($s->id, $this->seeds->active('acme:bob')->id, 'every player has their own');
        $e = $this->events()[0];
        $this->assertSame(['seed.commit', 'bingo-pinball', 'acme:alice', $s->commit], [$e['e'], $e['game'], $e['playerId'], $e['commit']]);
        $this->assertArrayNotHasKey('serverSeed', $e, 'the secret is not in the ledger either');
    }

    public function test_nonces_run_1_2_3_and_the_pair_asks_for_rotation_after_its_plays(): void
    {
        $s = $this->seeds->active('p');
        $this->assertSame([1, 2, 3], [$this->seeds->take($s), $this->seeds->take($this->seeds->active('p')), $this->seeds->take($this->seeds->active('p'))]);
        $s = $this->seeds->active('p');
        $this->assertSame([3, 4, true], [$this->seeds->view($s)['plays'], $this->seeds->view($s)['nextNonce'], $this->seeds->needsRotation($s)], 'three plays were made under a pair that lasts three');
        $this->assertFalse($this->seeds->needsRotation($this->seeds->active('fresh')));
    }

    public function test_rotation_reveals_the_old_server_seed_and_starts_a_new_pair(): void
    {
        $old = $this->seeds->active('p');
        $this->seeds->take($old);
        $r = $this->seeds->rotate('p', 'my-own-seed_1');
        $this->assertEquals(['plays' => 1, 'commit' => $old->commit, 'clientSeed' => $old->client_seed], array_intersect_key($r['revealed'], array_flip(['plays', 'commit', 'clientSeed'])));
        $this->assertSame($old->commit, Draw::commitOf($r['revealed']['serverSeed']), 'the revealed seed is the one that was committed');
        $this->assertSame(['my-own-seed_1', 1], [$r['active']['clientSeed'], $r['active']['nextNonce']]);
        $this->assertNotSame($old->commit, $r['active']['commit']);
        $this->assertSame('revealed', DB::table('player_seeds')->where('id', $old->id)->value('status'));
        $this->assertSame(1, DB::table('player_seeds')->where('player_key', 'p')->where('status', 'active')->count(), 'one active pair');
        $this->assertSame($r['active']['seedId'], (int) $this->seeds->active('p')->id);
        $this->assertSame($r['revealed']['serverSeed'], $this->seeds->revealed((int) $old->id)['serverSeed']);
        $this->assertNull($this->seeds->revealed($r['active']['seedId']), 'a pair that is still in use is never shown');
        $this->assertNull($this->seeds->revealed(9999));
        $events = array_column($this->events(), 'e');
        $this->assertSame(['seed.commit', 'seed.reveal', 'seed.commit'], $events);
        $reveal = $this->events()[1];
        $this->assertSame([$r['revealed']['serverSeed'], 1], [$reveal['serverSeed'], $reveal['plays']], 'the reveal is in the ledger');
        $this->assertTrue((new Ledger)->verify()['ok']);
    }

    public function test_rotation_without_a_client_seed_gives_a_random_one_and_a_bad_one_is_refused(): void
    {
        $this->seeds->active('p');
        $a = $this->seeds->rotate('p')['active']['clientSeed'];
        $b = $this->seeds->rotate('p')['active']['clientSeed'];
        $this->assertNotSame($a, $b);
        $before = DB::table('player_seeds')->count();
        foreach (['', 'a b', 'a:b', str_repeat('x', 65), 'ü'] as $bad) {
            try {
                $this->seeds->rotate('p', $bad);
                $this->fail("refused: $bad");
            } catch (GameError $e) {
                $this->assertSame([400, 'BAD_CLIENT_SEED'], [$e->status, $e->errorCode]);
            }
        }
        $this->assertSame($before, DB::table('player_seeds')->count(), 'a refused rotation changes nothing');
        $this->assertSame('revealed', DB::table('player_seeds')->orderBy('id')->value('status'));
    }

    public function test_the_game_does_not_run_without_the_key_that_keeps_the_seeds_secret(): void
    {
        $seeds = new SeedService(new Journal(new Ledger, fn () => $this->t), fn () => $this->t, '', 1000);
        try {
            $seeds->active('p');
            $this->fail('refused');
        } catch (GameError $e) {
            $this->assertSame([503, 'GAME_NOT_CONFIGURED'], [$e->status, $e->errorCode]);
        }
        $this->assertSame(0, DB::table('player_seeds')->count(), 'no seed was stored in clear text');
    }
}
