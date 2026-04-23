#!/bin/bash
# Triggered daily by cron — creates research + analyst tasks

# Load env vars if available
DOTENV="${INSTALL_DIR:-/opt/commandcenter}/.env"
[ -f "$DOTENV" ] && export $(grep -v '^#' "$DOTENV" | xargs 2>/dev/null)

NICHE="${DEFAULT_NICHE:-}"
LANG_CODE="${LANGUAGE:-en}"
PORT="${PORT:-3004}"

if [ -z "${INTERNAL_SECRET:-}" ]; then
  echo "ERROR: INTERNAL_SECRET not set in $DOTENV — cannot authenticate with command-center. Restart the service once to auto-generate it." >&2
  exit 1
fi

AUTH=( -H "x-internal: scheduler" -H "x-internal-secret: ${INTERNAL_SECRET}" )

# Research task
curl -s -X POST "http://localhost:${PORT}/research/tasks" \
  -H "Content-Type: application/json" \
  "${AUTH[@]}" \
  -d "{
    \"type\": \"daily_full\",
    \"query\": \"Daily full scan: trending topics, competitor analysis, content hooks, trending hashtags\",
    \"platforms\": [\"tiktok\", \"x\", \"reddit\", \"youtube\", \"instagram\"],
    \"niche\": \"${NICHE}\",
    \"language\": \"${LANG_CODE^^}\"
  }"
echo " — Research task created at $(date)"

# Analyst tasks (diagnose + performance report)
curl -s -X POST "http://localhost:${PORT}/analyst/tasks" \
  -H "Content-Type: application/json" \
  "${AUTH[@]}" \
  -d '{
    "type": "daily_diagnose",
    "description": "Daily bot diagnostics: process check, log health, error scan"
  }'
echo " — Analyst diagnose task created at $(date)"

curl -s -X POST "http://localhost:${PORT}/analyst/tasks" \
  -H "Content-Type: application/json" \
  "${AUTH[@]}" \
  -d '{
    "type": "daily_report",
    "description": "Daily performance analysis: PnL, win rate, trade breakdown per bot"
  }'
echo " — Analyst report task created at $(date)"
