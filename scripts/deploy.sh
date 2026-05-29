#!/usr/bin/env bash
# Deploy inkfellow: build + restart PM2, clearing any stale next-server processes first.
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PM2="node /home/admin/.npm/_npx/5f7878ce38f1eb13/node_modules/pm2/bin/pm2"

cd "$APP_DIR"

echo "==> Stopping inkfellow instances..."
$PM2 stop inkfellow inkfellow-wumin 2>/dev/null || true

echo "==> Killing any stale next-server processes on ports 3000/3001..."
for PORT in 3000 3001; do
  PID=$(ss -tlnp 2>/dev/null | grep ":${PORT} " | grep -oP 'pid=\K\d+' || true)
  if [ -n "$PID" ]; then
    echo "    killing PID $PID on port $PORT"
    kill "$PID" 2>/dev/null || true
  fi
done
sleep 1

echo "==> Enabling swap for build..."
sudo sysctl vm.swappiness=60 2>/dev/null || true

echo "==> Building..."
NEXT_TELEMETRY_DISABLED=1 npm run build

echo "==> Restoring swap setting..."
sudo sysctl vm.swappiness=0 2>/dev/null || true

echo "==> Starting inkfellow instances..."
$PM2 start ecosystem.config.cjs --only inkfellow,inkfellow-wumin

sleep 5

echo "==> Status:"
$PM2 list

echo "==> Done."
