#!/usr/bin/env bash
# End-to-end smoke test: boot the server in the background, hit each endpoint
# the app uses, and shut it down. Exits non-zero on any failure.

set -euo pipefail

cd "$(dirname "$0")/.."

PORT="${PORT:-3001}"   # Use 3001 to avoid colliding with a running dev server.
BASE="http://localhost:${PORT}"
LOG_FILE="$(mktemp -t dcs-smoke-XXXXXX.log)"

if [[ ! -d node_modules ]]; then
  npm install >/dev/null
fi

# Provide a tiny participant_codes.json so /participants/validate exercises
# both an accepted and rejected code path. The hash uses the same algorithm
# as server.js (SHA-256 of the raw code).
TMP_CODES="$(mktemp -t dcs-smoke-codes-XXXXXX).json"
cat > "${TMP_CODES}" <<'EOF'
{
  "pilot_codes": [],
  "study_codes": ["SMOKE-VALID-CODE"],
  "test_codes": []
}
EOF
VALID_HASH="$(printf '%s' 'SMOKE-VALID-CODE' | shasum -a 256 | awk '{print $1}')"
INVALID_HASH="$(printf '%s' 'SMOKE-WRONG-CODE' | shasum -a 256 | awk '{print $1}')"

echo "[smoke] Starting server on :${PORT} (logs: ${LOG_FILE})"
PORT="${PORT}" NODE_ENV=development \
  STORAGE_DIR="$(mktemp -d -t dcs-smoke-storage-XXXXXX)" \
  PARTICIPANT_CODES_FILE="${TMP_CODES}" \
  node server.js >"${LOG_FILE}" 2>&1 &
SERVER_PID=$!

cleanup() {
  if kill -0 "${SERVER_PID}" 2>/dev/null; then
    kill "${SERVER_PID}" 2>/dev/null || true
    wait "${SERVER_PID}" 2>/dev/null || true
  fi
}
trap cleanup EXIT

# Wait for /health to come up.
for i in {1..30}; do
  if curl -fsS "${BASE}/health" >/dev/null 2>&1; then
    break
  fi
  sleep 0.2
  if ! kill -0 "${SERVER_PID}" 2>/dev/null; then
    echo "[smoke] Server died before becoming ready. Log:"
    cat "${LOG_FILE}"
    exit 1
  fi
done

fail() { echo "[smoke] FAIL: $*"; cat "${LOG_FILE}"; exit 1; }
ok()   { echo "[smoke] OK:   $*"; }

# 1) /health
curl -fsS "${BASE}/health" | grep -q '"status"' || fail "/health"
ok "/health"

# 2) Encrypted survey upload
curl -fsS -X POST "${BASE}/api/v1/surveys/encrypted" \
  -H 'Content-Type: application/json' \
  -d '{"encrypted_data":"SMOKE_SURVEY","survey_type":"initial","timestamp":"2026-01-01T00:00:00Z"}' \
  >/dev/null || fail "POST /api/v1/surveys/encrypted"
ok "POST /api/v1/surveys/encrypted"

# 3) Encrypted consent upload
curl -fsS -X POST "${BASE}/api/v1/consent/encrypted" \
  -H 'Content-Type: application/json' \
  -d '{"encrypted_data":"SMOKE_CONSENT","timestamp":"2026-01-01T00:00:00Z"}' \
  >/dev/null || fail "POST /api/v1/consent/encrypted"
ok "POST /api/v1/consent/encrypted"

# 4) Encrypted location upload
curl -fsS -X POST "${BASE}/api/v1/locations/encrypted" \
  -H 'Content-Type: application/json' \
  -d '{"encrypted_data":"SMOKE_LOCATION","timestamp":"2026-01-01T00:00:00Z"}' \
  >/dev/null || fail "POST /api/v1/locations/encrypted"
ok "POST /api/v1/locations/encrypted"

# 5) Participant validation: valid code should return valid:true.
RESP="$(curl -fsS -X POST "${BASE}/api/v1/participants/validate" \
  -H 'Content-Type: application/json' \
  -d "{\"hashed_code\":\"${VALID_HASH}\",\"timestamp\":\"2026-01-01T00:00:00Z\"}")" \
  || fail "POST /api/v1/participants/validate (valid)"
echo "${RESP}" | grep -q '"valid":true' \
  || fail "valid hash was rejected: ${RESP}"
ok "POST /api/v1/participants/validate (valid hash accepted)"

# 6) Participant validation: bogus code should return valid:false.
RESP="$(curl -fsS -X POST "${BASE}/api/v1/participants/validate" \
  -H 'Content-Type: application/json' \
  -d "{\"hashed_code\":\"${INVALID_HASH}\",\"timestamp\":\"2026-01-01T00:00:00Z\"}")" \
  || fail "POST /api/v1/participants/validate (invalid)"
echo "${RESP}" | grep -q '"valid":false' \
  || fail "invalid hash was accepted: ${RESP}"
ok "POST /api/v1/participants/validate (invalid hash rejected)"

echo "[smoke] All endpoints responded successfully."
