#!/usr/bin/env bash
#
# Installs and configures the horse race Laravel app on a fresh Ubuntu 24.04 VPS:
# nginx, PHP 8.4 (ondrej PPA), PostgreSQL, Redis, Composer, the app, the round-loop daemon, cron, firewall, HTTPS.
#
# Run it as root from inside a copy of the project (the script lives in laravel/bin):
#
#   sudo ./bin/install-vps.sh --domain race.example.com --email you@example.com --operator-ip 203.0.113.7
#
# Options (or the same names as environment variables):
#   --domain D        host name that already points to this server (without it: plain HTTP on the IP, no certificate)
#   --email E         e-mail for Let's Encrypt
#   --operator-ip IP  IP (or CIDR) allowed to open /controller, /admin, /metrics and the operator API; repeat for several
#   --mode live|demo  live = real wallets of your clients (default); demo = play-money wallet
#   --app-dir DIR     install location (default /var/www/horse)
#   --repo URL        clone this git repository instead of using the copy the script runs from
#   --branch B        branch to clone with --repo
#   --no-firewall     do not touch ufw
#   PHP_V=8.5 sudo -E ./bin/install-vps.sh ...   uses another PHP version (default 8.4)
#
# Safe to run again: it keeps the existing .env keys and the database password, updates the code and restarts the services.
set -euo pipefail

DOMAIN="${DOMAIN:-}"; EMAIL="${EMAIL:-}"; MODE="${MODE:-live}"; APP_DIR="${APP_DIR:-/var/www/horse}"
REPO="${REPO:-}"; BRANCH="${BRANCH:-}"; FIREWALL=1; OPERATOR_IPS=()
PHP_V="${PHP_V:-8.4}"; DB_NAME=horserace; DB_USER=horse

while [ $# -gt 0 ]; do
  case "$1" in
    --domain) DOMAIN="$2"; shift 2;;
    --email) EMAIL="$2"; shift 2;;
    --operator-ip) OPERATOR_IPS+=("$2"); shift 2;;
    --mode) MODE="$2"; shift 2;;
    --app-dir) APP_DIR="$2"; shift 2;;
    --repo) REPO="$2"; shift 2;;
    --branch) BRANCH="$2"; shift 2;;
    --no-firewall) FIREWALL=0; shift;;
    -h|--help) sed -n '2,22p' "$0"; exit 0;;
    *) echo "unknown option: $1" >&2; exit 2;;
  esac
done

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
die() { echo "Error: $*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run as root (sudo ./bin/install-vps.sh ...)"
. /etc/os-release
[ "${ID:-}" = ubuntu ] || die "this script is for Ubuntu (24.04 recommended); found ${ID:-unknown}"
case "$MODE" in live|demo) ;; *) die "--mode must be live or demo";; esac
[ -z "$DOMAIN" ] || [ -n "$EMAIL" ] || die "--email is needed with --domain (Let's Encrypt)"
if [ ${#OPERATOR_IPS[@]} -eq 0 ]; then
  # default: the address you are connected from over SSH, so the operator pages are never open to the world
  [ -n "${SSH_CLIENT:-}" ] && OPERATOR_IPS+=("${SSH_CLIENT%% *}")
fi
[ ${#OPERATOR_IPS[@]} -gt 0 ] || die "give at least one --operator-ip (the operator pages are restricted to it)"

# ---------- where the code comes from ----------
if [ -n "$REPO" ]; then
  SRC="$(mktemp -d)"; apt-get update -qq; apt-get install -y -qq git >/dev/null
  git clone --depth 1 ${BRANCH:+-b "$BRANCH"} "$REPO" "$SRC/r"
  SRC="$SRC/r/laravel"
else
  SRC="$(cd "$(dirname "$0")/.." && pwd)"
fi
[ -f "$SRC/artisan" ] || die "no Laravel app found at $SRC (run the script from the project, or use --repo)"

# ---------- packages ----------
say "Installing packages (nginx, PHP $PHP_V, PostgreSQL, Redis)"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq software-properties-common curl unzip ca-certificates rsync openssl ufw cron >/dev/null
if ! ls /etc/apt/sources.list.d 2>/dev/null | grep -qi ondrej; then add-apt-repository -y ppa:ondrej/php >/dev/null; apt-get update -qq; fi
apt-get install -y -qq nginx postgresql redis-server \
  "php$PHP_V-fpm" "php$PHP_V-cli" "php$PHP_V-pgsql" "php$PHP_V-mbstring" "php$PHP_V-curl" "php$PHP_V-xml" "php$PHP_V-zip" \
  "php$PHP_V-bcmath" "php$PHP_V-intl" "php$PHP_V-redis" "php$PHP_V-opcache" >/dev/null
update-alternatives --set php "/usr/bin/php$PHP_V" >/dev/null 2>&1 || true
php -r 'exit(PHP_VERSION_ID >= 80300 ? 0 : 1);' || die "the php command is older than 8.3"
php -m | grep -qi pdo_pgsql || die "pdo_pgsql is not loaded"
systemctl enable --now postgresql redis-server nginx "php$PHP_V-fpm" >/dev/null 2>&1

if ! command -v composer >/dev/null; then
  say "Installing Composer"
  EXPECTED="$(curl -fsS https://composer.github.io/installer.sig)"
  php -r "copy('https://getcomposer.org/installer', '/tmp/composer-setup.php');"
  [ "$EXPECTED" = "$(php -r "echo hash_file('sha384', '/tmp/composer-setup.php');")" ] || die "Composer installer checksum mismatch"
  php /tmp/composer-setup.php --quiet --install-dir=/usr/local/bin --filename=composer; rm -f /tmp/composer-setup.php
fi

# ---------- the app ----------
say "Copying the app to $APP_DIR"
mkdir -p "$APP_DIR"
rsync -a --delete --exclude '.env' --exclude 'storage/' --exclude 'vendor/' --exclude 'node_modules/' --exclude '.git/' --exclude 'bootstrap/cache/*.php' "$SRC"/ "$APP_DIR"/
mkdir -p "$APP_DIR"/storage/{app,framework/{cache,sessions,views},logs} "$APP_DIR"/bootstrap/cache
cd "$APP_DIR"
COMPOSER_ALLOW_SUPERUSER=1 composer install --no-dev --optimize-autoloader --no-interaction --quiet

# ---------- .env ----------
say "Writing .env"
[ -f .env ] || cp .env.example .env
envget() { grep -E "^$1=" .env | tail -1 | cut -d= -f2- | sed -e 's/[[:space:]]*#.*$//' -e 's/^"//' -e 's/"$//' || true; }
envset() {   # replace "KEY=" or "# KEY=" or append
  local k="$1" v="$2" esc; esc=$(printf '%s' "$v" | sed -e 's/[\/&|]/\\&/g')
  if grep -qE "^#? ?$k=" .env; then sed -i -E "0,/^#? ?$k=.*/s||$k=$esc|" .env; else printf '%s=%s\n' "$k" "$v" >> .env; fi
}
keep() { local cur; cur="$(envget "$1")"; [ -n "$cur" ] && [ "$cur" != null ] && printf '%s' "$cur" || openssl rand -hex 32; }

DB_PASS="$(envget DB_PASSWORD)"; [ -n "$DB_PASS" ] || DB_PASS="$(openssl rand -hex 20)"
CONTROLLER_KEY="$(keep HORSE_CONTROLLER_KEY)"; CLIENTS_KEY="$(keep HORSE_CLIENTS_KEY)"
if [ -n "$DOMAIN" ]; then URL="https://$DOMAIN"; else URL="http://$(curl -fsS https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')"; fi

envset APP_NAME '"Horse Race"'; envset APP_ENV production; envset APP_DEBUG false; envset APP_URL "$URL"
envset LOG_LEVEL warning
envset DB_CONNECTION pgsql; envset DB_HOST 127.0.0.1; envset DB_PORT 5432; envset DB_DATABASE "$DB_NAME"; envset DB_USERNAME "$DB_USER"; envset DB_PASSWORD "$DB_PASS"
envset SESSION_DRIVER database; envset QUEUE_CONNECTION database
envset CACHE_STORE redis; envset REDIS_CLIENT phpredis; envset REDIS_HOST 127.0.0.1; envset REDIS_PORT 6379
envset HORSE_CONTROLLER_KEY "$CONTROLLER_KEY"; envset HORSE_CLIENTS_KEY "$CLIENTS_KEY"
envset HORSE_COOKIE_SECURE "$([ -n "$DOMAIN" ] && echo true || echo false)"; envset HORSE_TRUST_PROXY true
if [ "$MODE" = demo ]; then envset HORSE_WALLET mock; envset HORSE_ALLOW_MOCK_WALLET true; else envset HORSE_WALLET none; fi
if ! grep -qE '^APP_KEY=.+' .env; then php artisan key:generate --force --quiet; fi

# ---------- PostgreSQL ----------
say "Preparing PostgreSQL ($DB_NAME / $DB_USER)"
if runuser -u postgres -- psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='$DB_USER'" | grep -q 1; then
  runuser -u postgres -- psql -qc "ALTER ROLE $DB_USER WITH PASSWORD '$DB_PASS'"
else
  runuser -u postgres -- psql -qc "CREATE ROLE $DB_USER LOGIN PASSWORD '$DB_PASS'"
fi
runuser -u postgres -- psql -tAc "SELECT 1 FROM pg_database WHERE datname='$DB_NAME'" | grep -q 1 || runuser -u postgres -- createdb -O "$DB_USER" "$DB_NAME"

# ---------- permissions, migrate, caches ----------
chown -R www-data:www-data "$APP_DIR"; chmod 640 .env
as_www() { runuser -u www-data -- env HOME=/var/www "$@"; }
say "Migrating the database"
as_www php artisan migrate --force
as_www php artisan config:cache; as_www php artisan route:cache; as_www php artisan view:cache >/dev/null 2>&1 || true

# ---------- PHP-FPM / opcache ----------
say "Tuning PHP"
cat > "/etc/php/$PHP_V/fpm/conf.d/99-horse.ini" <<'INI'
opcache.enable=1
opcache.memory_consumption=128
opcache.validate_timestamps=0
expose_php=0
INI
POOL="/etc/php/$PHP_V/fpm/pool.d/www.conf"
sed -i -E 's/^;?pm\.max_children *=.*/pm.max_children = 20/; s/^;?pm\.start_servers *=.*/pm.start_servers = 4/; s/^;?pm\.min_spare_servers *=.*/pm.min_spare_servers = 2/; s/^;?pm\.max_spare_servers *=.*/pm.max_spare_servers = 8/' "$POOL"
cp "/etc/php/$PHP_V/fpm/conf.d/99-horse.ini" "/etc/php/$PHP_V/cli/conf.d/99-horse.ini"
sed -i '/opcache.validate_timestamps/d' "/etc/php/$PHP_V/cli/conf.d/99-horse.ini"

# ---------- nginx ----------
say "Configuring nginx"
cat > /etc/nginx/conf.d/horse-limits.conf <<'NGX'
limit_req_zone $binary_remote_addr zone=hr_api:10m rate=20r/s;
limit_req_zone $binary_remote_addr zone=hr_login:10m rate=5r/m;
NGX
ALLOW=""; for ip in "${OPERATOR_IPS[@]}"; do ALLOW="$ALLOW    allow $ip;"$'\n'; done
cat > /etc/nginx/sites-available/horse <<NGX
server {
  listen 80;
  listen [::]:80;
  server_name ${DOMAIN:-_};
  root $APP_DIR/public;
  index index.php;
  client_max_body_size 1m;

  add_header Strict-Transport-Security "max-age=31536000" always;
  add_header Referrer-Policy "no-referrer" always;
  add_header X-Content-Type-Options "nosniff" always;

  # operator pages and API: only from the listed IPs
  location ~ ^/(controller|admin|metrics|api/admin|api/report|api/command|api/clients) {
${ALLOW}    deny all;
    try_files \$uri /index.php?\$query_string;
  }
  location /bo/api/login { limit_req zone=hr_login burst=5 nodelay; try_files \$uri /index.php?\$query_string; }
  location /api/ { limit_req zone=hr_api burst=40 nodelay; try_files \$uri /index.php?\$query_string; }
  location / { try_files \$uri /index.php?\$query_string; }

  location ~ \.php\$ {
    include fastcgi_params;
    fastcgi_pass unix:/run/php/php$PHP_V-fpm.sock;
    fastcgi_param SCRIPT_FILENAME \$realpath_root\$fastcgi_script_name;
    fastcgi_read_timeout 30s;
  }
  location ~ /\.(?!well-known) { deny all; }
}
NGX
ln -sf /etc/nginx/sites-available/horse /etc/nginx/sites-enabled/horse
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx

# ---------- the round loop (systemd) and the scheduler (cron) ----------
say "Installing the round-loop service and the scheduler"
cat > /etc/systemd/system/horse-game.service <<UNIT
[Unit]
Description=Horse race round loop (php artisan game:run)
After=network.target postgresql.service redis-server.service
[Service]
User=www-data
WorkingDirectory=$APP_DIR
ExecStart=/usr/bin/php$PHP_V artisan game:run
Restart=always
RestartSec=2
KillSignal=SIGTERM
TimeoutStopSec=30
[Install]
WantedBy=multi-user.target
UNIT
echo "* * * * * www-data cd $APP_DIR && /usr/bin/php$PHP_V artisan schedule:run >/dev/null 2>&1" > /etc/cron.d/horse
chmod 644 /etc/cron.d/horse
systemctl daemon-reload
systemctl enable horse-game >/dev/null 2>&1
systemctl restart "php$PHP_V-fpm" horse-game

# ---------- firewall ----------
if [ "$FIREWALL" -eq 1 ]; then
  say "Firewall"
  ufw allow OpenSSH >/dev/null; ufw allow 'Nginx Full' >/dev/null; ufw --force enable >/dev/null
fi

# ---------- HTTPS ----------
if [ -n "$DOMAIN" ]; then
  say "Certificate for $DOMAIN"
  apt-get install -y -qq certbot python3-certbot-nginx >/dev/null
  if certbot --nginx -d "$DOMAIN" -m "$EMAIL" --agree-tos --no-eff-email --redirect --non-interactive; then
    systemctl reload nginx
  else
    echo "Certbot failed (does $DOMAIN point to this server, and are ports 80/443 open?). The site works over HTTP; run later:"
    echo "  certbot --nginx -d $DOMAIN -m $EMAIL --agree-tos --redirect"
  fi
fi

# ---------- check ----------
say "Checking"
sleep 2
systemctl is-active --quiet horse-game && echo "round loop: running" || echo "round loop: NOT running (journalctl -u horse-game)"
curl -fsS -o /dev/null -w "healthz: HTTP %{http_code}\n" http://127.0.0.1/healthz -H "Host: ${DOMAIN:-localhost}" || echo "healthz: not answering"

cat <<DONE

Done. Site: $URL
Mode:      $MODE
App:       $APP_DIR
Operator pages ($URL/controller, /admin, /metrics) only open from: ${OPERATOR_IPS[*]}

Controller key (X-Controller-Key):  $CONTROLLER_KEY
Clients key (HORSE_CLIENTS_KEY):    saved in $APP_DIR/.env  -> back it up somewhere safe, outside this server;
                                    if it is lost the clients' wallet secrets cannot be decrypted.

Next:
  cd $APP_DIR && runuser -u www-data -- php artisan staff add-operator <name>     # login for /admin
  runuser -u www-data -- php artisan clients ...                                   # add a platform client (see docs/DEPLOYMENT.md)
  journalctl -u horse-game -f                                                # round loop log
After changing .env:  runuser -u www-data -- php artisan config:cache && systemctl restart horse-game
After updating code:  run this script again (it keeps your keys), or see docs/DEPLOYMENT.md.
DONE
