<?php

namespace Tests\Feature;

use Illuminate\Support\Facades\Artisan;
use Tests\TestCase;

class BingoParCommandTest extends TestCase
{
    public function test_the_command_succeeds_for_every_version_and_each_one_alone(): void
    {
        $this->assertSame(0, Artisan::call('bingo:par'));
        foreach ([88, 90, 92, 94, 96] as $v) {
            $this->assertSame(0, Artisan::call('bingo:par', ['version' => $v]));
            $this->assertStringContainsString('MATCHES the published figures', Artisan::output());
        }
        $this->assertSame(1, Artisan::call('bingo:par', ['version' => 89]), 'an unknown version is refused');
    }

    public function test_json_output_is_machine_readable(): void
    {
        Artisan::call('bingo:par', ['version' => 96, '--json' => true]);
        $j = json_decode(Artisan::output(), true);
        $this->assertSame('8548/8855', $j['96']['rtpFraction']);
        $this->assertSame('96.53', $j['96']['rtpRounded']);
        $this->assertTrue($j['96']['matchesPublished']);
        $this->assertSame([0, 68, 30706, 21144, 1200, 12], $j['96']['counts']);
    }

    public function test_the_published_par_sheets_are_exactly_what_the_command_prints(): void
    {
        Artisan::call('bingo:par', ['--markdown' => true]);
        $this->assertSame(\App\Console\Commands\BingoPar::markdown(), Artisan::output(), 'the command prints the document');
        $this->assertSame(\App\Console\Commands\BingoPar::markdown(), file_get_contents(base_path('docs/bingo/PAR_SHEETS.md')),
            'docs/bingo/PAR_SHEETS.md is out of date. After a deliberate paytable change, rewrite it with the text BingoPar::markdown() returns (see docs/bingo/MATH.md).');    }
}
