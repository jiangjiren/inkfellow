#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR=${1:-"$(cd "$SCRIPT_DIR/.." && pwd)"}
# Override SERVICE_NAME if your systemd unit has a different name.
SERVICE_NAME=${SERVICE_NAME:-notes-app}

cd "$APP_DIR"

echo "Pulling latest code..."
git pull

echo "Installing deps..."
npm install

echo "Building..."
npm run build

echo "Restarting service..."
sudo systemctl restart "$SERVICE_NAME"

echo "Done."
