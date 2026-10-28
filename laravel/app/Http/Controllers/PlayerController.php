<?php

namespace App\Http\Controllers;

use App\Game\House\PlayerApi;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

/** /player/api/*: the operator's own players (registration, sign-in, wallet): same-origin, cookie session, no CORS */
class PlayerController extends Controller
{
    public function handle(Request $r, string $sub, PlayerApi $api): Response
    {
        return $api->handle($r, $sub);
    }
}
