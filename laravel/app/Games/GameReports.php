<?php

namespace App\Games;

use App\Game\Engine;
use App\Games\BingoPinball\Card;
use App\Games\BingoPinball\Par;
use App\Games\BingoPinball\Paytables;
use App\Games\BingoPinball\SeedService;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * What the consoles, /metrics and the alerts say about each game (Phase 5). One place computes the numbers so that they cannot disagree with each other:
 * stakes, payouts, actual and theoretical RTP, how far the payouts are from what the maths predicts (z-score), hit frequency and the queues of a game.
 * It only reads. The horse race's own reports (Engine::report, clientReport) are not changed; this adds the same figures per game.
 */
final class GameReports
{
    public const HORSE = 'horse-race';

    public const BINGO = 'bingo-pinball';

    public const BINGO16 = 'bingo-pinball-16';

    public function __construct(private Engine $engine, private SeedService $seeds) {}

    private bool $ready = false;

    /**
     * Whether the tables of the instant games exist yet. Code is often deployed before `php artisan migrate` is run; until then the horse race, the consoles and /metrics must
     * keep working, so every figure of a game that has no tables reads as zero instead of failing. (Only "yes" is remembered, so a later migration is noticed.)
     */
    private function ready(): bool
    {
        return $this->ready = $this->ready || (Schema::hasTable('instant_rounds') && Schema::hasColumn('pending_ops', 'game_id'));
    }

    /** @return array<string,array> the figures of every game, optionally of one client only */
    public function summary(?string $client = null): array
    {
        return [self::HORSE => $this->horse($client), self::BINGO => $this->bingo($client), self::BINGO16 => $this->bingo16($client)];
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
        if (! $this->ready()) {
            return ['game' => self::BINGO, 'plays' => 0, 'rounds' => 0, 'staked' => 0, 'paid' => 0, 'ggr' => 0, 'byCurrency' => (object) [], 'rtpActual' => null, 'rtpTheoretical' => null, 'rtpZ' => 0.0,
                'hits' => [3 => 0, 4 => 0, 5 => 0], 'hitFrequency' => null, 'hitFrequencyTheoretical' => null, 'byLine' => (object) [], 'pending' => $this->pending(self::BINGO, $client)];
        }
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
        $ready = $this->ready();
        $q = function (string $kind) use ($game, $client, $ready) {
            if (! $ready && $game !== self::HORSE) {
                return ['count' => 0, 'oldestSeconds' => 0];
            }
            $c = DB::table('pending_ops')->where('kind', $kind);
            if (! $ready) {                                          // before the migration every queued item is the horse race's
                $game = self::HORSE;
            } elseif ($game === self::HORSE) {
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

    /* ---------- bingo pinball 16 ---------- */

    private static ?array $par16 = null;

    private bool $ready16 = false;

    /** the tables and columns of Bingo Pinball 16 (its migrations may not have been run yet: then its figures read as zero, like Bingo Pinball's) */
    private function ready16(): bool
    {
        return $this->ready16 = $this->ready16 || ($this->ready() && Schema::hasTable('jackpot_pools') && Schema::hasColumn('instant_rounds', 'pattern') && Schema::hasColumn('instant_rounds', 'jackpot_paid'));
    }

    private function par16(): array
    {
        return self::$par16 ??= \App\Games\BingoPinball16\Par::enumerate();
    }

    private function settled16(?string $client)
    {
        $q = DB::table('instant_rounds')->where('game_id', self::BINGO16)->where('status', 'settled');

        return $client === null ? $q : $q->where('client_id', $client);
    }

    /** the jackpot pools of the server (one per currency) and whether their books balance: amount = seed money + contributions - jackpots paid */
    public function pools(): array
    {
        if (! $this->ready16()) {
            return [];
        }
        $out = [];
        foreach (DB::table('jackpot_pools')->where('game_id', self::BINGO16)->orderBy('currency')->get() as $p) {
            $out[$p->currency] = ['amount' => (int) $p->amount, 'seed' => (int) $p->seed, 'contributed' => (int) $p->contributed, 'paid' => (int) $p->paid, 'seeded' => (int) $p->seeded, 'wins' => (int) $p->wins,
                'lastWinAt' => $p->last_win_at === null ? null : (int) $p->last_win_at, 'balanced' => (int) $p->amount === (int) $p->seeded + (int) $p->contributed - (int) $p->paid, 'belowSeed' => (int) $p->amount < (int) $p->seed];
        }

        return $out;
    }

    private function bingo16(?string $client): array
    {
        $cfg = (array) config('games.settings.bingo-pinball-16');
        $par = $this->par16();
        $patternRtp = $par['rtp'];
        $contribution = ((int) ($cfg['contribution_bp'] ?? 0)) / 10000;
        $empty = ['game' => self::BINGO16, 'plays' => 0, 'rounds' => 0, 'staked' => 0, 'paid' => 0, 'ggr' => 0, 'patternPaid' => 0, 'jackpotPaid' => 0, 'byCurrency' => (object) [], 'rtpActual' => null,
            'patternRtpActual' => null, 'rtpTheoretical' => $patternRtp + $contribution, 'patternRtpTheoretical' => $patternRtp, 'rtpZ' => 0.0, 'hitFrequency' => null, 'hitFrequencyTheoretical' => $par['hit'],
            'patterns' => (object) [], 'jackpotHits' => 0, 'jackpotExpected' => 0.0, 'jackpotZ' => 0.0, 'jackpotProbability' => $par['jackpot'], 'pools' => (object) [], 'pending' => $this->pending(self::BINGO16, $client)];
        if (! $this->ready16()) {
            return $empty;
        }
        $plays = (int) $this->settled16($client)->count();
        $staked = (int) $this->settled16($client)->sum('stake');
        $paid = (int) $this->settled16($client)->sum('payout');
        $jackpotPaid = (int) $this->settled16($client)->sum('jackpot_paid');
        $byCurrency = [];
        foreach ($this->settled16($client)->selectRaw('currency, sum(stake) as s, sum(payout) as p')->groupBy('currency')->get() as $c) {
            $byCurrency[$c->currency] = ['staked' => (int) $c->s, 'paid' => (int) $c->p];
        }
        $multiples = (int) $this->settled16($client)->sum('multiple') / 2;                  // the column holds half stakes
        $patterns = [];
        foreach (\App\Games\BingoPinball16\Rules::PATTERNS as $k => [$name, $halves]) {
            $patterns[$k] = ['name' => $name, 'multiple' => $halves / 2, 'count' => 0, 'expected' => $plays * $par['patterns'][$k], 'probability' => $par['patterns'][$k]];
        }
        foreach ($this->settled16($client)->whereNotNull('pattern')->selectRaw('pattern, count(*) as n')->groupBy('pattern')->get() as $g) {
            if (isset($patterns[$g->pattern])) {
                $patterns[$g->pattern]['count'] = (int) $g->n;
            }
        }
        $hits = array_sum(array_column($patterns, 'count'));
        $eligible = (int) $this->settled16($client)->whereIn('currency', (array) ($cfg['currencies'] ?? ['PHP']))->count();
        $lambda = $eligible * $par['jackpot'];
        $jackpotHits = (int) $this->settled16($client)->where('jackpot_paid', '>', 0)->count();

        return ['game' => self::BINGO16, 'plays' => $plays, 'rounds' => $plays, 'staked' => $staked, 'paid' => $paid, 'ggr' => $staked - $paid, 'patternPaid' => $paid - $jackpotPaid, 'jackpotPaid' => $jackpotPaid,
            'byCurrency' => (object) $byCurrency, 'rtpActual' => $staked ? $paid / $staked : null, 'patternRtpActual' => $staked ? ($paid - $jackpotPaid) / $staked : null,
            'rtpTheoretical' => $patternRtp + $contribution, 'patternRtpTheoretical' => $patternRtp,
            'rtpZ' => $plays ? ($multiples - $plays * $patternRtp) / ($par['standardDeviation'] * sqrt($plays)) : 0.0,                       // the pattern pays against the PAR sheet (the jackpot is judged on its own)
            'hitFrequency' => $plays ? $hits / $plays : null, 'hitFrequencyTheoretical' => $par['hit'], 'patterns' => (object) $patterns,
            'jackpotHits' => $jackpotHits, 'jackpotExpected' => $lambda, 'jackpotZ' => $lambda > 0 ? ($jackpotHits - $lambda) / sqrt($lambda) : 0.0, 'jackpotProbability' => $par['jackpot'],
            'pools' => (object) $this->pools(), 'pending' => $this->pending(self::BINGO16, $client)];
    }

    private static function roundRow16(object $r): array
    {
        $d = $r->details === null ? [] : json_decode($r->details, true);

        return ['id' => (int) $r->id, 'ref' => 'b16:'.$r->id, 'playerId' => \App\Game\Engine::splitPk($r->player_key)[1], 'status' => $r->status, 'at' => (int) ($r->settled_at ?? $r->created_at), 'stake' => (int) $r->stake,
            'payout' => (int) $r->payout, 'jackpotPaid' => (int) $r->jackpot_paid, 'currency' => $r->currency, 'pattern' => $r->pattern, 'patternName' => $r->pattern ? \App\Games\BingoPinball16\Rules::PATTERNS[$r->pattern][0] : null,
            'multiple' => $r->multiple === null ? null : (int) $r->multiple / 2, 'balls' => $d['balls'] ?? null, 'jackpotNumbers' => $d['jackpotNumbers'] ?? null, 'lit' => $d['lit'] ?? null, 'jackpotLit' => $d['jackpotLit'] ?? null,
            'paytable' => $r->paytable_id, 'nonce' => $r->nonce === null ? null : (int) $r->nonce];
    }

    /** the latest plays of a client (optionally of one player), newest first */
    public function bingo16Rounds(string $client, mixed $limit = 50, ?string $playerId = null): array
    {
        $q = DB::table('instant_rounds')->where('game_id', self::BINGO16)->where('client_id', $client)->whereIn('status', ['settled', 'void']);
        if ($playerId !== null && $playerId !== '') {
            $q->where('player_key', $this->engine->playerKey($client, $playerId));
        }

        return ['ok' => true, 'rounds' => $q->orderByDesc('id')->limit(max(1, min(300, (int) $limit ?: 50)))->get()->map(fn ($r) => self::roundRow16($r))->all()];
    }

    /** one play with what is needed to re-run it (once its seed pair has been revealed) */
    public function bingo16Round(string $client, int $id): ?array
    {
        $r = DB::table('instant_rounds')->where('game_id', self::BINGO16)->where('client_id', $client)->where('id', $id)->first();
        if (! $r) {
            return null;
        }
        $out = ['ok' => true, 'round' => self::roundRow16($r), 'proof' => null];
        $seed = $r->seed_id === null ? null : app('bingo16.seeds')->revealed((int) $r->seed_id);
        if ($seed) {
            $out['proof'] = ['serverSeed' => $seed['serverSeed'], 'commit' => $seed['commit'], 'clientSeed' => $seed['clientSeed'], 'nonce' => (int) $r->nonce,
                'verify' => 'php bin/bingo16-verify.php --server-seed '.$seed['serverSeed'].' --client-seed '.$seed['clientSeed'].' --nonce '.(int) $r->nonce.' --stake '.(int) $r->stake.' --commit '.$seed['commit']];
        } else {
            $out['proofNote'] = 'The server seed of this play is still secret; it is shown once the player starts a new seed or the pair is used up.';
        }

        return $out;
    }

    /** the players of a client who played Bingo Pinball 16, latest first */
    public function bingo16Players(string $client, ?string $query = null, mixed $limit = 100): array
    {
        $by = DB::table('instant_rounds')->where('game_id', self::BINGO16)->where('client_id', $client)->where('status', 'settled')->groupBy('player_key')
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
