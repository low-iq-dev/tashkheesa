#!/bin/sh
# scripts/verify-rate-limit-keying.sh
#
# 2026-10-11 — run AFTER deploying the rate-limit change, from any machine.
# Read-only: a dozen anonymous GETs that the API answers 401.
#
# What it proves (see src/middleware/client_ip.js):
#   1. "Per address" limits are keyed on the caller. From one machine the
#      anonymous `ratelimit-remaining` must only COUNT DOWN. Before the change
#      it jumped around (299, 298, 299, 299 …) because the key was an edge hop.
#   2. The key cannot be forged. A request carrying a made-up
#      CF-Connecting-IP header must be REFUSED BY THE EDGE (HTTP 403 with no
#      ratelimit headers — measured 11 Oct 2026) or, failing that, must carry
#      on the same countdown. If the second block shows 401s that start again
#      from 299, the edge is passing a client-supplied header through — tell
#      the developer; the limits would then be per forged address.
#   3. The app-wide limiter no longer answers for the API: the policy on an
#      API path must read 300;w=900 (or 600;w=900 signed in), never 100;w=60.
#
# Usage: sh scripts/verify-rate-limit-keying.sh [base-url]

BASE="${1:-https://tashkheesa.com}"
URL="$BASE/api/v1/specialties"

show() {
  curl -s -o /dev/null -D - --max-time 15 "$@" "$URL" \
    | tr -d '\r' \
    | awk 'BEGIN{IGNORECASE=1} /^HTTP|^ratelimit-policy|^ratelimit-remaining/ {printf "%s  ", $0} END {print ""}'
}

echo "1) Six plain requests — remaining must only count down:"
for i in 1 2 3 4 5 6; do show; done

echo
echo "2) Six with a forged CF-Connecting-IP — expect 403 from the edge (never a fresh 299):"
for i in 1 2 3 4 5 6; do show -H "CF-Connecting-IP: 203.0.113.$i"; done

echo
echo "3) /api/v1/health carries no limiter headers at all (exempt), and is 200:"
curl -s -o /dev/null -D - --max-time 15 "$BASE/api/v1/health" | tr -d '\r' | grep -iE "^HTTP|ratelimit" | tr '\n' ' '
echo
