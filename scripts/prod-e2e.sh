#!/usr/bin/env bash
set -euo pipefail
BASE="http://127.0.0.1:3000"
PASS="Test1234!"
FAIL=0
ok() { echo "OK  $1"; }
bad() { echo "FAIL $1 :: $2"; FAIL=$((FAIL+1)); }

json() { curl -sS -m 20 -H "Content-Type: application/json" "$@"; }
auth() { curl -sS -m 20 -H "Content-Type: application/json" -H "Authorization: Bearer $1" "${@:2}"; }

code_of() {
  local out="$1"
  echo "$out" | tail -n1
}
body_of() {
  local out="$1"
  echo "$out" | sed '$d'
}

req() {
  # usage: req METHOD URL [json] [token]
  local method="$1" url="$2" data="${3:-}" token="${4:-}"
  local args=(-X "$method" -w "\n%{http_code}" "$BASE$url")
  if [[ -n "$token" ]]; then args+=(-H "Authorization: Bearer $token"); fi
  if [[ -n "$data" ]]; then args+=(-H "Content-Type: application/json" -d "$data"); else args+=(-H "Content-Type: application/json"); fi
  curl -sS -m 25 "${args[@]}"
}

health=$(curl -sS -m 8 "$BASE/health" || true)
if echo "$health" | grep -q '"status":"ok"'; then ok "health $health"; else bad "health" "$health"; fi

login() {
  local user="$1"
  req POST /api/auth/login "{\"username\":\"$user\",\"password\":\"$PASS\"}"
}

ATLETA_OUT=$(login atletaprueba)
ATLETA_BODY=$(body_of "$ATLETA_OUT")
ATLETA_CODE=$(code_of "$ATLETA_OUT")
COACH_OUT=$(login coachprueba)
COACH_BODY=$(body_of "$COACH_OUT")
COACH_CODE=$(code_of "$COACH_OUT")

echo "LOGIN atletaprueba HTTP $ATLETA_CODE"
echo "LOGIN coachprueba HTTP $COACH_CODE"

TOKEN_A=$(echo "$ATLETA_BODY" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('token',''))" 2>/dev/null || true)
TOKEN_C=$(echo "$COACH_BODY" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('token',''))" 2>/dev/null || true)
ID_A=$(echo "$ATLETA_BODY" | python3 -c "import sys,json; d=json.load(sys.stdin); print((d.get('user') or {}).get('id',''))" 2>/dev/null || true)
ID_C=$(echo "$COACH_BODY" | python3 -c "import sys,json; d=json.load(sys.stdin); print((d.get('user') or {}).get('id',''))" 2>/dev/null || true)

if [[ "$ATLETA_CODE" == "200" && -n "$TOKEN_A" ]]; then ok "login atletaprueba id=$ID_A"; else
  bad "login atletaprueba" "$ATLETA_BODY"
fi
if [[ "$COACH_CODE" == "200" && -n "$TOKEN_C" ]]; then ok "login coachprueba id=$ID_C"; else
  bad "login coachprueba" "$COACH_BODY"
fi

# Create a fresh account via email code (read from pending in mongo if SMTP sent)
STAMP=$(date +%s)
EMAIL="e2e.prod.${STAMP}@gmail.com"
REG_OUT=$(req POST /api/auth/register "{\"email\":\"$EMAIL\"}")
REG_BODY=$(body_of "$REG_OUT")
REG_CODE=$(code_of "$REG_OUT")
echo "REGISTER $EMAIL HTTP $REG_CODE $REG_BODY"
if [[ "$REG_CODE" == "200" || "$REG_CODE" == "201" ]]; then ok "register $EMAIL"; else bad "register" "$REG_BODY"; fi

# Pull verification code from PM2 logs or mongo
sleep 1
CODE=$(grep -oE 'Código de verificación para '"$EMAIL"': [0-9]{6}' /home/ec2-user/.pm2/logs/powerlifting-out.log | tail -n1 | grep -oE '[0-9]{6}' || true)
if [[ -z "$CODE" ]]; then
  CODE=$(python3 - <<PY
import os
print("")
PY
)
fi

echo "VERIFY_CODE_FROM_LOG=$CODE"

# Also try mongosh if available later from node
if [[ -z "$CODE" ]]; then
  echo "Will try mongo via node"
fi

echo "FAILS=$FAIL"
echo "TOKEN_A_LEN=${#TOKEN_A} TOKEN_C_LEN=${#TOKEN_C}"
echo "EMAIL=$EMAIL"
