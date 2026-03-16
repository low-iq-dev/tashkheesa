#!/usr/bin/env bash
# Usage: ./scripts/agent-log-tokens.sh <agent_name> <tokens_used> <cost_usd> [task_label]
# Logs token usage to the Ops Dashboard.
# Set OPS_BASE_URL to override default (http://localhost:3000).

set -euo pipefail

AGENT_NAME="${1:?Usage: agent-log-tokens.sh <agent_name> <tokens_used> <cost_usd> [task_label]}"
TOKENS_USED="${2:?tokens_used required}"
COST_USD="${3:?cost_usd required}"
TASK_LABEL="${4:-}"
BASE_URL="${OPS_BASE_URL:-http://localhost:3000}"

if ! curl -sf --max-time 5 -X POST "${BASE_URL}/ops/agent/log-tokens" \
  -H "Content-Type: application/json" \
  -d "{\"agent_name\":\"${AGENT_NAME}\",\"tokens_used\":${TOKENS_USED},\"cost_usd\":${COST_USD},\"task_label\":\"${TASK_LABEL}\"}" \
  -o /dev/null 2>&1; then
  echo "ERROR: Failed to log tokens at ${BASE_URL}/ops/agent/log-tokens" >&2
  exit 1
fi
