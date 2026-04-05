#!/usr/bin/env bash
# generate-configs.sh — Generates per-component config files from the central .env
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

# Source the .env
set -a
source "$ROOT_DIR/.env"
set +a

echo "[CONFIG] Generating configs from .env..."

# ── 1. brand.json for Command Center ──
mkdir -p "$ROOT_DIR/command-center/data"
cat > "$ROOT_DIR/command-center/data/brand.json" <<EOF
{
  "company_name": "${COMPANY_NAME:-Trading Platform}",
  "assistant_name": "${ASSISTANT_NAME:-Assistant}",
  "tagline": "${TAGLINE:-Your Trading Platform}",
  "primary_hue": ${PRIMARY_COLOR_HUE:-264},
  "primary_sat": ${PRIMARY_COLOR_SAT:-65},
  "primary_lit": ${PRIMARY_COLOR_LIT:-49}
}
EOF
echo "[CONFIG] Created command-center/data/brand.json"

# ── 2. config.json for Trading Dashboard ──
cat > "$ROOT_DIR/trading-dashboard/config.json" <<EOF
{
  "port": 3000,
  "websocketUrl": "wss://api.hyperliquid.xyz/ws",
  "restUrl": "https://api.hyperliquid.xyz/info",
  "bots": [
    {
      "id": "funding",
      "name": "Funding Rate Bot",
      "type": "funding",
      "enabled": true,
      "wallet_address": "${FUNDING_BOT_WALLET_ADDRESS:-}",
      "logFile": "${ROOT_DIR}/funding-bot/logs/funding_bot.log",
      "dataFile": "${ROOT_DIR}/funding-bot/data/trade_history.json",
      "workdir": "${ROOT_DIR}/funding-bot",
      "script": "run.py"
    },
    {
      "id": "trend",
      "name": "Trend Bot",
      "type": "trend",
      "enabled": true,
      "wallet_address": "${TREND_BOT_WALLET_ADDRESS:-}",
      "logFile": "${ROOT_DIR}/trend-bot/logs/mean_reversion_bot.log",
      "dataFile": "${ROOT_DIR}/trend-bot/data/trade_history.json",
      "workdir": "${ROOT_DIR}/trend-bot",
      "script": "run.py"
    }
  ]
}
EOF
echo "[CONFIG] Created trading-dashboard/config.json"

# ── 3. Empty data files if they don't exist ──
for bot_dir in funding-bot trend-bot; do
  mkdir -p "$ROOT_DIR/$bot_dir/data" "$ROOT_DIR/$bot_dir/logs"
  [ -f "$ROOT_DIR/$bot_dir/data/trade_history.json" ] || echo "[]" > "$ROOT_DIR/$bot_dir/data/trade_history.json"
done

# ── 4. Empty task files for command center ──
for task_file in research-tasks analyst-tasks designer-tasks video-tasks avatar-tasks ai-video-tasks video-agent-tasks scriptwriter-tasks scheduled-tasks notifications; do
  [ -f "$ROOT_DIR/command-center/data/${task_file}.json" ] || echo "[]" > "$ROOT_DIR/command-center/data/${task_file}.json"
done
[ -f "$ROOT_DIR/command-center/data/research-reports.json" ] || echo "[]" > "$ROOT_DIR/command-center/data/research-reports.json"

echo "[CONFIG] All configs generated successfully."
