#!/usr/bin/env bash
# Editums publishing server installer for Ubuntu 24.04.
# Run as root:  bash <(curl -fsSL https://editums.com/deploy/install.sh)
# If nginx already serves ports 80/443, Editums is added to it as one new site (api.editums.com);
# otherwise it brings its own Caddy web server.
set -euo pipefail
DIR=/opt/editums-publisher
DOMAIN=api.editums.com
PORT=8790
SRC=${EDITUMS_SRC:-https://editums.com/deploy/editums-server.tar.gz}

echo "==> Installing Docker (if needed)"
if ! command -v docker >/dev/null; then curl -fsSL https://get.docker.com | sh; fi

MODE=caddy
if ss -ltnp '( sport = :80 or sport = :443 )' | grep -q '"nginx"'; then MODE=nginx
elif ss -ltn '( sport = :80 or sport = :443 )' | grep -q LISTEN && ! docker ps --format '{{.Names}}' | grep -q editums; then
  echo "!! Something other than nginx is using port 80 or 443:"; ss -ltnp '( sport = :80 or sport = :443 )'
  echo "!! Send this to Claude, then run again."; exit 1
fi
if [ "$MODE" = nginx ] && ss -ltn "( sport = :$PORT )" | grep -q LISTEN && ! docker ps --format '{{.Names}}' | grep -q editums; then
  echo "!! Port $PORT is already in use. Send this to Claude."; exit 1
fi
echo "==> Web server mode: $MODE"

echo "==> Downloading the Editums server"
mkdir -p "$DIR" && cd "$DIR"
curl -fsSL "$SRC" | tar -xz

if [ ! -f .env ]; then
  cp .env.example .env
  sed -i "s/^TOKEN_KEY=.*/TOKEN_KEY=$(openssl rand -hex 32)/" .env
  echo
  echo "Paste your Espobase SECRET key (starts with eb_sk_). It won't show while you type, then press Enter:"
  read -rs SK </dev/tty; echo
  case "$SK" in eb_sk_*) ;; *) echo "!! That doesn't look like a secret key. Run this again."; rm -f .env; exit 1;; esac
  sed -i "s|^ESPO_SECRET_KEY=.*|ESPO_SECRET_KEY=$SK|" .env
  chmod 600 .env
fi

# AI keys (optional): asked once, press Enter to skip and add later by re-running this installer.
ask_key() { # name, label, prefix
  if ! grep -q "^$1=." .env; then
    echo; echo "Paste your $2 key (starts with $3), or just press Enter to skip:"
    read -rs V </dev/tty; echo
    if [ -n "$V" ]; then
      case "$V" in $3*) ;; *) echo "!! That doesn't look like a $2 key, skipped."; return;; esac
      grep -q "^$1=" .env && sed -i "s|^$1=.*|$1=$V|" .env || echo "$1=$V" >> .env
    fi
  fi
}
ask_key ANTHROPIC_API_KEY "Anthropic (Claude)" "sk-ant-"
ask_key FAL_KEY "fal.ai" ""
ask_key STRIPE_WEBHOOK_SECRET "Stripe webhook signing secret" "whsec_"
ask_key FACEBOOK_APP_ID "Facebook (Meta) app ID" ""
ask_key FACEBOOK_APP_SECRET "Facebook (Meta) app secret" ""

if [ "$MODE" = nginx ]; then
  cat > docker-compose.yml <<YML
name: editums-publisher
services:
  publisher:
    build: .
    restart: unless-stopped
    env_file: .env
    ports: ["127.0.0.1:$PORT:8080"]
    volumes: ["./media:/data/media"]
YML
  mkdir -p media && chown 1000:1000 media
  echo "==> Starting the Editums server"
  docker compose up -d --build

  echo "==> Adding $DOMAIN to nginx"
  if [ -d /etc/nginx/sites-available ]; then CONF=/etc/nginx/sites-available/$DOMAIN; LINK=/etc/nginx/sites-enabled/$DOMAIN; else CONF=/etc/nginx/conf.d/$DOMAIN.conf; LINK=; fi
  if [ ! -f "$CONF" ]; then
    cat > "$CONF" <<NGX
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;
    location / {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        client_max_body_size 600m;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }
}
NGX
    [ -n "$LINK" ] && ln -sf "$CONF" "$LINK"
    if ! nginx -t; then echo "!! nginx rejected the new site, so it was removed. Nothing else changed."; rm -f "$CONF" ${LINK:+"$LINK"}; exit 1; fi
    systemctl reload nginx
  elif ! grep -q 'client_max_body_size 600m' "$CONF"; then
    # Allow video uploads for clipping (up to 500 MB).
    cp "$CONF" "$CONF.bak"
    sed -i -E 's/client_max_body_size [0-9]+m;/client_max_body_size 600m;\n        proxy_read_timeout 300s;\n        proxy_send_timeout 300s;/' "$CONF"
    if nginx -t; then rm -f "$CONF.bak"; systemctl reload nginx; else mv "$CONF.bak" "$CONF"; fi
  fi

  echo "==> Getting the HTTPS certificate"
  if ! command -v certbot >/dev/null; then apt-get update -qq && apt-get install -y -qq certbot python3-certbot-nginx; fi
  if ! certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m editums@helpone.tech --redirect; then
    echo "!! The certificate failed, usually because DNS for $DOMAIN isn't pointing here yet."
    echo "!! Wait 15 minutes, then run:  certbot --nginx -d $DOMAIN --redirect"
  fi
else
  if command -v ufw >/dev/null && ufw status | grep -q active; then ufw allow 80/tcp; ufw allow 443/tcp; fi
  mkdir -p media && chown 1000:1000 media
  echo "==> Starting"
  docker compose up -d --build
fi

sleep 5
if curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 || curl -fsS -k "https://$DOMAIN/health" >/dev/null 2>&1; then
  echo; echo "Done. Open https://$DOMAIN/health in your browser."
else
  echo "!! The server didn't answer. Send Claude the output of: cd $DIR && docker compose logs --tail 50"
fi
