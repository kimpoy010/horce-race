<?php

namespace App\Http\Controllers;

use Illuminate\Http\Response;

/**
 * The pages of the app: the game, the operator's panels and the players' account page. They are static files, with two additions:
 * every script and style address carries a version (?v=...) that changes when the file changes, so a browser (or Cloudflare) that cached an older
 * script for hours loads the new one at once; and the panels may not be framed and may only load their own files.
 * A controller (not a closure) so that `route:cache` works.
 */
class PanelController extends Controller
{
    private const PAGES = ['controller.html', 'backoffice.html', 'admin.html', 'account.html'];

    /** adds ?v=<modified time and size> to the script and style addresses of a page */
    public static function versioned(string $html): string
    {
        return preg_replace_callback('#\b(src|href)="((?:js|css)/[A-Za-z0-9_.-]+\.(?:js|css))"#', function (array $m): string {
            $file = public_path($m[2]);

            return $m[1].'="'.$m[2].(is_file($file) ? '?v='.dechex((int) filemtime($file)).dechex((int) filesize($file)) : '').'"';
        }, $html) ?? $html;
    }

    private function page(string $file, array $headers): Response
    {
        abort_unless(is_file(public_path($file)), 404);

        return response(self::versioned((string) file_get_contents(public_path($file))), 200, ['Content-Type' => 'text/html; charset=UTF-8', 'Cache-Control' => 'no-cache'] + $headers);
    }

    /** the game: it may be embedded by a platform, so it is not marked as "do not frame" */
    public function game(): Response
    {
        return $this->page('index.html', ['X-Content-Type-Options' => 'nosniff']);
    }

    public function show(string $file): Response
    {
        abort_unless(in_array($file, self::PAGES, true), 404);

        return $this->page($file, [
            'X-Frame-Options' => 'DENY', 'Referrer-Policy' => 'no-referrer', 'X-Content-Type-Options' => 'nosniff',
            'Content-Security-Policy' => "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; form-action 'self'",
        ]);
    }
}
