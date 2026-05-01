#!/usr/bin/env bash
# generate-configs.sh — Generates per-component config files from the central .env
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

# Safely parse .env line-by-line.
# We do NOT `source` it: legacy / hand-edited .env files often have unquoted
# values containing spaces (e.g. `COMPANY_NAME=Acme Corp`) which bash would
# parse as `Corp: command not found`. This loader tolerates unquoted multi-word
# values, surrounding single/double quotes, and `$` characters in values
# (random passwords) without expanding them.
set -a
while IFS='=' read -r key value || [ -n "$key" ]; do
  [[ -z "$key" || "$key" =~ ^[[:space:]]*# ]] && continue
  key="${key#"${key%%[![:space:]]*}"}"
  key="${key%"${key##*[![:space:]]}"}"
  [[ ! "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] && continue
  if [[ "$value" =~ ^\".*\"$ ]]; then
    value="${value#\"}"; value="${value%\"}"
  elif [[ "$value" =~ ^\'.*\'$ ]]; then
    value="${value#\'}"; value="${value%\'}"
  fi
  printf -v "$key" '%s' "$value"
done < "$ROOT_DIR/.env"
set +a

echo "[CONFIG] Generating configs from .env..."

# ── 1. brand.json for Command Center ──
mkdir -p "$ROOT_DIR/command-center/data"
BRAND_FILE="$ROOT_DIR/command-center/data/brand.json"
if [ ! -f "$BRAND_FILE" ]; then
  cat > "$BRAND_FILE" <<EOF
{
  "company_name": "${COMPANY_NAME:-}",
  "assistant_name": "${ASSISTANT_NAME:-}",
  "tagline": "${TAGLINE:-}",
  "primary_hue": ${PRIMARY_COLOR_HUE:-264},
  "primary_sat": ${PRIMARY_COLOR_SAT:-65},
  "primary_lit": ${PRIMARY_COLOR_LIT:-49}
}
EOF
  echo "[CONFIG] Created command-center/data/brand.json"
else
  echo "[CONFIG] brand.json already exists — skipping (configure via setup wizard)"
fi

# ── 2. Empty task files for command center ──
for task_file in research-tasks analyst-tasks designer-tasks video-tasks avatar-tasks ai-video-tasks video-agent-tasks scriptwriter-tasks scheduled-tasks notifications; do
  [ -f "$ROOT_DIR/command-center/data/${task_file}.json" ] || echo "[]" > "$ROOT_DIR/command-center/data/${task_file}.json"
done
[ -f "$ROOT_DIR/command-center/data/research-reports.json" ] || echo "[]" > "$ROOT_DIR/command-center/data/research-reports.json"
[ -f "$ROOT_DIR/command-center/data/social-connections.json" ] || echo "[]" > "$ROOT_DIR/command-center/data/social-connections.json"
[ -f "$ROOT_DIR/command-center/data/brand-configs.json" ] || echo "{}" > "$ROOT_DIR/command-center/data/brand-configs.json"
mkdir -p "$ROOT_DIR/command-center/data/brand-assets"

echo "[CONFIG] All configs generated successfully."
