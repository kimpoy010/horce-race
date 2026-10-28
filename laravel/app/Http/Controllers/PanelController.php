<?php

namespace App\Http\Controllers;

use Symfony\Component\HttpFoundation\BinaryFileResponse;

/** The operator's panels and the players' account page: static files that must not be framed and may only load their own files. A controller (not a closure) so that `route:cache` works. */
class PanelController extends Controller
{
    private const PAGES = ['controller.html', 'backoffice.html', 'admin.html', 'account.html'];

    public function show(string $file): BinaryFileResponse
    {
        abort_unless(in_array($file, self::PAGES, true), 404);

        return response()->file(public_path($file), [
            'X-Frame-Options' => 'DENY', 'Referrer-Policy' => 'no-referrer', 'X-Content-Type-Options' => 'nosniff', 'Cache-Control' => 'no-cache',
            'Content-Security-Policy' => "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; form-action 'self'",
        ]);
    }
}
