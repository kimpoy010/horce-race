<?php

namespace Tests\Feature;

use Tests\TestCase;

/** The Fruit Game page is served like the other games' pages, with its scripts versioned. */
class FruitPageTest extends TestCase
{
    public function test_the_page_is_served_with_versioned_scripts(): void
    {
        $r = $this->get('/games/fruit-ring')->assertOk();
        $this->assertStringContainsString('FRUIT GAME', $r->getContent());
        $this->assertMatchesRegularExpression('#/js/fruit/game\.js\?v=[0-9a-f]+#', $r->getContent());
        $this->assertMatchesRegularExpression('#/css/fruit\.css\?v=[0-9a-f]+#', $r->getContent());
        foreach (['table', 'art', 'anim', 'view', 'fair', 'api', 'sound', 'game'] as $f) {
            $this->assertFileExists(public_path("js/fruit/$f.js"));
        }
    }
}
