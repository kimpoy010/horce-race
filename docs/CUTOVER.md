# Cutover: Node server → Laravel app

Moves a running `GAME_MODE=live` Node installation to the Laravel app in `laravel/` without losing a cent, a ledger line or a client.
Deployment of the Laravel app itself is in [`laravel/docs/DEPLOYMENT.md`](../laravel/docs/DEPLOYMENT.md).

## What stays the same / what changes

| Stays the same | Changes |
|---|---|
| Player URLs, platform API keys (`hrk_…`), wallet contract and signatures, wallet secrets (same `CLIENTS_KEY`) | Staff passwords: Node used scrypt, Laravel argon2id — every back-office/admin user needs a password reset |
| Race numbers continue (no wallet `txId` is ever reused) | Browser sessions (players and staff) are not carried over; players re-launch from the platform |
| The ledger hash chain continues from the Node head | One race still taking bets at cutover is **cancelled with refunds** |
| RTP setting, block list, client registry | Process model: web workers + one `php artisan game:run` daemon + cron |

## Before the day

1. Deploy the Laravel app on the new host/database following DEPLOYMENT.md, **same `HORSE_CLIENTS_KEY` as Node's `CLIENTS_KEY`**, but do not point traffic at it.
2. Rehearse on a copy of production data (steps 2–6 below with `--dry-run` first). Rehearse until it takes no surprises; time it.
3. Tell platforms the planned window (a few minutes without betting). Wallet calls in flight are idempotent, pending credits are carried over.
4. Lower DNS TTL or confirm you can switch the proxy upstream instantly.

## Runbook

1. **Wait for the results phase** of a race (so that few bets are open), then stop Node with `SIGTERM` (`systemctl stop horse-race`). Wait until the ledger shows the `shutdown` event: `tail -1 data/ledger.jsonl` (file mode) or `scripts/verify-ledger.js`. Node flushes the write queue before exiting.
2. **Copy the data directory** (file mode) or keep the PostgreSQL database for reading. Keep it untouched afterwards: it is the rollback.
3. `node scripts/verify-ledger.js` on the copy — must say the chain is intact.
4. On the Laravel host: `php artisan migrate:fresh --force` then
   `php artisan import:node --dir=/path/to/copy --dry-run` and, if it looks right, without `--dry-run`.
   The command refuses a broken chain or a non-empty database; it copies the ledger lines (chain continues), rebuilds rounds, bets and pending credits/rollbacks/webhooks, voids the race that was still taking bets (refunds), imports clients, block list and RTP.
5. `php artisan ledger verify` — chain intact, head equals the Node head.
6. Create staff: `php artisan staff add-operator <name>` (admin console) and per back-office user `staff reset-password …` / `staff add …`. Hand out the one-time passwords over a secure channel.
7. Start the daemon (`game:run`), PHP-FPM and cron. Compare the two servers (Node data still readable via a read-only instance, or the figures you noted):
   `node scripts/compare-servers.js <nodeUrl> <nodeKey> <laravelUrl> <laravelKey>` — rounds, bets, staked, paid, wins, RTP setting, blocked players and every client's figures must be identical (exit code 0). Do this before opening bets, or with Node started read-only on a copy.
8. **Smoke test** on the Laravel host directly: `/healthz`, `/api/public`, `/metrics` (controller key), one launch + a small bet + settlement with a test client, `/admin` login.
9. **Switch** the proxy/DNS to the Laravel upstream. Watch `/metrics` and the alerts for an hour: `horse_pending_credits`, `horse_ledger_ok`, wallet failure rate, round loop heartbeat.

## Verification checklist

- [ ] `ledger verify` intact; head equals Node's last head (+ the void/refund lines of the cancelled race)
- [ ] `compare-servers.js` exit code 0
- [ ] Every client: status, currency, wallet URL, webhook identical; an existing API key authenticates
- [ ] Pending credits/rollbacks/webhooks equal Node's counts and drain
- [ ] First live race drawn, settled, credited; ledger lines continue the chain
- [ ] Alerts quiet; test webhook alert delivered

## Rollback

* **Before the first Laravel bet:** switch the proxy back to Node; its data directory is unchanged.
* **After bets were taken on Laravel:** stop the daemon, then `php artisan ledger export data/ledger.jsonl` and `php artisan clients export data/clients.json` into a Node data directory, `node scripts/verify-ledger.js` it (Node's own verifier accepts the export), recreate Node staff users, start Node, switch back. Node rebuilds all state from the ledger.

## Risks

| Risk | Mitigation |
|---|---|
| Wrong/lost `CLIENTS_KEY` | Wallet secrets cannot be decrypted → use the same key; rehearsal catches it |
| Two round loops at once | `game:run` takes a lock; Node must be stopped first (Node's lease/lock prevents two Nodes only) |
| Platforms retry during the window | Wallet calls are idempotent; credits are queued and retried with backoff |
| Pending credits missing | `compare-servers.js` and pending counts in the checklist |
| Staff locked out | Keep a console user (`staff add-operator`) ready before the switch |
| Cache stale after import | `php artisan cache:clear` once after import, before opening |

## After

Keep the Node data read-only for 30 days, take a database backup right after the cutover, then decommission Node and its units. See DEPLOYMENT.md for backups and monitoring.
