<?php

namespace Tests\Feature;

use App\Games\BingoPinball\CertPack;
use Tests\TestCase;

/** Phase 6: the certification pack contains what the lab needs, proves itself, and notices when the installed code is not the certified code */
class BingoCertPackTest extends TestCase
{
    private string $dir;

    protected function setUp(): void
    {
        parent::setUp();
        $this->dir = sys_get_temp_dir().'/bingo-pack-'.bin2hex(random_bytes(4));
    }

    protected function tearDown(): void
    {
        if (is_dir($this->dir)) {
            exec('rm -rf '.escapeshellarg($this->dir));
        }
        parent::tearDown();
    }

    private function reseal(): void
    {
        $sums = '';
        $it = new \RecursiveIteratorIterator(new \RecursiveDirectoryIterator($this->dir, \FilesystemIterator::SKIP_DOTS));
        $files = [];
        foreach ($it as $f) {
            $rel = ltrim(substr($f->getPathname(), strlen($this->dir)), '/');
            if ($f->isFile() && $rel !== 'SHA256SUMS') {
                $files[] = $rel;
            }
        }
        sort($files);
        foreach ($files as $f) {
            $sums .= hash_file('sha256', $this->dir.'/'.$f).'  '.$f."\n";
        }
        file_put_contents($this->dir.'/SHA256SUMS', $sums);
    }

    public function test_the_pack_has_everything_and_verifies_against_the_installed_code(): void
    {
        $pack = new CertPack(base_path());
        $m = $pack->build($this->dir);
        foreach (['README.md', '01-rules-sheet.md', '02-par-sheets.md', '03-rng-description.md', '04-maths-package.md', 'MANIFEST.json', 'SHA256SUMS', 'verification/bingo-verify.php', 'verification/verify_play.py',
            'verification/test-vectors.json', 'browser-verifier/fair.js', 'source/app/Games/BingoPinball/Draw.php', 'source/app/Game/RngStream.php', 'source/app/Games/BingoPinball/paytables/v96.php'] as $f) {
            $this->assertFileExists($this->dir.'/'.$f, $f);
        }
        $this->assertCount(5, $m['paytables']);
        $this->assertArrayHasKey('public/js/bingo/paths-data.js', $m['browserBuild']);
        $this->assertArrayHasKey('app/Games/BingoPinball/Draw.php', $m['source']);
        $this->assertStringContainsString('Version 96', file_get_contents($this->dir.'/02-par-sheets.md'));
        $this->assertStringContainsString('The plunger is for show', file_get_contents($this->dir.'/01-rules-sheet.md'));
        $this->assertSame([], $pack->verify($this->dir));
        $this->artisan('bingo:cert-pack', ['--verify' => $this->dir])->expectsOutputToContain('the installed source and browser build are the certified ones')->assertSuccessful();
    }

    public function test_a_changed_pack_file_is_found(): void
    {
        $pack = new CertPack(base_path());
        $pack->build($this->dir);
        file_put_contents($this->dir.'/01-rules-sheet.md', "changed\n", FILE_APPEND);
        $this->assertContains('pack: 01-rules-sheet.md was changed after the pack was made', $pack->verify($this->dir));
        file_put_contents($this->dir.'/extra.txt', 'x');
        $this->assertContains('pack: extra.txt is not in SHA256SUMS', $pack->verify($this->dir));
    }

    public function test_installed_code_that_differs_from_the_certified_code_is_found(): void
    {
        $pack = new CertPack(base_path());
        $m = $pack->build($this->dir);
        $m['source']['app/Games/BingoPinball/Draw.php'] = str_repeat('0', 64);                 // as if Draw.php had been changed since the pack was made
        $m['browserBuild']['public/js/bingo/game.js'] = str_repeat('1', 64);
        $m['paytables'][4]['sha256'] = str_repeat('2', 64);
        file_put_contents($this->dir.'/MANIFEST.json', json_encode($m, JSON_PRETTY_PRINT));
        $this->reseal();
        $p = $pack->verify($this->dir);
        $this->assertContains('installed: app/Games/BingoPinball/Draw.php (source) differs from the certified one', $p);
        $this->assertContains('installed: public/js/bingo/game.js (browser build) differs from the certified one', $p);
        $this->assertContains('installed: paytable bp-v96-1 differs from the certified one', $p);
        $this->artisan('bingo:cert-pack', ['--verify' => $this->dir])->expectsOutputToContain('NOT the certified code')->assertFailed();
        $this->assertSame(['this is not a certification pack (SHA256SUMS or MANIFEST.json is missing)'], $pack->verify(sys_get_temp_dir()));
    }
}
