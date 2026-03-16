#!/usr/bin/env bash
# Usage: ./scripts/agent-ping.sh <agent_name> <status> <current_task> [token_cost_usd]
# Posts a heartbeat to the Ops Dashboard.

AGENT_NAME="${1:?agent_name required}"
STATUS="${2:-idle}"
CURRENT_TASK="${3:-}"
TOKEN_COST="${4:-0}"
BASE_URL="${OPS_BASE_URL:-http://localhost:3000}"

if ! curl -sf -X POST "${BASE_URL}/ops/agent/ping" \
  -H "Content-Type: application/json" \
  -d "{\"agent_name\":\"${AGENT_NAME}\",\"status\":\"${STATUS}\",\"current_task\":\"${CURRENT_TASK}\",\"token_cost_usd\":${TOKEN_COST}}" \
  -o /dev/null 2>&1; then
  echo "ERROR: Failed to ping ops dashboard at ${BASE_URL}/ops/agent/ping" >&2
fi
