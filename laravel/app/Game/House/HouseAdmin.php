<?php

namespace App\Game\House;

use App\Game\GameError;
use Symfony\Component\HttpFoundation\Response;

/** The cashier part of the operator's admin console: players, deposits, withdrawals, payment accounts (called from AdminRoutes). Support staff and up; money settings and manual adjustments are admin only. */
final class HouseAdmin
{
    /** @param array $x the request context AdminRoutes builds (sub, method, send, audit, need, me, body, request) */
    public static function route(array $x, House $house): ?Response
    {
        $sub = $x['sub'];
        if (! str_starts_with($sub, 'house/')) {
            return null;
        }
        $method = $x['method'];
        $send = $x['send'];
        $need = $x['need'];
        $audit = $x['audit'];
        $body = $x['body'];
        $who = $x['me']->username;
        $q = $x['request']->query();
        $need('support');
        $rest = substr($sub, 6);

        if ($rest === 'summary' && $method === 'GET') {
            return $send(200, ['ok' => true, 'summary' => $house->summary(), 'settings' => $house->settings()]);
        }
        if ($rest === 'settings' && $method === 'POST') {
            $need('admin');
            $s = $house->saveSettings($body);
            $audit(['action' => 'house_settings', 'detail' => count($s['methods']).' payment accounts, registration '.($s['registration'] ? 'open' : 'closed')]);

            return $send(200, ['ok' => true, 'settings' => $s]);
        }
        if ($rest === 'players' && $method === 'GET') {
            return $send(200, ['ok' => true, 'players' => $house->players((string) ($q['q'] ?? ''), (int) ($q['limit'] ?? 50))]);
        }
        if (preg_match('#^players/(\d{1,12})(?:/(status|adjust|reset-password|note))?$#', $rest, $m)) {
            $id = (int) $m[1];
            $act = $m[2] ?? null;
            if (! $act && $method === 'GET') {
                $d = $house->detail($id);

                return $d ? $send(200, ['ok' => true] + $d) : $send(404, ['ok' => false, 'error' => 'NOT_FOUND']);
            }
            if (! $house->player($id)) {
                return $send(404, ['ok' => false, 'error' => 'NOT_FOUND']);
            }
            if ($act === 'status' && $method === 'POST') {
                $st = ($body['status'] ?? '') === 'suspended' ? 'suspended' : 'active';
                $house->setStatus($id, $st, 'admin:'.$who);
                $audit(['action' => $st === 'suspended' ? 'player_suspended' : 'player_reactivated', 'target' => 'house:p'.$id, 'detail' => substr((string) ($body['reason'] ?? ''), 0, 200)]);

                return $send(200, ['ok' => true, 'status' => $st]);
            }
            if ($act === 'adjust' && $method === 'POST') {
                $need('admin');
                $amount = $body['amount'] ?? null;
                if (! is_int($amount)) {
                    throw new GameError(400, 'BAD_AMOUNT', 'The amount must be a whole number of centavos (negative to take money away).');
                }
                $bal = $house->adjust($id, $amount, (string) ($body['reason'] ?? ''), $who);
                $audit(['action' => 'wallet_adjusted', 'target' => 'house:p'.$id, 'detail' => House::fmt($amount).' - '.substr((string) ($body['reason'] ?? ''), 0, 160)]);

                return $send(200, ['ok' => true, 'balance' => $bal]);
            }
            if ($act === 'reset-password' && $method === 'POST') {
                $temp = $house->resetPassword($id);
                $audit(['action' => 'player_password_reset', 'target' => 'house:p'.$id]);

                return $send(200, ['ok' => true, 'tempPassword' => $temp]);
            }
            if ($act === 'note' && $method === 'POST') {
                $house->note($id, (string) ($body['note'] ?? ''));
                $audit(['action' => 'player_note', 'target' => 'house:p'.$id]);

                return $send(200, ['ok' => true]);
            }
        }
        if (preg_match('#^queue/(deposits|withdrawals)$#', $rest, $m) && $method === 'GET') {
            $st = (string) ($q['status'] ?? 'pending');

            return $send(200, ['ok' => true, 'items' => $house->queue($m[1], in_array($st, ['pending', 'approved', 'rejected', 'paid'], true) ? $st : 'pending')]);
        }
        if (preg_match('#^deposits/(\d{1,12})/(approve|reject)$#', $rest, $m) && $method === 'POST') {
            $row = $house->decideDeposit((int) $m[1], $m[2] === 'approve', 'admin:'.$who, (string) ($body['note'] ?? ''));
            $audit(['action' => 'deposit_'.($m[2] === 'approve' ? 'approved' : 'rejected'), 'target' => 'house:p'.$row->player_id, 'detail' => '#'.$row->id.' '.House::fmt((int) $row->amount).' '.$row->method.' '.$row->reference]);

            return $send(200, ['ok' => true, 'status' => $row->status]);
        }
        if (preg_match('#^withdrawals/(\d{1,12})/(pay|reject)$#', $rest, $m) && $method === 'POST') {
            $row = $house->decideWithdrawal((int) $m[1], $m[2] === 'pay', 'admin:'.$who, (string) ($body['payoutRef'] ?? ''), (string) ($body['note'] ?? ''));
            $audit(['action' => 'withdrawal_'.($m[2] === 'pay' ? 'paid' : 'rejected'), 'target' => 'house:p'.$row->player_id, 'detail' => '#'.$row->id.' '.House::fmt((int) $row->amount).' '.$row->method.' '.($row->payout_ref ?? '')]);

            return $send(200, ['ok' => true, 'status' => $row->status]);
        }

        return $send(404, ['ok' => false, 'error' => 'NOT_FOUND']);
    }
}
