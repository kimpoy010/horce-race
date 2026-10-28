<?php

namespace Tests\Feature;

use Tests\TestCase;

/** a script that changes must get a new address, or phones keep running the old one for hours (Cloudflare caches .js for 4 hours) */
class PagesTest extends TestCase
{
    public function test_script_and_style_addresses_carry_a_version_that_follows_the_file(): void
    {
        $html = $this->get('/')->assertOk()->assertHeader('Cache-Control', 'no-cache, private')->getContent();
        $this->assertSame(0, preg_match('#(?:src|href)="(?:js|css)/[^"?]+"#', $html), 'every script and style address has a version');
        $this->assertMatchesRegularExpression('#<script src="js/horses3d\.js\?v=[0-9a-f]+"></script>#', $html);
        $this->assertStringContainsString('href="manifest.webmanifest"', $html, 'other addresses are left alone');
        $file = public_path('js/horses3d.js');
        $before = (int) filemtime($file);
        touch($file, $before + 100);
        try {
            $this->assertNotSame($html, $this->get('/')->getContent(), 'a changed file gets a new address');
        } finally {
            touch($file, $before);
        }
        $this->assertSame($html, $this->get('/')->getContent(), 'and the same file keeps its address');
    }

    public function test_every_panel_is_versioned_too_and_the_game_can_still_be_embedded(): void
    {
        foreach (['/admin', '/controller', '/backoffice', '/account'] as $path) {
            $r = $this->get($path)->assertOk()->assertHeader('X-Frame-Options', 'DENY');
            $this->assertSame(0, preg_match('#(?:src|href)="(?:js|css)/[^"?]+"#', $r->getContent()), "$path has versioned addresses");
        }
        $this->assertNull($this->get('/')->headers->get('X-Frame-Options'), 'platforms embed the game');
    }
}
