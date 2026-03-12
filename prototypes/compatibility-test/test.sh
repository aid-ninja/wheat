#!/usr/bin/env bash
# Compatibility test: verify single-session backwards-compat after multi-session refactor
# Runs against a live server on localhost:9090

set -euo pipefail

BASE="http://localhost:9090"
TOKEN="1f1ed1813c2e78286a69eb8b1ceac574"
PASS=0
FAIL=0
TESTS=()

pass() { PASS=$((PASS+1)); TESTS+=("PASS: $1"); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL+1)); TESTS+=("FAIL: $1 -- $2"); echo "  FAIL: $1 -- $2"; }

echo "=== Compatibility Test Suite ==="
echo "Target: $BASE"
echo ""

# --- Test 1: Token-in-URL auth (initial login) ---
echo "[1] Token-in-URL auth returns 302 redirect with Set-Cookie"
RESP=$(curl -s -o /dev/null -w "%{http_code}|%{redirect_url}" -D - "$BASE/?token=$TOKEN" 2>/dev/null)
HTTP_CODE=$(echo "$RESP" | head -1 | grep -oE '[0-9]{3}')
SET_COOKIE=$(echo "$RESP" | grep -i 'Set-Cookie' || true)
if [[ "$HTTP_CODE" == "302" ]] && [[ "$SET_COOKIE" == *"farmer_token="* ]]; then
  pass "Token-in-URL returns 302 + Set-Cookie"
else
  fail "Token-in-URL auth" "Got HTTP $HTTP_CODE, Set-Cookie: $SET_COOKIE"
fi

# Extract cookie for subsequent requests
COOKIE="farmer_token=$TOKEN"

# --- Test 2: Dashboard renders with cookie auth ---
echo "[2] Dashboard renders with cookie auth (no token in URL)"
DASH_CODE=$(curl -s -o /dev/null -w "%{http_code}" -b "$COOKIE" "$BASE/")
DASH_BODY=$(curl -s -b "$COOKIE" "$BASE/" | head -5)
if [[ "$DASH_CODE" == "200" ]] && [[ "$DASH_BODY" == *"<!DOCTYPE"* || "$DASH_BODY" == *"<html"* ]]; then
  pass "Dashboard renders with cookie auth"
else
  fail "Dashboard render" "HTTP $DASH_CODE"
fi

# --- Test 3: /api/state works with cookie auth ---
echo "[3] /api/state returns valid JSON with session data"
STATE=$(curl -s -b "$COOKIE" "$BASE/api/state")
HAS_SESSIONS=$(echo "$STATE" | python3 -c "import sys,json; d=json.load(sys.stdin); print('yes' if 'sessions' in d else 'no')" 2>/dev/null || echo "parse-error")
HAS_PENDING=$(echo "$STATE" | python3 -c "import sys,json; d=json.load(sys.stdin); print('yes' if 'pending' in d else 'no')" 2>/dev/null || echo "parse-error")
if [[ "$HAS_SESSIONS" == "yes" ]] && [[ "$HAS_PENDING" == "yes" ]]; then
  pass "/api/state returns sessions + pending"
else
  fail "/api/state" "sessions=$HAS_SESSIONS, pending=$HAS_PENDING"
fi

# --- Test 4: Hook with no session_id falls back to 'default' ---
echo "[4] Hook without session_id creates 'default' session"
curl -s -X POST "$BASE/hooks/activity" \
  -H "Content-Type: application/json" \
  -d '{"tool_name":"Read","tool_input":{"file_path":"/tmp/test"},"hook_event_name":"PostToolUse"}' \
  > /dev/null

# Check that 'default' session exists now
STATE2=$(curl -s -b "$COOKIE" "$BASE/api/state")
DEFAULT_EXISTS=$(echo "$STATE2" | python3 -c "
import sys, json
d = json.load(sys.stdin)
sessions = d.get('sessions', [])
print('yes' if any(s['id'] == 'default' for s in sessions) else 'no')
" 2>/dev/null || echo "parse-error")
if [[ "$DEFAULT_EXISTS" == "yes" ]]; then
  pass "No session_id falls back to 'default' session"
else
  fail "Default session fallback" "default session not found in sessions list"
fi

# --- Test 5: Hook with explicit session_id creates named session ---
echo "[5] Hook with session_id creates named session"
curl -s -X POST "$BASE/hooks/activity" \
  -H "Content-Type: application/json" \
  -d '{"session_id":"test-compat-123","tool_name":"Glob","tool_input":{"pattern":"*.md"},"hook_event_name":"PostToolUse","cwd":"/tmp/compat-test"}' \
  > /dev/null

STATE3=$(curl -s -b "$COOKIE" "$BASE/api/state")
NAMED_EXISTS=$(echo "$STATE3" | python3 -c "
import sys, json
d = json.load(sys.stdin)
sessions = d.get('sessions', [])
print('yes' if any(s['id'] == 'test-compat-123' for s in sessions) else 'no')
" 2>/dev/null || echo "parse-error")
if [[ "$NAMED_EXISTS" == "yes" ]]; then
  pass "Named session_id creates distinct session"
else
  fail "Named session" "test-compat-123 not found in sessions"
fi

# --- Test 6: Claims data available (--claims flag working) ---
echo "[6] Claims data served (--claims flag)"
HAS_CLAIMS=$(echo "$STATE2" | python3 -c "
import sys, json
d = json.load(sys.stdin)
c = d.get('claims')
print('yes' if c and 'claims' in c else 'no')
" 2>/dev/null || echo "parse-error")
if [[ "$HAS_CLAIMS" == "yes" ]]; then
  pass "Claims data served via --claims flag"
else
  fail "Claims data" "claims not found in /api/state"
fi

# --- Test 7: Trust level change without session_id (global) ---
echo "[7] Trust level change without session_id applies globally"
TRUST_RESP=$(curl -s -X POST -b "$COOKIE" "$BASE/api/trust-level" \
  -H "Content-Type: application/json" \
  -d '{"level":"standard"}')
TRUST_OK=$(echo "$TRUST_RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print('yes' if d.get('ok') else 'no')" 2>/dev/null || echo "parse-error")
if [[ "$TRUST_OK" == "yes" ]]; then
  pass "Global trust level change works"
else
  fail "Trust level" "$TRUST_RESP"
fi

# Reset trust to paranoid
curl -s -X POST -b "$COOKIE" "$BASE/api/trust-level" \
  -H "Content-Type: application/json" \
  -d '{"level":"paranoid"}' > /dev/null

# --- Test 8: SSE /events endpoint with token auth ---
echo "[8] SSE /events endpoint accepts connection and returns event-stream"
# SSE with curl is tricky due to buffering; test that the endpoint returns 200 with correct Content-Type
SSE_HEADERS=$(curl -s -o /dev/null -w "%{http_code}|%{content_type}" --max-time 2 "$BASE/events?token=$TOKEN" 2>/dev/null || true)
SSE_CODE=$(echo "$SSE_HEADERS" | cut -d'|' -f1)
SSE_CT=$(echo "$SSE_HEADERS" | cut -d'|' -f2)
if [[ "$SSE_CODE" == "200" ]] && [[ "$SSE_CT" == *"text/event-stream"* ]]; then
  pass "SSE /events returns 200 with text/event-stream content-type"
else
  fail "SSE /events" "Code=$SSE_CODE, Content-Type=$SSE_CT"
fi

# --- Test 9: Unauthorized access rejected ---
echo "[9] Unauthenticated access shows login page (not 401)"
NOAUTH_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/")
NOAUTH_BODY=$(curl -s "$BASE/" | head -3)
if [[ "$NOAUTH_CODE" == "200" ]] && [[ "$NOAUTH_BODY" == *"Login"* || "$NOAUTH_BODY" == *"Token"* ]]; then
  pass "Unauthenticated / shows login page"
else
  fail "Auth rejection" "HTTP $NOAUTH_CODE"
fi

# --- Test 10: /api/state rejects without auth ---
echo "[10] /api/state rejects without auth"
NOAUTH_STATE=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/api/state")
if [[ "$NOAUTH_STATE" == "401" ]]; then
  pass "/api/state returns 401 without auth"
else
  fail "/api/state auth" "Expected 401, got $NOAUTH_STATE"
fi

# --- Summary ---
echo ""
echo "=== Results ==="
echo "  Passed: $PASS"
echo "  Failed: $FAIL"
echo "  Total:  $((PASS+FAIL))"
echo ""
for t in "${TESTS[@]}"; do
  echo "  $t"
done

if [[ $FAIL -gt 0 ]]; then
  echo ""
  echo "SOME TESTS FAILED"
  exit 1
else
  echo ""
  echo "ALL TESTS PASSED"
  exit 0
fi
