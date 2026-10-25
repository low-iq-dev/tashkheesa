#!/bin/sh
# scripts/deploy-watch.sh
#
# 2026-10-11 — run this in a terminal DURING a deploy to see exactly what the
# site does second by second. Read-only: it polls /healthz and /__version.
#
# Production answered 502 for about a minute on each deploy (7 Oct 11:58 and
# ~14:35 Cairo). This shows WHICH kind of minute it is:
#
#   A. 502s start while the OLD sha is still the last one seen, and the new sha
#      only appears after them
#        → the old instance went away before the new one was serving. That is a
#          restart-in-place, not a zero-downtime deploy (a persistent disk on
#          the service, or a deploy setting, in the Render dashboard).
#   B. The NEW sha answers 200, and THEN 502s / timeouts appear for ~60s
#        → both instances are alive and fighting over database connections
#          (the pool ceiling is budgeted for ONE instance — render.yaml), or
#          the new instance is restarting. Look at "uptime" going back to 0 and
#          at "pool waiting".
#   C. No 502 at all → the health-check and drain changes were the fix.
#
# Usage: sh scripts/deploy-watch.sh [base-url] > deploy-watch.log
# Stop with Ctrl-C once the new sha has answered 200 for a minute.

BASE="${1:-https://tashkheesa.com}"

while true; do
  NOW=$(date -u +%H:%M:%S)
  V=$(curl -s --max-time 4 -w ' http=%{http_code} t=%{time_total}' "$BASE/__version" 2>/dev/null)
  H=$(curl -s --max-time 4 -w ' http=%{http_code} t=%{time_total}' "$BASE/healthz" 2>/dev/null)
  SHA=$(printf '%s' "$V" | sed -n 's/.*"gitSha":"\([^"]*\)".*/\1/p' | cut -c1-8)
  UP=$(printf '%s' "$V" | sed -n 's/.*"uptimeSec":\([0-9]*\).*/\1/p')
  VC=$(printf '%s' "$V" | sed -n 's/.* http=\([0-9]*\).*/\1/p')
  HC=$(printf '%s' "$H" | sed -n 's/.* http=\([0-9]*\).*/\1/p')
  HT=$(printf '%s' "$H" | sed -n 's/.* t=\([0-9.]*\).*/\1/p')
  WAIT=$(printf '%s' "$H" | sed -n 's/.*"waiting":\([0-9]*\).*/\1/p')
  DBTO=$(printf '%s' "$H" | sed -n 's/.*"dbTimedOut":\([a-z]*\).*/\1/p')
  printf '%s  version=%s sha=%s uptime=%ss  healthz=%s in %ss  pool-waiting=%s dbTimedOut=%s\n' \
    "$NOW" "${VC:-ERR}" "${SHA:--}" "${UP:--}" "${HC:-ERR}" "${HT:--}" "${WAIT:--}" "${DBTO:--}"
  sleep 1
done
