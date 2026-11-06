<?php

namespace App\Games\BingoPinball;

use App\Console\Commands\BingoPar;

/**
 * The certification pack of Bingo Pinball (Phase 6): everything a testing lab needs in one folder - the rules sheet, the PAR sheets, the description of the draw,
 * the verification scripts, the source of the part that decides results, and a manifest with the SHA-256 of every file and of the browser build.
 * `verify()` re-checks a pack against itself and against the code that is installed now, so the operator can show that what runs is what was certified.
 * It only reads the project and writes into the folder it is given.
 */
final class CertPack
{
    public const VERSION = 1;

    /** files copied into the pack: they decide results or check them. Paths are relative to the project (laravel/) */
    private const SOURCE = ['app/Games/BingoPinball', 'app/Game/Rng.php', 'app/Game/RngStream.php', 'config/games.php'];

    /** the browser build the player runs: hashed in the manifest (and the verifier in the browser is copied) */
    private const BUILD = ['public/bingo-pinball.html', 'public/css/bingo.css', 'public/js/bingo'];

    private const VERIFY = ['bin/bingo-verify.php' => 'verification/bingo-verify.php', 'docs/bingo/verify_play.py' => 'verification/verify_play.py', 'docs/bingo/test-vectors.json' => 'verification/test-vectors.json'];

    public function __construct(private string $root) {}

    /** @return list<string> the files below a path (or the path itself), relative to the project, sorted */
    private function files(string $rel): array
    {
        $abs = $this->root.'/'.$rel;
        if (is_file($abs)) {
            return [$rel];
        }
        $out = [];
        if (is_dir($abs)) {
            $it = new \RecursiveIteratorIterator(new \RecursiveDirectoryIterator($abs, \FilesystemIterator::SKIP_DOTS));
            foreach ($it as $f) {
                if ($f->isFile()) {
                    $out[] = ltrim(substr($f->getPathname(), strlen($this->root)), '/');
                }
            }
        }
        sort($out);

        return $out;
    }

    /** @return array<string,string> relative path => sha256 */
    private function hashes(array $roots): array
    {
        $out = [];
        foreach ($roots as $r) {
            foreach ($this->files($r) as $f) {
                $out[$f] = hash_file('sha256', $this->root.'/'.$f);
            }
        }

        return $out;
    }

    private function git(string $args): ?string
    {
        $o = @shell_exec('git -C '.escapeshellarg($this->root).' '.$args.' 2>/dev/null');

        return $o === null || $o === false ? null : trim($o);
    }

    private function put(string $dir, string $rel, string $content): void
    {
        $path = $dir.'/'.$rel;
        if (! is_dir(dirname($path))) {
            mkdir(dirname($path), 0775, true);
        }
        file_put_contents($path, $content);
    }

    private function rulesSheet(): string
    {
        $md = "# Bingo Pinball - rules sheet\n\nThis is what the player is told (the rules screen of the game) and what the game does. The maths is in `04-maths-package.md`, the draw in `03-rng-description.md`.\n\n"
            ."## For the player\n\n* Choose a stake and press PLAY. Five balls are played one after another; each drops into a different one of the 25 holes. The numbers of the holes light up on a 5x5 card.\n"
            ."* The card has 12 lines: 5 rows, 5 columns and the 2 diagonals. **Only the best line pays**; lines do not add up. 3, 4 or 5 lit cells in the best line pay a multiple of the stake (the stake is included in the multiple). One or two lit cells pay nothing.\n"
            ."* **The plunger is for show.** The result of every play is decided by the server before the first ball is launched. How hard or how long the plunger is pulled never changes where the balls go.\n"
            ."* At least 3 seconds between two plays. The balance is the player's account balance; a win is added when the platform confirms it. Stakes, the daily loss limit and reality checks are those of the operator and count across all games.\n"
            ."* Every play is provably fair: the commitment (SHA-256 of the server seed) is shown before the first play, the server seed is revealed when the player starts a new seed or after 1,000 plays, and the page re-checks past plays in the browser.\n\n"
            ."## Paytables (stake multiples, stake included)\n\n| Version | Id | 3 in line | 4 in line | 5 in line | RTP |\n|---|---|---|---|---|---|\n";
        foreach (Paytables::VERSIONS as $v) {
            $p = Paytables::get($v);
            $md .= "| $v | {$p->id} | {$p->pays[3]}x | {$p->pays[4]}x | {$p->pays[5]}x | {$p->publishedRtp}% |\n";
        }
        $md .= "\nThe RTP of a client is set only by choosing one of these versions; the operator must publish the figure of the version in use.\n\n## Card layouts\n\nEach version has one fixed 5x5 layout of the numbers 1-25 (row by row). The layout is cosmetic: every probability is the same for every layout.\n\n";
        foreach (Paytables::VERSIONS as $v) {
            $p = Paytables::get($v);
            $md .= "Version $v ({$p->id}):\n\n```\n";
            foreach (array_chunk($p->card, 5) as $row) {
                $md .= implode(' ', array_map(fn ($n) => str_pad((string) $n, 2, ' ', STR_PAD_LEFT), $row))."\n";
            }
            $md .= "```\n\n";
        }

        return $md;
    }

    /** writes the pack into $dir (created if needed) and returns its manifest */
    public function build(string $dir): array
    {
        if (! is_dir($dir) && ! mkdir($dir, 0775, true)) {
            throw new \RuntimeException("cannot create $dir");
        }
        $this->put($dir, '01-rules-sheet.md', $this->rulesSheet());
        $this->put($dir, '02-par-sheets.md', BingoPar::markdown());
        foreach (['03-rng-description.md' => 'docs/bingo/RNG.md', '04-maths-package.md' => 'docs/bingo/MATH.md'] as $to => $from) {
            if (! is_file($this->root.'/'.$from)) {
                throw new \RuntimeException("missing $from");
            }
            $this->put($dir, $to, file_get_contents($this->root.'/'.$from));
        }
        foreach (self::VERIFY as $from => $to) {
            $this->put($dir, $to, file_get_contents($this->root.'/'.$from));
        }
        $source = $this->hashes(self::SOURCE);
        foreach (array_keys($source) as $f) {
            $this->put($dir, 'source/'.$f, file_get_contents($this->root.'/'.$f));
        }
        $this->put($dir, 'browser-verifier/fair.js', file_get_contents($this->root.'/public/js/bingo/fair.js'));
        $build = $this->hashes(self::BUILD);
        $paytables = [];
        foreach (Paytables::VERSIONS as $v) {
            $p = Paytables::get($v);
            $paytables[] = ['version' => $v, 'id' => $p->id, 'sha256' => hash('sha256', $p->canonical())];
        }
        $lock = $this->root.'/composer.lock';
        $manifest = ['pack' => self::VERSION, 'game' => 'bingo-pinball', 'generatedAt' => gmdate('c'), 'commit' => $this->git('rev-parse HEAD'), 'workingTreeClean' => $this->git('status --porcelain -- .') === '',
            'php' => PHP_VERSION, 'composerLockSha256' => is_file($lock) ? hash_file('sha256', $lock) : null, 'paytables' => $paytables, 'source' => $source, 'browserBuild' => $build];
        $this->put($dir, 'MANIFEST.json', json_encode($manifest, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES)."\n");
        $this->put($dir, 'README.md', "# Bingo Pinball - certification pack (format {$manifest['pack']})\n\nCommit: ".($manifest['commit'] ?? 'unknown').($manifest['workingTreeClean'] ? '' : ' (WORKING TREE NOT CLEAN: do not certify this pack)')."\n\n"
            ."* `01-rules-sheet.md` rules, paytables, card layouts\n* `02-par-sheets.md` PAR sheets (exact enumeration of all 53,130 outcomes)\n* `03-rng-description.md` the draw, the seeds, the fairness protocol\n* `04-maths-package.md` the maths and the tests behind it\n"
            ."* `verification/` standalone PHP and Python verifiers and 49 known-answer plays\n* `source/` the source that decides results (and `browser-verifier/` the player's in-browser check)\n* `MANIFEST.json` SHA-256 of every source file and of the browser build, the paytable hashes, the commit\n* `SHA256SUMS` SHA-256 of every file of this pack\n\n"
            ."Show that a server runs the certified code: `php artisan bingo:cert-pack --verify=<this folder>` (exit code 0 = the installed source and browser build are identical to this pack).\n");
        $sums = '';
        foreach ($this->packFiles($dir) as $f) {
            $sums .= hash_file('sha256', $dir.'/'.$f).'  '.$f."\n";
        }
        $this->put($dir, 'SHA256SUMS', $sums);

        return $manifest;
    }

    /** @return list<string> every file of a pack except SHA256SUMS, relative to it, sorted */
    private function packFiles(string $dir): array
    {
        $out = [];
        $it = new \RecursiveIteratorIterator(new \RecursiveDirectoryIterator($dir, \FilesystemIterator::SKIP_DOTS));
        foreach ($it as $f) {
            $rel = ltrim(substr($f->getPathname(), strlen($dir)), '/');
            if ($f->isFile() && $rel !== 'SHA256SUMS') {
                $out[] = $rel;
            }
        }
        sort($out);

        return $out;
    }

    /** @return list<string> the problems found (empty = the pack is intact and the installed code is the certified code) */
    public function verify(string $dir): array
    {
        $problems = [];
        if (! is_file($dir.'/SHA256SUMS') || ! is_file($dir.'/MANIFEST.json')) {
            return ['this is not a certification pack (SHA256SUMS or MANIFEST.json is missing)'];
        }
        $listed = [];
        foreach (explode("\n", trim(file_get_contents($dir.'/SHA256SUMS'))) as $l) {
            if (preg_match('/^([0-9a-f]{64})  (.+)$/', $l, $m)) {
                $listed[$m[2]] = $m[1];
            }
        }
        foreach ($listed as $f => $h) {
            if (! is_file($dir.'/'.$f)) {
                $problems[] = "pack: $f is missing";
            } elseif (hash_file('sha256', $dir.'/'.$f) !== $h) {
                $problems[] = "pack: $f was changed after the pack was made";
            }
        }
        foreach (array_diff($this->packFiles($dir), array_keys($listed)) as $f) {
            $problems[] = "pack: $f is not in SHA256SUMS";
        }
        $man = json_decode(file_get_contents($dir.'/MANIFEST.json'), true);
        foreach (['source' => 'source', 'browserBuild' => 'browser build'] as $key => $label) {
            foreach ($man[$key] ?? [] as $f => $h) {
                if (! is_file($this->root.'/'.$f)) {
                    $problems[] = "installed: $f ($label) is missing";
                } elseif (hash_file('sha256', $this->root.'/'.$f) !== $h) {
                    $problems[] = "installed: $f ($label) differs from the certified one";
                }
            }
            $now = $key === 'source' ? $this->hashes(self::SOURCE) : $this->hashes(self::BUILD);
            foreach (array_diff_key($now, $man[$key] ?? []) as $f => $_) {
                $problems[] = "installed: $f ($label) is not part of the certified pack";
            }
        }
        foreach ($man['paytables'] ?? [] as $p) {
            if (hash('sha256', Paytables::get($p['version'])->canonical()) !== $p['sha256']) {
                $problems[] = 'installed: paytable '.$p['id'].' differs from the certified one';
            }
        }

        return $problems;
    }
}
