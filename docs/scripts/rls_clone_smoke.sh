#!/usr/bin/env bash
# rls_clone_smoke.sh — CLONE-ONLY HTTP smoke for the RLS lockdown test.
# Usage: rls_clone_smoke.sh http://localhost:3001
# Self-seeds (patient via register; superadmin via a CLONE-ONLY password reset).
# Run identically before and after the RLS migrations; output must be byte-identical.
set -euo pipefail
BASE="${1:?usage: rls_clone_smoke.sh <base-url>}"
CLONE="${CLONE_DSN:-postgresql://app_owner:app@localhost:5433/tash_clone}"
pass(){ echo "PASS $1 ($2)"; }; fail(){ echo "FAIL $1 ($2)"; exit 1; }
code(){ echo "$1" | tail -n1; }; body(){ echo "$1" | sed '$d'; }

# service IDs are TEXT codes (e.g. lab_autoimmune_anca) — must be quoted in JSON.
# pick one that has an active EG regional price.
read SVC SPEC < <(psql "$CLONE" -tAc \
  "SELECT s.id, s.specialty_id FROM public.services s
     JOIN public.service_regional_prices p
       ON p.service_id=s.id AND p.country_code='EG' AND COALESCE(p.status,'active')='active'
    WHERE s.specialty_id IS NOT NULL LIMIT 1" | tr '|' ' ')
{ [ -n "${SVC:-}" ] && [ -n "${SPEC:-}" ]; } || fail services-lookup "no EG-priced service in clone"

# 1. patient login (CLONE-ONLY: reset an existing patient's password, then login).
#    Deterministic — avoids register's phone/country E.164 validation; the RLS test
#    is about patient_id row-scoping, which login + the reads/writes below exercise.
TS=$(date +%s)
PEMAIL=$(psql "$CLONE" -tAc "SELECT email FROM public.users WHERE role='patient' AND email IS NOT NULL AND is_active IS NOT FALSE ORDER BY id LIMIT 1")
[ -n "$PEMAIL" ] || fail patient-lookup "no active patient with email in clone"
PHASH=$(node -e "console.log(require('bcryptjs').hashSync('Test12345!',10))")
psql "$CLONE" -c "UPDATE public.users SET password_hash='$PHASH' WHERE email='$PEMAIL'" >/dev/null
R=$(curl -s -w '\n%{http_code}' -X POST "$BASE/api/v1/auth/login" -H 'Content-Type: application/json' \
  -d "{\"email\":\"$PEMAIL\",\"password\":\"Test12345!\"}")
[ "$(code "$R")" = 200 ] || fail login "$(code "$R")"
TOK=$(body "$R" | sed -n 's/.*"accessToken":"\([^"]*\)".*/\1/p'); [ -n "$TOK" ] || fail login "no token"
pass login "$(code "$R")"; AUTH="Authorization: Bearer $TOK"

# 2. submit case
R=$(curl -s -w '\n%{http_code}' -X POST "$BASE/api/v1/cases" -H "$AUTH" -H 'Content-Type: application/json' \
  -d "{\"specialtyId\":\"$SPEC\",\"serviceId\":\"$SVC\",\"clinicalQuestion\":\"Smoke test clinical question for RLS verification\",\"country\":\"EG\",\"files\":[{\"fileId\":\"orders/draft/clone/smoke$TS.jpg\",\"label\":\"scan\"}]}")
{ [ "$(code "$R")" = 201 ] || [ "$(code "$R")" = 200 ]; } || fail submit-case "$(code "$R")"
CID=$(body "$R" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p' | head -1); [ -n "$CID" ] || fail submit-case "no case id"
pass submit-case "$(code "$R")"

# 3. case detail (real UUID id; fixed label keeps output run-stable)
C=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/v1/cases/$CID" -H "$AUTH")
[ "$C" = 200 ] || fail case-detail "$C"; pass case-detail "$C"

# 4..7 scoped reads
for ep in "GET /api/v1/cases" "GET /api/v1/notifications" \
          "GET /api/v1/notifications/unread-count" "GET /api/v1/conversations"; do
  M=${ep% *}; P=${ep#* }
  C=$(curl -s -o /dev/null -w '%{http_code}' -X "$M" "$BASE$P" -H "$AUTH")
  [ "$C" = 200 ] || fail "$P" "$C"; pass "$P" "$C"
done

# 7. superadmin (CLONE-ONLY password reset, then login + health)
HASH=$(node -e "console.log(require('bcryptjs').hashSync('CloneAdmin1!',10))")
psql "$CLONE" -c "UPDATE public.users SET password_hash='$HASH' WHERE role='superadmin'" >/dev/null
ADMIN_EMAIL=$(psql "$CLONE" -tAc "SELECT email FROM public.users WHERE role='superadmin' LIMIT 1")
R=$(curl -s -w '\n%{http_code}' -X POST "$BASE/api/v1/admin/auth/login" -H 'Content-Type: application/json' \
  -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"CloneAdmin1!\"}")
[ "$(code "$R")" = 200 ] || fail admin-login "$(code "$R")"
ATOK=$(body "$R" | sed -n 's/.*"accessToken":"\([^"]*\)".*/\1/p')
C=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/v1/admin/health" -H "Authorization: Bearer $ATOK")
[ "$C" = 200 ] || fail admin-health "$C"; pass admin-health "$C"

# 8. negative: patient token must NOT reach admin (403)
C=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/v1/admin/health" -H "$AUTH")
[ "$C" = 403 ] || fail admin-gate "expected 403 got $C"; pass admin-gate "$C"
echo "ALL SMOKE CHECKS PASSED"
