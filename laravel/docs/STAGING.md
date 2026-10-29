# Staging environment

A staging server is a second copy of the app that behaves like production but handles no real money and no real players. Every change is tried there first. This page says how to build one that matches production, and what must never cross between the two.

## The one rule

**Staging never touches production's keys, data, wallets or players.** A staging server that can call a real platform's wallet can debit real players.

* Own server, own database, own `.env` with **new** `HORSE_CLIENTS_KEY` and `HORSE_CONTROLLER_KEY` (the install script generates them). Never copy production's `.env`.
* `APP_ENV=staging` (not production). In this mode the app accepts play-money wallets; in production it refuses them.
* Clients on staging use the mock wallet or the platform's **test** wallet URL, never the live one.
* Keep the site off the public internet or behind a login (for example Cloudflare Access), and never link it from the live site.

## Match production

Run these on the production server and write the answers into the table. Use the same major versions on staging.

| Component | Command | Production (fill in) | Staging |
|---|---|---|---|
| Operating system | `lsb_release -ds` | | same |
| PHP | `php -v` | | same major.minor |
| PHP extensions | `php -m \| grep -Ei "pgsql\|redis\|opcache\|mbstring\|curl"` | | same |
| PostgreSQL | `psql --version` | | same major |
| Redis | `redis-server --version` | | same major |
| nginx | `nginx -v` | | same |
| Composer | `composer --version` | | same major |
| App version | `git -C /var/www/html/horce-race log --oneline -1` | | the change under test |
| PHP-FPM / opcache settings | `grep -E "pm\.max_children\|validate_timestamps" /etc/php/*/fpm/pool.d/www.conf /etc/php/*/fpm/conf.d/99-horse.ini` | | same |

## Build it

1. A new VPS of the same size class as production, with its own domain, for example `staging.example.com`.
2. Install with the staging switch (it installs as `APP_ENV=staging` and allows play-money clients):

   ```
   PHP_V=8.5 ./laravel/bin/install-vps.sh --staging --domain staging.example.com --email you@example.com
   ```

   Use the same `PHP_V` as production. Add `--cloudflare` if the domain is proxied.
3. Create an operator login: `runuser -u www-data -- php artisan staff add-operator yourname --role=admin`.
4. Add test clients in `/admin` → Clients: type "mock wallet" for local tests, or the platform's **sandbox** wallet URL and secret for integration tests.
5. Check the installation: `curl -s https://staging.example.com/healthz` says `"ok":true`, and a race opens and settles in the game page.

## Test data

Start empty. If a test needs production-like volumes, load a **sanitised** copy, never a raw dump:

1. Restore the dump into the staging database **with the game stopped** (`systemctl stop horse-game`).
2. Before anything can run: disable every client (`UPDATE clients SET status = 'disabled';`), because their wallet and webhook URLs point at real platforms. The stored wallet secrets are encrypted with production's `HORSE_CLIENTS_KEY`, which staging does not have, so they cannot be used. That is intended.
3. Remove personal data of the operator's own players: `UPDATE players SET mobile = NULL, email = NULL, note = NULL;` and reset their passwords.
4. Re-create test clients as in step 4 above, then start the game.

## What to run on staging before every production deploy

1. `php artisan test` (install dev packages on the staging checkout with `composer install`), including `HorseBaselineTest`, which compares the horse race byte for byte with the recorded production behaviour. If it fails, the horse race changed.
2. The same suite against PostgreSQL (`DB_CONNECTION=pgsql` in the environment): production runs on PostgreSQL.
3. A smoke test by hand: `/healthz`, one full race with a bet and a win through the mock wallet, `/admin` login, `/metrics` with the controller key, and (if the own site is on) register, deposit, approve, play, withdraw.
4. Watch `horse-game` and the alerts for 30 minutes under a little load (a few browsers).
5. Follow [DEPLOY_CHECKLIST.md](DEPLOY_CHECKLIST.md) for the real deploy.
