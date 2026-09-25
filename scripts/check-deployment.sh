#!/usr/bin/env bash
# Checks a deployed server from anywhere, without storing anything on it:
# TLS and /health, the participant-code check (with a code that must be
# rejected), and 404 handling.
#
# Usage: scripts/check-deployment.sh https://wellbeing-mapper.example.org
set -euo pipefail

BASE="${1:?usage: check-deployment.sh https://your-host}"
BASE="${BASE%/}"
sha256() { if command -v sha256sum >/dev/null; then sha256sum | cut -c1-64; else shasum -a 256 | cut -c1-64; fi; }
fail() { echo "FAIL $*"; exit 1; }

health="$(curl -fsS --max-time 15 "$BASE/health")" || fail "GET $BASE/health (TLS or connectivity problem?)"
echo "$health" | grep -q '"status":"ok"' || fail "/health answered: $health"
echo "ok   /health: $health"

bogus="$(printf 'not-a-real-code-%s' "$RANDOM" | sha256)"
status="$(curl -sS --max-time 15 -o /tmp/wm-check-body -w '%{http_code}' -X POST "$BASE/api/v1/participants/validate" \
  -H 'content-type: application/json' -d "{\"hashed_code\":\"$bogus\"}")"
case "$status" in
  200) grep -q '"valid":false' /tmp/wm-check-body || fail "an unknown code was accepted"; echo "ok   participant codes loaded; unknown code rejected" ;;
  503) echo "WARN participant codes are not configured on the server (503); research mode cannot be unlocked" ;;
  *)   fail "validate answered HTTP $status: $(cat /tmp/wm-check-body)" ;;
esac

status="$(curl -sS --max-time 15 -o /dev/null -w '%{http_code}' "$BASE/no-such-path")"
[[ "$status" == 404 ]] || fail "unknown path answered HTTP $status"
echo "ok   404 for unknown paths"

echo "The app should be built with: --dart-define=SERVER_BASE_URL=$BASE/api/v1"
