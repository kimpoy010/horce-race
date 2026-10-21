# Deploying the live game

The game is one small Node.js process (Node 18 or newer, no npm packages) that serves the pages and the API.
Run **exactly one instance** (rounds, bets and sessions are kept in memory plus `data/ledger.jsonl`).

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

* Your platform redirects the player to `https://game.example.com/?token=<one-time launch token>`.
* The game calls your wallet API (see `docs/WALLET_API.md`) from this server: allow its IP on your side and test with
  one small bet before opening the game to players.
* Operator pages: `https://game.example.com/controller` (asks for `CONTROLLER_KEY`): RTP setting and the live report.

## 6. Go-live checklist

* [ ] `GAME_MODE=live`, `NODE_ENV=production`, `WALLET=http`, strong `WALLET_KEY` (requests are HMAC-signed, the platform verifies them), `data/sessions.json` kept private (it is written 0600; sessions survive restarts) and `CONTROLLER_KEY`, `.env` readable only by the service user.
* [ ] HTTPS works, `/controller` and `/api/admin` are restricted by IP or VPN.
* [ ] `data/` is on persistent disk, owned by the service user, mode 700, and backed up (it holds the ledger and seeds).
* [ ] One instance only; the service restarts on failure (systemd `Restart=always` or Docker `unless-stopped`).
* [ ] Wallet test: one bet is debited, a win is credited, restarting the service mid-round refunds or settles correctly.
* [ ] Limits (`MIN_BET`, `MAX_BET`, `MAX_ROUND_STAKE`) agreed with the operator; RTP setting confirmed.
* [ ] Monitoring on `/healthz`, disk space and the "Credits pending" figure in the controller (it should return to 0).
* [ ] Licence, RNG/RTP certification and responsible-gaming requirements for your market are in place.

## Updating

`git pull && docker compose up -d --build` (or `git pull && sudo systemctl restart horse-race`). A restart in the middle
of a round is safe: a drawn race is settled, an undrawn one is refunded. Prefer to update between rounds anyway.

## Limits of this build

State lives in memory and one ledger file, so there is no high availability or horizontal scaling. For several servers or
very high volume, move rounds, bets and sessions to a shared database first.
