<?php

namespace Tests\Feature;

use Illuminate\Support\Facades\Artisan;
use Tests\TestCase;

/** the install script runs `route:cache`: every page must still be served from the cached routes (closures built by a factory function are not cacheable) */
class RouteCacheTest extends TestCase
{
    public function test_every_page_works_with_the_route_cache_on(): void
    {
        Artisan::call('route:cache');
        try {
            $this->refreshApplication();
            foreach (['/', '/play', '/admin', '/controller', '/backoffice', '/account', '/register', '/login'] as $path) {
                $this->get($path)->assertOk();
            }
            $this->get('/admin')->assertHeader('X-Frame-Options', 'DENY');
            $this->get('/nope')->assertNotFound();
        } finally {
            Artisan::call('route:clear');
            $this->refreshApplication();
        }
    }
}
