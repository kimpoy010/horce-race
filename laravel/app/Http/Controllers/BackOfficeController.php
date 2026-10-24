<?php

namespace App\Http\Controllers;

use App\Game\Staff\BackOffice;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

/** /bo/api/* (a client's back office) and /admin/api/* (the operator's console): same-origin, cookie sessions, no CORS (see App\Game\Staff\BackOffice) */
class BackOfficeController extends Controller
{
    public function bo(Request $r, string $sub): Response
    {
        return app('horse.backoffice')->handle($r, $sub);
    }

    public function admin(Request $r, string $sub): Response
    {
        return app('horse.admin')->handle($r, $sub);
    }
}
