#!/usr/bin/env bash
# Deploy inkfellow: build + restart PM2, clearing any stale next-server processes first.
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PM2="$(which pm2 2>/dev/null || echo npx pm2)"

cd "$APP_DIR"

echo "==> Stopping all PM2 instances..."
$PM2 stop all 2>/dev/null || true

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
NODE_OPTIONS="--max-old-space-size=1024" NEXT_TELEMETRY_DISABLED=1 npm run build

echo "==> Restoring swap setting..."
sudo sysctl vm.swappiness=0 2>/dev/null || true

echo "==> Starting all PM2 instances..."
$PM2 start ecosystem.config.cjs

sleep 5

echo "==> Status:"
$PM2 list

echo "==> Done."
