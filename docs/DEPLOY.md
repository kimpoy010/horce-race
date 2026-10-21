# Deploying the live game

The game is one small Node.js process (Node 18 or newer, no npm packages) that serves the pages and the API.
Run **one active instance** (rounds, bets and sessions are kept in memory plus `data/ledger.jsonl`). A second instance on the same data
directory refuses to start, or waits as a standby (section 9).

## 1. Server

A small Linux VM is enough (1 vCPU, 512 MB-1 GB RAM). Open ports 80 and 443 only. Point a DNS name at it
(e.g. `game.example.com`) and keep the server clock in sync (`chrony` / `systemd-timesyncd`): rounds are time based.

## 2. Configure (`.env`, see `.env.example`)

```
GAME_MODE=live
WALLET=http
WALLET_URL=https://platform.example.com/horse-api      # your platform, see docs/WALLET_API.md
WALLET_KEY=<long random secret shared with the platform>
CONTROLLER_KEY=<long random secret for the operator pages>
CURRENCY=PHP
RTP=90                                                # 88-99, later editable in the controller
MIN_BET=100 MAX_BET=100000 MAX_ROUND_STAKE=500000      # minor units (100 = 1.00)
```
Use `WALLET=mock` (with `ALLOW_MOCK_WALLET=1`) only for testing with play money; it is refused when `NODE_ENV=production`. Never commit `.env`.

## 3a. Docker (simplest)

```
git clone <repo> && cd <repo> && git checkout claude/vibrant-noether-1g9yl1
cp .env.example .env && nano .env
docker compose up -d --build
curl http://127.0.0.1:8080/healthz        # {"ok":true,"mode":"live"}
```
`./data` is mounted into the container: it holds the ledger (with the secret seeds), the RTP setting and the player sessions.

## 3b. Without Docker (systemd)

```
sudo useradd -r -m -d /opt/horse-race horse
sudo -u horse git clone <repo> /opt/horse-race && cd /opt/horse-race && sudo -u horse git checkout claude/vibrant-noether-1g9yl1
sudo install -m 600 -o horse .env.example /etc/horse-race.env && sudo nano /etc/horse-race.env
sudo cp deploy/horse-race.service /etc/systemd/system/ && sudo systemctl enable --now horse-race
journalctl -u horse-race -f
```

## 4. HTTPS reverse proxy

Install nginx and certbot, copy `deploy/nginx.conf` to `/etc/nginx/conf.d/horse-race.conf`, set your domain and the
IP addresses that may open `/controller`, then `sudo certbot --nginx -d game.example.com` and `sudo nginx -s reload`.
The app listens on `127.0.0.1:8080` only; the proxy terminates TLS (the launch token travels in the URL, HTTPS is a must).

## 5. Connect the platform

Several platforms on one game server: register each one as a client (own wallet, secrets, API key, limits, webhook) with `node scripts/clients.js add ...`;
see **docs/CLIENT_API.md**. Set `CLIENTS_KEY` first and back up `data/clients.json` together with it. With only registry clients use `WALLET=none` and `TRUST_PROXY=1` behind nginx.

* Your platform redirects the player to `https://game.example.com/?token=<one-time launch token>`.
* The game calls your wallet API (see `docs/WALLET_API.md`) from this server: allow its IP on your side and test with
  one small bet before opening the game to players.
* Operator pages: `https://game.example.com/controller` (asks for `CONTROLLER_KEY`): RTP setting and the live report.

## 6. Go-live checklist

* [ ] `GAME_MODE=live`, `NODE_ENV=production`, `WALLET=http`, strong `WALLET_KEY` (requests are HMAC-signed, the platform verifies them), `data/sessions.json` kept private (it is written 0600; sessions survive restarts) and `CONTROLLER_KEY`, `.env` readable only by the service user.
* [ ] Operator console: `node scripts/clients.js add-operator <name> --role admin` for each staff member, two-step sign-in on, `/admin` restricted by IP or VPN in nginx (docs/ADMIN_CONSOLE.md).
* [ ] Back office: each client has its first administrator (`add-user`), `TRUST_PROXY=1` behind nginx, HTTPS in front (the session cookie is `Secure`), administrators asked to turn on two-step sign-in (docs/BACKOFFICE.md).
* [ ] Clients registered (`node scripts/clients.js list`), each with its own wallet secret and API key given over a safe channel; `CLIENTS_KEY` set and backed up; `TRUST_PROXY=1` behind the proxy if you use `allowedIps`.
* [ ] HTTPS works, `/controller` and `/api/admin` are restricted by IP or VPN.
* [ ] `data/` is on persistent disk, owned by the service user, mode 700, and backed up (it holds the ledger and seeds).
* [ ] One active instance; the service restarts on failure (systemd `Restart=always` or Docker `unless-stopped`); optional standby, section 9.
* [ ] Wallet test: one bet is debited, a win is credited, restarting the service mid-round refunds or settles correctly.
* [ ] Limits (`MIN_BET`, `MAX_BET`, `MAX_ROUND_STAKE`) agreed with the operator; RTP setting confirmed.
* [ ] Alerts reach a person: `ALERT_WEBHOOK_URL` set and tested (section 7); `/healthz` watched by an uptime check; the ledger head hash kept by the platform (section 8).
* [ ] Licence, RNG/RTP certification and responsible-gaming requirements for your market are in place.

## Updating

`git pull && docker compose up -d --build` (or `git pull && sudo systemctl restart horse-race`). A restart in the middle
of a round is safe: a drawn race is settled, an undrawn one is refunded. Prefer to update between rounds anyway.

## 7. Monitoring and alerts

* **`/healthz`**: 200 while this process is the healthy active instance, 503 otherwise (standby, starting, shutting down, broken ledger,
  round loop stalled). Point the load balancer and your uptime service at it.
* **`/metrics`**: Prometheus text format, operator only (`X-Controller-Key` header or `Authorization: Bearer <CONTROLLER_KEY>`; in nginx it is on the
  restricted list). Series: wallet calls and latency per operation, pending credits / rollbacks / webhooks and their age, ledger health, rounds,
  staked and paid per currency, RTP setting, actual RTP, `horse_rtp_zscore`, sessions, tick age, role, memory. Prometheus example:
  `scrape_configs: [{ job_name: horse, metrics_path: /metrics, authorization: { credentials: <CONTROLLER_KEY> }, static_configs: [{ targets: ['game.example.com'] }] }]`
* **Controller page**: the "Health and alerts" panel shows the same data with the active alerts.
* **Built-in alerts** (no Prometheus needed). Checked every 10 s, printed to the log and posted to `ALERT_WEBHOOK_URL` as JSON
  `{ text, status: firing|resolved, name, severity, message, since, at }` (`text` works with Slack / Teams / Discord incoming webhooks).
  An alert fires once, repeats every `ALERT_REPEAT_MIN` (30) while it lasts, and sends a resolved message.

| Alert | Fires when | Setting (default) |
|---|---|---|
| `credits_stuck` (critical) | a win or refund is still undelivered to the wallet | `ALERT_CREDIT_MIN` (5 min) |
| `rollbacks_stuck` (critical) | a rollback is unconfirmed, a player may be charged for a bet that was not placed | `ALERT_ROLLBACK_MIN` (2 min) |
| `wallet_failing` (critical) | more than 20% of wallet calls fail in 5 min (at least 5 calls) | `ALERT_WALLET_FAIL_RATE` (0.2) |
| `wallet_slow` (warning) | the slowest 5% of wallet calls take over 3 s | `ALERT_WALLET_P95_MS` (3000) |
| `webhooks_stuck` (warning) | the platform does not accept webhook events | `ALERT_WEBHOOK_MIN` (10 min) |
| `round_loop_stalled` (critical) | the round loop has not run for 5 s | - |
| `ledger_broken` (critical) | the hash chain is broken (section 8) | - |
| `rtp_drift` (warning) | payouts are more than 4 standard deviations away from what the odds predict for the bets actually placed (after 300 races) | `ALERT_RTP_Z` (4) |
| `disk_low` (critical) | under 500 MB free where the ledger is kept | `ALERT_DISK_FREE_MB` (500) |

`rtp_drift` compares the real payouts with the expectation of each bet (stake x odds x its win chance). It catches payout bugs or a
broken draw without being fooled by which pairs players happen to pick.

## 8. Tamper-evident ledger

Every line of `data/ledger.jsonl` carries a hash of the line and of the line before it. Changing, removing, adding or re-ordering a
line breaks the chain from that point on.

* **Check it**: `node scripts/verify-ledger.js [data/ledger.jsonl]` (exit code 0 = intact; run it from cron too). The server checks the chain when it
  starts: a broken chain raises the `ledger_broken` alert and turns `/healthz` red; with `LEDGER_STRICT=1` the server refuses to start.
* **Anchor it outside the server**: every `round.settled` webhook carries `ledgerHash` (the newest hash) and `ledgerLines`. If the platform
  stores them, rewriting the whole file still shows up, because the platform's hash for that line would no longer match, and so would a file cut
  short. Compare with `node scripts/verify-ledger.js`, which prints the head hash.
* Lines written before this feature are accepted as a prefix; the chain starts after them.
* The file only grows. Archive it periodically (stop the game, move the file, start again: a new chain starts); keep archives with their final hash.

## 9. Failover: active / standby

Only one process may run the races, so high availability here means **fast takeover**, not two instances working together.

* The active instance holds a lease file (`data/instance.lease`, renewed every second). Without any setting, a second instance on the same data
  directory refuses to start. With `STANDBY=1` it waits, answering `/healthz` with 503 and `/api/*` with `STANDBY`, and takes over when the lease
  has not been renewed for `LEASE_TTL_MS` (10 s): it replays the ledger (a running race is settled, an undrawn one refunded, queued wallet calls
  resume) and becomes active. The old process stops itself if it cannot renew (fencing), so two never act at once.
* **Same machine**: no standby needed. `Restart=always` (systemd) or `restart: unless-stopped` (Docker) restarts a crashed process in seconds,
  and a second instance stays out of the way.
* **Two machines**: both mount the same `data/` directory (a shared volume with normal POSIX file semantics, e.g. NFSv4, a cloud shared disk) and run
  with `STANDBY=1`; put both behind the proxy (`deploy/nginx-ha.conf`) so that traffic follows `/healthz`. Expect about 10 to 15 seconds without
  betting during a takeover. The lease is a practical mechanism, not a replacement for a real lock service: if your storage cannot give consistent
  files to both machines, keep a single instance with fast restart.
* **Deploys**: `SIGTERM` makes the game stop taking bets (`SHUTTING_DOWN`), deliver queued wins and refunds for up to 5 s, store the sessions
  and release the lease. A standby takes over at once. Docker waits 15 s (`stop_grace_period`), systemd `TimeoutStopSec=15`.

## Limits of this build

State lives in one process plus one ledger file. Failover is active / standby (section 9), not horizontal scaling. For several servers
sharing the load or very high volume, move rounds, bets and sessions to a shared database first. Ledger archiving is manual.
