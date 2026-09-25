#!/usr/bin/env bash
# Runs the server locally with automatic restarts on file changes.
# Creates .env from the template on first use and installs dependencies.
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ ! -f .env ]]; then
  sed 's/^NODE_ENV=production/NODE_ENV=development/' .env.template > .env
  echo "[dev] Created .env from .env.template"
fi
if [[ ! -d node_modules ]]; then
  echo "[dev] Installing dependencies"
  npm install
fi

# Export the variables from .env for this process (comments and blanks skipped).
set -a
# shellcheck disable=SC1091
source <(grep -E '^[A-Z_]+=' .env)
set +a

echo "[dev] Starting on port ${PORT:-3000}; storage ${STORAGE_DIR:-./received}"
exec node --watch server.js
