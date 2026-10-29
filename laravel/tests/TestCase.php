<?php

namespace Tests;

use Illuminate\Foundation\Testing\TestCase as BaseTestCase;

require_once __DIR__.'/Support/DeterministicRandom.php';      // test-only: reproducible identifiers for the horse-race golden baseline

abstract class TestCase extends BaseTestCase
{
    //
}
