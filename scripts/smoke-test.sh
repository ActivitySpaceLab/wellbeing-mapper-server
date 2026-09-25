#!/usr/bin/env bash
# Runs the server on a spare port and takes it through everything the app
# does, with real encryption: uploads (including a resubmission), a bad
# upload, participant-code checks, and, when python3 has the cryptography
# package, decryption of what was stored. Exits non-zero on any failure.
#
# Needs node >= 20 and openssl. Usage: scripts/smoke-test.sh [PORT]
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${1:-${PORT:-3001}}"
BASE="http://127.0.0.1:${PORT}"
WORK="$(mktemp -d -t wm-smoke-XXXXXX)"
trap 'cleanup' EXIT
cleanup() {
  if [[ -n "${SERVER_PID:-}" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  rm -rf "$WORK"
}
fail() { echo "[smoke] FAIL: $*"; echo "--- server log"; cat "$WORK/server.log"; exit 1; }
ok() { echo "[smoke] ok   $*"; }
sha256() { if command -v sha256sum >/dev/null; then sha256sum | cut -c1-64; else shasum -a 256 | cut -c1-64; fi; }
post() { curl -sS -o "$WORK/body" -w '%{http_code}' -X POST "$BASE$1" -H 'content-type: application/json' --data-binary "@$2"; }

[[ -d node_modules ]] || npm install >/dev/null

# A throwaway key pair: the "app" encrypts with the public key, the "research
# team" decrypts with the private key.
openssl genrsa -out "$WORK/private.pem" 2048 2>/dev/null
openssl rsa -in "$WORK/private.pem" -pubout -out "$WORK/public.pem" 2>/dev/null

# A participant-code file in the hash-only format the generator writes.
VALID_HASH="$(printf '%s' 'SMOKE' | sha256)"
printf '{"study_hashes":["%s"],"pilot_hashes":[],"test_hashes":[]}\n' "$VALID_HASH" > "$WORK/codes.json"

echo "[smoke] starting server on port $PORT"
PORT="$PORT" NODE_ENV=development TRUST_PROXY=false \
  STORAGE_DIR="$WORK/received" PARTICIPANT_CODES_FILE="$WORK/codes.json" \
  node server.js > "$WORK/server.log" 2>&1 &
SERVER_PID=$!
for _ in $(seq 1 50); do
  curl -fsS "$BASE/health" >/dev/null 2>&1 && break
  kill -0 "$SERVER_PID" 2>/dev/null || fail "server exited during startup"
  sleep 0.2
done

curl -fsS "$BASE/health" | grep -q '"status":"ok"' || fail "GET /health"
ok "GET /health"

node tools/encrypt_sample.js --public-key "$WORK/public.pem" --type initial --submission-id auto > "$WORK/initial.json"
[[ "$(post /api/v1/surveys/encrypted "$WORK/initial.json")" == 200 ]] || fail "initial survey upload: $(cat "$WORK/body")"
grep -q '"duplicate":false' "$WORK/body" || fail "first upload flagged as duplicate"
ok "POST /api/v1/surveys/encrypted (initial)"

[[ "$(post /api/v1/surveys/encrypted "$WORK/initial.json")" == 200 ]] || fail "resubmission"
grep -q '"duplicate":true' "$WORK/body" || fail "resubmission was stored again: $(cat "$WORK/body")"
ok "resubmission acknowledged as duplicate"

node tools/encrypt_sample.js --public-key "$WORK/public.pem" --type biweekly > "$WORK/biweekly.json"
[[ "$(post /api/v1/surveys/encrypted "$WORK/biweekly.json")" == 200 ]] || fail "biweekly survey upload"
ok "POST /api/v1/surveys/encrypted (biweekly)"

node tools/encrypt_sample.js --public-key "$WORK/public.pem" --type consent > "$WORK/consent.json"
[[ "$(post /api/v1/consent/encrypted "$WORK/consent.json")" == 200 ]] || fail "consent upload"
ok "POST /api/v1/consent/encrypted"

printf '{"encrypted_data":"not-a-package","survey_type":"initial"}' > "$WORK/bad.json"
[[ "$(post /api/v1/surveys/encrypted "$WORK/bad.json")" == 400 ]] || fail "garbage was accepted"
ok "garbage upload rejected (400)"

printf '{"hashed_code":"%s"}' "$VALID_HASH" > "$WORK/valid.json"
[[ "$(post /api/v1/participants/validate "$WORK/valid.json")" == 200 ]] || fail "validate (valid)"
grep -q '"valid":true' "$WORK/body" || fail "valid code rejected: $(cat "$WORK/body")"
ok "valid participant code accepted"

printf '{"hashed_code":"%s"}' "$(printf '%s' 'WRONG' | sha256)" > "$WORK/invalid.json"
[[ "$(post /api/v1/participants/validate "$WORK/invalid.json")" == 200 ]] || fail "validate (invalid)"
grep -q '"valid":false' "$WORK/body" || fail "invalid code accepted: $(cat "$WORK/body")"
ok "unknown participant code rejected"

[[ "$(ls "$WORK/received" | wc -l | tr -d ' ')" == 3 ]] || fail "expected 3 stored files, found: $(ls "$WORK/received")"
ok "3 submissions stored"

PYTHON="${PYTHON:-python3}"
if "$PYTHON" -c 'import cryptography' 2>/dev/null; then
  "$PYTHON" tools/decrypt_received.py --key "$WORK/private.pem" --out "$WORK/decrypted" "$WORK/received" 2> "$WORK/decrypt.log" \
    || fail "decryption: $(cat "$WORK/decrypt.log")"
  grep -q 'decrypted 3, failed 0' "$WORK/decrypt.log" || fail "decryption summary: $(cat "$WORK/decrypt.log")"
  grep -q 'encrypt_sample' "$WORK"/decrypted/*-survey-initial-*.decrypted.json || fail "decrypted payload is wrong"
  ok "all 3 submissions decrypt with the private key"
else
  echo "[smoke] skipped decryption ($PYTHON has no cryptography package)"
fi

echo "[smoke] all checks passed"
