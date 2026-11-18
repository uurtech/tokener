#!/usr/bin/env bash
# One-command tokener install on a fresh Linux server (Ubuntu/Debian/Amazon Linux/RHEL-family).
#
#   curl -fsSL https://raw.githubusercontent.com/uurtech/tokener/master/deploy/install.sh | sudo bash -s -- claude-gw.example.com
#
# Point the domain's DNS A record at this server first (ports 80 and 443 open). Without a domain, pass ":80"
# for a plain-HTTP proof of concept. Re-running is safe: existing secrets in /opt/tokener/.env are kept and
# the containers are updated to the latest image.
set -euo pipefail

# Everything runs inside main(), called on the last line: with `curl | bash` bash reads the script from stdin,
# so the whole file must be parsed before any command (docker in particular) can touch stdin.
main() {
DOMAIN="${1:-${DOMAIN:-}}"
DIR="${TOKENER_DIR:-/opt/tokener}"
RAW="${TOKENER_RAW:-https://raw.githubusercontent.com/uurtech/tokener/master/deploy}"

if [[ -z "$DOMAIN" ]]; then
  echo "usage: install.sh <domain | :80>" >&2
  exit 1
fi
if [[ $EUID -ne 0 ]]; then
  echo "run as root (sudo)" >&2
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "==> installing Docker"
  if command -v dnf >/dev/null 2>&1 && grep -qi "amazon linux" /etc/os-release; then
    dnf install -y docker
    mkdir -p /usr/local/lib/docker/cli-plugins
    curl -fsSL "https://github.com/docker/compose/releases/download/v2.29.7/docker-compose-linux-$(uname -m)" -o /usr/local/lib/docker/cli-plugins/docker-compose
    chmod +x /usr/local/lib/docker/cli-plugins/docker-compose
  else
    curl -fsSL https://get.docker.com | sh
  fi
  systemctl enable --now docker
fi
docker compose version >/dev/null

mkdir -p "$DIR"
cd "$DIR"
echo "==> fetching compose files into $DIR"
curl -fsSL "$RAW/docker-compose.yml" -o docker-compose.yml
curl -fsSL "$RAW/Caddyfile" -o Caddyfile

rand() { head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'; }
if [[ ! -f .env ]]; then
  curl -fsSL "$RAW/.env.example" -o .env
  sed -i "s|^DOMAIN=.*|DOMAIN=$DOMAIN|; s|^ADMIN_TOKEN=.*|ADMIN_TOKEN=$(rand)|; s|^KEY_POOL_SECRET=.*|KEY_POOL_SECRET=$(rand)|" .env
  chmod 600 .env
else
  sed -i "s|^DOMAIN=.*|DOMAIN=$DOMAIN|" .env
fi

echo "==> starting tokener"
docker compose pull </dev/null
docker compose up -d </dev/null

ADMIN_TOKEN="$(grep '^ADMIN_TOKEN=' .env | cut -d= -f2-)"
if [[ "$DOMAIN" == :* ]]; then BASE="http://$(curl -fsS https://checkip.amazonaws.com 2>/dev/null || hostname -I | awk '{print $1}')${DOMAIN#:80}"; else BASE="https://$DOMAIN"; fi

for _ in $(seq 1 30); do
  if docker compose exec -T tokener wget -qO- http://127.0.0.1:8080/health </dev/null >/dev/null 2>&1; then break; fi
  sleep 2
done

cat <<EOF

  tokener is running.

  Gateway URL : $BASE
  Admin       : $BASE/admin/#token=$ADMIN_TOKEN
  Secrets     : $DIR/.env  (keep it; KEY_POOL_SECRET decrypts your stored keys)

  Next: open the admin console → Keys → add your Anthropic / Bedrock API keys,
        then Developers → create a developer and send them the settings.json snippet.
  Update later: cd $DIR && docker compose pull && docker compose up -d
EOF
}

main "$@"
