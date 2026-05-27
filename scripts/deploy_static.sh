#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 2 ]]; then
  echo "Usage: $0 <source_html> <dest_filename> [project_dir]" >&2
  exit 1
fi

SRC="$1"
DEST="$2"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="${3:-"$(cd "$SCRIPT_DIR/.." && pwd)"}"

PUBLIC_DIR="$PROJECT_DIR/public"
mkdir -p "$PUBLIC_DIR"

cp "$SRC" "$PUBLIC_DIR/$DEST"

cd "$PROJECT_DIR"

# Deploy with Vercel
if [[ -n "${VERCEL_URL_ALIAS:-}" ]]; then
  if [[ -n "${VERCEL_TOKEN:-}" ]]; then
    npx vercel --prod --yes --cwd "$PROJECT_DIR" --token "$VERCEL_TOKEN" | tee /tmp/vercel_deploy.log
  else
    npx vercel --prod --yes --cwd "$PROJECT_DIR" | tee /tmp/vercel_deploy.log
  fi
  npx vercel alias --yes "$(grep -oE 'https?://[^ ]+' /tmp/vercel_deploy.log | tail -1)" "$VERCEL_URL_ALIAS"
else
  if [[ -n "${VERCEL_TOKEN:-}" ]]; then
    npx vercel --prod --yes --cwd "$PROJECT_DIR" --token "$VERCEL_TOKEN"
  else
    npx vercel --prod --yes --cwd "$PROJECT_DIR"
  fi
fi
