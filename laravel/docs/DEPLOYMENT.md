# Deploying the Laravel app

nginx + PHP-FPM serve browsers and platforms; **one** daemon (`php artisan game:run`) moves the rounds; cron runs the scheduler (alert checks). All state is in the database.

## Quick install on a fresh Ubuntu 24.04 VPS

```
sudo ./bin/install-vps.sh --domain race.example.com --email you@example.com --operator-ip YOUR.IP
```

Installs nginx, PHP 8.4, PostgreSQL, Redis and Composer, writes `.env` with generated keys, sets up the daemon, cron, firewall and HTTPS (`--help` lists the options, `--mode demo` uses the play-money wallet). Safe to re-run for updates. The sections below describe what it does.

## Your own players

The installer also switches on player registration and the built-in wallet (`php artisan house:setup`, skip with `--no-house`). How it works, the daily routine and what you must check before taking real money: [OWN_SITE.md](OWN_SITE.md).

## Requirements

PHP 8.3 with `pdo_pgsql`, `openssl`, `mbstring`, `curl`, argon2id password hashing (default in PHP builds), optionally `pcntl` (clean daemon stop); PostgreSQL 14+; Composer; nginx; optionally Redis (recommended for the cache).

## Install

```
cd /var/www/horse && composer install --no-dev --optimize-autoloader
cp .env.example .env && php artisan key:generate
# edit .env (below), then
php artisan migrate --force
php artisan config:cache && php artisan route:cache
```

## Production `.env`

```
APP_ENV=production
APP_DEBUG=false
APP_URL=https://race.example.com
DB_CONNECTION=pgsql  DB_HOST=… DB_PORT=5432 DB_DATABASE=horserace DB_USERNAME=horse DB_PASSWORD=…
CACHE_STORE=redis            # or database
HORSE_WALLET=none            # the mock wallet is refused in production; clients bring their own wallet URL
HORSE_CLIENTS_KEY=…          # long random; protects wallet secrets at rest. Same value as Node's CLIENTS_KEY when migrating. Never change it afterwards.
HORSE_CONTROLLER_KEY=…       # operator API / metrics
HORSE_COOKIE_SECURE=true
HORSE_TRUST_PROXY=true       # behind nginx: use X-Forwarded-For for IPs
HORSE_ALERT_WEBHOOK_URL=…    # optional: alert notifications
```

## Daemon (systemd)

```
[Unit]
Description=Horse race round loop
After=network.target postgresql.service
[Service]
User=www-data
WorkingDirectory=/var/www/horse
ExecStart=/usr/bin/php artisan game:run
Restart=always
RestartSec=2
KillSignal=SIGTERM
TimeoutStopSec=30
[Install]
WantedBy=multi-user.target
```

Supervisor equivalent: `command=php artisan game:run`, `autorestart=true`, `stopsignal=TERM`, `stopwaitsecs=30`.
Cron: `* * * * * www-data cd /var/www/horse && php artisan schedule:run >> /dev/null 2>&1`

Only one round loop runs per database (`Cache::lock`); a second `game:run` waits. With a file/array cache driver across hosts the lock does not work: use database or Redis cache.

## nginx

Based on `deploy/nginx.conf` of the Node version.

```
limit_req_zone $binary_remote_addr zone=hr_api:10m rate=20r/s;
limit_req_zone $binary_remote_addr zone=hr_login:10m rate=5r/m;
server {
  listen 443 ssl http2; server_name race.example.com;
  root /var/www/horse/public; index index.php;
  add_header Strict-Transport-Security "max-age=31536000" always;
  add_header Referrer-Policy "no-referrer" always;

  location ~ ^/(controller|admin|metrics|api/admin|api/report|api/command|api/clients) {   # operator paths: office/VPN IPs only
    allow 203.0.113.0/24; deny all;
    try_files $uri /index.php?$query_string;
  }
  location /bo/api/login { limit_req zone=hr_login burst=5 nodelay; try_files $uri /index.php?$query_string; }
  location /api/ { limit_req zone=hr_api burst=40 nodelay; try_files $uri /index.php?$query_string; }
  location / { try_files $uri /index.php?$query_string; }
  location ~ \.php$ { include fastcgi_params; fastcgi_pass unix:/run/php/php8.3-fpm.sock; fastcgi_param SCRIPT_FILENAME $realpath_root$fastcgi_script_name; }
  location ~ /\.(?!well-known) { deny all; }
}
```

The `/metrics` allow-list: also allow your Prometheus host. `/admin/` login has its own throttling in the app.

## PHP-FPM sizing

A bet request holds a worker while the wallet call runs (up to ~8 s on a slow platform). Size `pm.max_children` for peak concurrent bets, not page views; `/api/public` is cached (`horse:public-parts`) and costs no queries on a hit. Enable opcache (`opcache.validate_timestamps=0` in production; reload FPM on deploy).

## PostgreSQL

* Dedicated role for the app; the ledger table is append-only (trigger rejects UPDATE/DELETE) — never grant superuser.
* Backups: nightly `pg_dump` plus WAL archiving; test a restore, then run `php artisan ledger verify`.
* `php artisan ledger export <file>` produces a Node-compatible ledger for audits.

## Monitoring

* Prometheus scrapes `/metrics` with `Authorization: Bearer <controller key>`.
* Uptime check on `/healthz`.
* Built-in alerts (ledger broken, round loop stalled, credits/rollbacks/webhooks stuck, wallet failing/slow per client, RTP drift, disk low) go to `HORSE_ALERT_WEBHOOK_URL` and the admin console; `alerts:check` runs from the scheduler every minute.

## Security checklist

- [ ] HTTPS only, HSTS, `APP_DEBUG=false`, mock wallet off
- [ ] Operator paths IP-restricted; staff accounts have TOTP enabled
- [ ] `.env` readable by the app user only; `HORSE_CLIENTS_KEY` backed up separately from the database
- [ ] DB reachable only from app hosts; backups encrypted
- [ ] Platforms' wallet URLs use HTTPS and verify our signature

## Upgrades

1. `php artisan down`, deploy code, `composer install --no-dev -o`, `php artisan migrate --force`, `config:cache route:cache`.
2. Restart the daemon between races (it stops cleanly on SIGTERM), reload PHP-FPM, `php artisan up`.

## Scaling

One round loop per database. Add web hosts freely (shared database + Redis cache). The loop host is the single point of failure: run a standby `game:run` on a second host — it waits on the lock and takes over when the first stops.

## Troubleshooting

| Symptom | Check |
|---|---|
| Rounds not advancing | `systemctl status horse-game`; alert `round_loop_stalled`; cache driver supports locks |
| Credits piling up | Platform wallet URL/availability; `horse_pending_credits`; they retry with backoff |
| Wallet "bad signature" | Client secret / `HORSE_CLIENTS_KEY` changed; clock skew > window |
| Can't log in to /admin | `php artisan staff add-operator`; check TOTP clock; throttling |
| Slow `/api/public` | Cache driver = redis; check cache hit |
