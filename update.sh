#!/usr/bin/env bash
# update.sh — Pull latest version and apply to installed platform
set -euo pipefail

CYAN='\033[0;36m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info() { echo -e "${CYAN}[UPDATE]${NC} $1"; }
ok()   { echo -e "${GREEN}[OK]${NC} $1"; }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Detect install dir from .env or default
if [ -f "/opt/commandcenter/.env" ]; then
  INSTALL_DIR="/opt/commandcenter"
elif [ -f "$SCRIPT_DIR/.env" ]; then
  INSTALL_DIR="$SCRIPT_DIR"
else
  INSTALL_DIR="/opt/commandcenter"
fi

echo ""
echo -e "${CYAN}═══ NeuraLabs Command Center — Update ═══${NC}"
echo ""

# Pull latest code
info "Pulling latest version..."
cd "$SCRIPT_DIR"
git pull
ok "Code updated"

# Copy to install dir (skip if repo IS the install dir)
if [ "$SCRIPT_DIR" != "$INSTALL_DIR" ]; then
  info "Applying to $INSTALL_DIR..."

  for component in command-center funding-bot trend-bot trading-dashboard data-hub scripts config; do
    if [ -d "$SCRIPT_DIR/$component" ]; then
      rsync -a --delete \
        --exclude='node_modules' --exclude='venv' --exclude='__pycache__' \
        --exclude='.env' --exclude='data/canva-oauth.json' \
        --exclude='data/generated-images/*.png' --exclude='logs' \
        --exclude='data/trade_history.json' --exclude='.bot*.lock' \
        "$SCRIPT_DIR/$component/" "$INSTALL_DIR/$component/"
    fi
  done
  ok "Files synced to $INSTALL_DIR"
fi

# Regenerate configs (preserves .env values)
info "Regenerating configs..."
bash "$INSTALL_DIR/config/generate-configs.sh"

# Reinstall npm dependencies if package.json changed
info "Checking dependencies..."
cd "$INSTALL_DIR/command-center" && npm install --production --silent 2>/dev/null
cd "$INSTALL_DIR/trading-dashboard" && npm install --production --silent 2>/dev/null
ok "Dependencies up to date"

# Restart services
info "Restarting services..."
systemctl restart command-center trading-dashboard data-hub 2>/dev/null || true
sleep 2

for svc in command-center trading-dashboard data-hub; do
  if systemctl is-active --quiet "$svc" 2>/dev/null; then
    ok "$svc is running"
  else
    echo -e "${YELLOW}[WARN]${NC} $svc failed — check: journalctl -u $svc -n 20"
  fi
done

echo ""
echo -e "${GREEN}Update complete!${NC}"
