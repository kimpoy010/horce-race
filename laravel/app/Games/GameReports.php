<?php

namespace App\Games;

use App\Game\Engine;
use App\Games\BingoPinball\Card;
use App\Games\BingoPinball\Par;
use App\Games\BingoPinball\Paytables;
use App\Games\BingoPinball\SeedService;
use Illuminate\Support\Facades\DB;

/**
 * What the consoles, /metrics and the alerts say about each game (Phase 5). One place computes the numbers so that they cannot disagree with each other:
 * stakes, payouts, actual and theoretical RTP, how far the payouts are from what the maths predicts (z-score), hit frequency and the queues of a game.
 * It only reads. The horse race's own reports (Engine::report, clientReport) are not changed; this adds the same figures per game.
 */
final class GameReports
{
    public const HORSE = 'horse-race';

    public const BINGO = 'bingo-pinball';

    public function __construct(private Engine $engine, private SeedService $seeds) {}

    /** @return array<string,array> the figures of every game, optionally of one client only */
    public function summary(?string $client = null): array
    {
        return [self::HORSE => $this->horse($client), self::BINGO => $this->bingo($client)];
    }

    /* ---------- horse race ---------- */

    private function horse(?string $client): array
    {
        $q = fn () => ($client === null ? DB::table('bets') : DB::table('bets')->where('client_id', $client))->whereIn('status', ['won', 'lost']);
        $staked = (int) $q()->sum('stake');
        $paid = (int) $q()->sum('payout');
        $byCurrency = [];
        foreach ($q()->selectRaw('currency, sum(stake) as s, sum(payout) as p')->groupBy('currency')->get() as $c) {
            $byCurrency[$c->currency] = ['staked' => (int) $c->s, 'paid' => (int) $c->p];
        }

        return ['game' => self::HORSE, 'plays' => (int) $q()->count(), 'rounds' => (int) $q()->distinct()->count('race_no'), 'staked' => $staked, 'paid' => $paid, 'ggr' => $staked - $paid, 'byCurrency' => (object) $byCurrency,
            'rtpActual' => $staked ? $paid / $staked : null, 'rtpTheoretical' => $this->engine->rtp(), 'rtpZ' => $client === null ? $this->engine->rtpZ() : null, 'pending' => $this->pending(self::HORSE, $client)];
    }

    /* ---------- bingo pinball ---------- */

    private function settled(?string $client)
    {
        $q = DB::table('instant_rounds')->where('game_id', self::BINGO)->where('status', 'settled');

        return $client === null ? $q : $q->where('client_id', $client);
    }

    private function bingo(?string $client): array
    {
        $staked = (int) $this->settled($client)->sum('stake');
        $paid = (int) $this->settled($client)->sum('payout');
        $plays = (int) $this->settled($client)->count();
        $byCurrency = [];
        foreach ($this->settled($client)->selectRaw('currency, sum(stake) as s, sum(payout) as p')->groupBy('currency')->get() as $c) {
            $byCurrency[$c->currency] = ['staked' => (int) $c->s, 'paid' => (int) $c->p];
        }
        // what the maths predicts for the plays made: per paytable version, the number of plays and the sum of their multiples
        $n = 0.0;
        $mean = 0.0;
        $var = 0.0;
        $hitsExpected = 0.0;
        $multiples = 0;
        foreach ($this->settled($client)->selectRaw('paytable_version as v, count(*) as n, sum(coalesce(multiple, 0)) as m')->groupBy('paytable_version')->get() as $g) {
            $par = Par::enumerate(Paytables::get((int) $g->v));
            $n += $g->n;
            $mean += $g->n * $par['rtp'];
            $var += $g->n * $par['variance'];
            $hitsExpected += $g->n * $par['hitFrequency'];
            $multiples += (int) $g->m;
        }
        $hits = [3 => 0, 4 => 0, 5 => 0];
        $byLine = [];
        foreach ($this->settled($client)->where('payout', '>', 0)->selectRaw('best_line as l, best_lit as k, count(*) as n')->groupBy('best_line', 'best_lit')->get() as $g) {
            $hits[(int) $g->k] = ($hits[(int) $g->k] ?? 0) + (int) $g->n;
            $byLine[Card::lineName((int) $g->l)][(int) $g->k] = (int) $g->n;
        }
        $hitCount = array_sum($hits);

        return ['game' => self::BINGO, 'plays' => $plays, 'rounds' => $plays, 'staked' => $staked, 'paid' => $paid, 'ggr' => $staked - $paid, 'byCurrency' => (object) $byCurrency,
            'rtpActual' => $staked ? $paid / $staked : null, 'rtpTheoretical' => $plays ? $mean / $n : null, 'rtpZ' => $var > 0 ? ($multiples - $mean) / sqrt($var) : 0.0,
            'hits' => $hits, 'hitFrequency' => $plays ? $hitCount / $plays : null, 'hitFrequencyTheoretical' => $plays ? $hitsExpected / $n : null, 'byLine' => (object) $byLine,
            'pending' => $this->pending(self::BINGO, $client)];
    }

    /** the credits, rollbacks and webhooks of a game that the wallet or the platform has not confirmed yet */
    public function pending(string $game, ?string $client = null): array
    {
        $q = function (string $kind) use ($game, $client) {
            $c = DB::table('pending_ops')->where('kind', $kind);
            if ($game === self::HORSE) {
                $c->where(fn ($w) => $w->whereNull('game_id')->orWhere('game_id', self::HORSE));
            } else {
                $c->where('game_id', $game);
            }
            if ($client !== null) {
                $c = \App\Platform\Clients\ClientDirectory::ofClient($c, $client);
            }
            $count = (int) $c->count();
            $min = $count ? (clone $c)->min('since') : null;

            return ['count' => $count, 'oldestSeconds' => $min ? max(0, ($this->engine->now() - (int) $min) / 1000) : 0];
        };

        return ['credits' => $q('credit'), 'rollbacks' => $q('rollback')];
    }

    /* ---------- bingo rounds for the back office ---------- */

    private static function roundRow(object $r): array
    {
        return ['id' => (int) $r->id, 'ref' => 'bp:'.$r->id, 'playerId' => \App\Game\Engine::splitPk($r->player_key)[1], 'status' => $r->status, 'at' => (int) ($r->settled_at ?? $r->created_at), 'stake' => (int) $r->stake,
            'payout' => (int) $r->payout, 'currency' => $r->currency, 'holes' => $r->holes === null ? null : json_decode($r->holes, true), 'bestLit' => $r->best_lit === null ? null : (int) $r->best_lit,
            'line' => $r->best_line === null ? null : Card::lineName((int) $r->best_line), 'multiple' => $r->multiple === null ? null : (int) $r->multiple, 'paytable' => $r->paytable_id, 'nonce' => $r->nonce === null ? null : (int) $r->nonce];
    }

    /** the latest plays of a client (optionally of one player), newest first */
    public function bingoRounds(string $client, mixed $limit = 50, ?string $playerId = null): array
    {
        $q = DB::table('instant_rounds')->where('game_id', self::BINGO)->where('client_id', $client)->whereIn('status', ['settled', 'void']);
        if ($playerId !== null && $playerId !== '') {
            $q->where('player_key', $this->engine->playerKey($client, $playerId));
        }

        return ['ok' => true, 'rounds' => $q->orderByDesc('id')->limit(max(1, min(300, (int) $limit ?: 50)))->get()->map(fn ($r) => self::roundRow($r))->all()];
    }

    /** one play with what is needed to re-run it: the proof is there once its seed pair has been revealed */
    public function bingoRound(string $client, int $id): ?array
    {
        $r = DB::table('instant_rounds')->where('game_id', self::BINGO)->where('client_id', $client)->where('id', $id)->first();
        if (! $r) {
            return null;
        }
        $out = ['ok' => true, 'round' => self::roundRow($r), 'proof' => null];
        $seed = $r->seed_id === null ? null : $this->seeds->revealed((int) $r->seed_id);
        if ($seed) {
            $pt = Paytables::get((int) $r->paytable_version);
            $out['proof'] = ['serverSeed' => $seed['serverSeed'], 'commit' => $seed['commit'], 'clientSeed' => $seed['clientSeed'], 'nonce' => (int) $r->nonce, 'holes' => json_decode($r->holes, true),
                'paytable' => ['id' => $pt->id, 'version' => $pt->version, 'pays' => $pt->pays, 'card' => $pt->card],
                'verify' => 'php bin/bingo-verify.php --server-seed '.$seed['serverSeed'].' --client-seed '.$seed['clientSeed'].' --nonce '.(int) $r->nonce.' --version '.$pt->version.' --stake '.(int) $r->stake.' --commit '.$seed['commit']];
        } else {
            $out['proofNote'] = 'The server seed of this play is still secret; it is shown once the player starts a new seed or the pair is used up.';
        }

        return $out;
    }

    /** the players of a client who played Bingo Pinball, latest first */
    public function bingoPlayers(string $client, ?string $query = null, mixed $limit = 100): array
    {
        $by = DB::table('instant_rounds')->where('game_id', self::BINGO)->where('client_id', $client)->where('status', 'settled')->groupBy('player_key')
            ->selectRaw('player_key, count(*) as n, sum(stake) as s, sum(payout) as p, max(settled_at) as last')->orderByDesc('last')->get();
        $q = strtolower((string) $query);
        $out = [];
        foreach ($by as $r) {
            $id = \App\Game\Engine::splitPk($r->player_key)[1];
            if ($q === '' || str_contains(strtolower($id), $q)) {
                $out[] = ['playerId' => $id, 'plays' => (int) $r->n, 'staked' => (int) $r->s, 'paid' => (int) $r->p, 'lastPlayAt' => (int) $r->last];
            }
        }

        return ['ok' => true, 'total' => count($out), 'players' => array_slice($out, 0, max(1, min(500, (int) $limit ?: 100)))];
    }
}
