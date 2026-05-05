#!/usr/bin/env bash
# Start the data-collection server in dev mode.
# Creates a default .env if missing and ensures node_modules is installed.

set -euo pipefail

cd "$(dirname "$0")/.."

if [[ ! -f .env ]]; then
  cp .env.template .env
  # Default to a development-friendly NODE_ENV so verbose logging kicks in.
  sed -i '' 's/^NODE_ENV=production/NODE_ENV=development/' .env || true
  echo "[dev] Created .env from .env.template"
fi

if [[ ! -d node_modules ]]; then
  echo "[dev] Installing dependencies..."
  npm install
fi

echo "[dev] Starting server (npm run dev)..."
exec npm run dev
