# Deploy checklist (backup, deploy, restore)

Use this for every production deploy. The app holds real money: player balances (own site), the hash-chained ledger and the queue of wallet calls still owed to platforms. Take the backup first, and know how to get back.

## Before the deploy

- [ ] The change has passed [STAGING.md](STAGING.md): full test suite green (including `HorseBaselineTest`) on SQLite and PostgreSQL, and the smoke test.
- [ ] Note what runs now: `git -C /var/www/html/horce-race log --oneline -1` (this is the commit or tag to roll back to).
- [ ] Choose a quiet moment, ideally right after a race has settled (results phase), so no bet is waiting on a wallet.
- [ ] **Back up the database** (as the `postgres` user, custom format, compressed):

  ```
  install -d -o postgres /var/backups/horse
  runuser -u postgres -- pg_dump -Fc -f /var/backups/horse/horserace-$(date +%F-%H%M).dump horserace
  ls -lh /var/backups/horse | tail -3          # not zero bytes; about the size of the last backup
  ```

- [ ] **Check the backup is readable:** `pg_restore --list /var/backups/horse/<file>.dump | head`.
- [ ] **Write down the ledger head** and state: `cd /var/www/html/horce-race/laravel && runuser -u www-data -- php artisan ledger verify` (must print `INTACT, head hash …`). Keep the head hash and the number of ledger lines (`select count(*) from ledger`). The ledger only grows, so after the deploy the chain must still verify and have at least that many lines.
- [ ] Record the counts to compare later: pending credits / rollbacks / webhooks (the overview in `/admin`, or `/metrics`), number of players, current race number.
- [ ] Copy the backup **off the server** (another machine or object storage). A backup on the same disk is not a backup.
- [ ] `.env` is backed up separately and securely. `HORSE_CLIENTS_KEY` especially: without it the clients' wallet secrets in a restored database cannot be read.
- [ ] Once a week (and after changing backup scripts) **prove a restore works** on a scratch database:

  ```
  runuser -u postgres -- createdb horserace_restore_test
  runuser -u postgres -- pg_restore -d horserace_restore_test /var/backups/horse/<file>.dump
  DB_DATABASE=horserace_restore_test runuser -u www-data -- php artisan ledger verify    # INTACT, same head hash as the backup
  runuser -u postgres -- psql horserace_restore_test -c "select count(*) from ledger"
  runuser -u postgres -- dropdb horserace_restore_test
  ```

## Deploy

1. `cd /var/www/html/horce-race && git fetch && git checkout <tag or commit>`
2. `cd laravel && composer install --no-dev --optimize-autoloader`
3. **Migrations first:** `runuser -u www-data -- php artisan migrate --force`. Migrations only add tables and columns, so the old code keeps working with the new database. If a migration fails, stop here (nothing else was changed) and fix it on staging.
4. `runuser -u www-data -- php artisan config:cache && runuser -u www-data -- php artisan route:cache`
5. Reload the code: `systemctl restart php8.5-fpm` (opcache does not look for changed files), then `systemctl restart horse-game` (it stops cleanly on SIGTERM; restart between races when you can).
6. If the browser files changed, purge Cloudflare's cache (addresses carry a version, so this is only a precaution).

## After the deploy (watch for 24 hours)

- [ ] `systemctl status horse-game` is `active (running)` and stays so; no restart loop.
- [ ] `curl -s https://your.domain/healthz` says `"ok":true`.
- [ ] A race opens, runs and settles; a bet and a win go through a test account.
- [ ] `php artisan ledger verify` says `INTACT`, and the ledger has at least as many lines as before the deploy.
- [ ] Pending credits, rollbacks and webhooks are at the usual level and not growing.
- [ ] Wallet failure rate and p95 per client are normal (overview in `/admin`).
- [ ] No alert in the console; the RTP z-score is inside its usual range.
- [ ] Platforms report nothing unusual (transaction ids, webhooks).

## Roll back

**Code problem, database fine (the normal case):** check out the previous tag, `composer install --no-dev -o`, `route:cache`, restart `php8.5-fpm` and `horse-game`. The database does not need to go back, because migrations only added things.

**Database problem (last resort):** a restore returns the database to the time of the backup, so every bet, win, deposit and withdrawal since then is lost from it. Platforms and players may already have seen them. Reconcile with each platform's wallet records afterwards.

1. Stop taking bets: `systemctl stop horse-game` and put the site in maintenance (`php artisan down`).
2. Restore into a **new** database first and check it: `pg_restore`, then `php artisan ledger verify` against it.
3. Switch the app to the restored database (`DB_DATABASE` in `.env`, `config:cache`), start `horse-game`, `php artisan up`.
4. Keep the damaged database untouched for investigation.
5. Tell the platforms the time range that was lost.

## Keep

Daily backups for 14 days, weekly for 8 weeks, and the backup taken before each deploy for 30 days.
