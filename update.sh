#!/usr/bin/env bash
# ============================================================
# Command Center — Updater
# Run: chmod +x update.sh && sudo ./update.sh
# ============================================================
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

info()  { echo -e "${CYAN}[INFO]${NC} $1"; }
ok()    { echo -e "${GREEN}[OK]${NC} $1"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; }

echo ""
echo -e "${CYAN}╔══════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║   Command Center — Updater                ║${NC}"
echo -e "${CYAN}╚══════════════════════════════════════════╝${NC}"
echo ""

if [ "$EUID" -ne 0 ]; then
  error "Please run as root: sudo ./update.sh"
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# ── DETECT INSTALL DIR ──────────────────────────
if [ -f "/opt/commandcenter/.env" ]; then
  INSTALL_DIR="/opt/commandcenter"
elif [ -f "$SCRIPT_DIR/.env" ]; then
  INSTALL_DIR="$SCRIPT_DIR"
else
  echo -en "${CYAN}> ${NC}Install directory [/opt/commandcenter]: "
  read -r INSTALL_DIR
  INSTALL_DIR="${INSTALL_DIR:-/opt/commandcenter}"
fi

if [ ! -d "$INSTALL_DIR" ] || [ ! -f "$INSTALL_DIR/.env" ]; then
  error "No valid installation found at $INSTALL_DIR"
  error "Run install.sh first for a fresh installation."
  exit 1
fi

ok "Found installation at $INSTALL_DIR"

# ── BACKUP CUSTOMER DATA (safety net) ───────────
BACKUP_DIR="/var/backups/commandcenter"
mkdir -p "$BACKUP_DIR"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_FILE="$BACKUP_DIR/data-${STAMP}.tar.gz"
ENV_BACKUP_FILE="$BACKUP_DIR/env-${STAMP}.bak"
info "Creating safety backup of customer data..."
if [ -d "$INSTALL_DIR/command-center/data" ]; then
  tar -czf "$BACKUP_FILE" \
    -C "$INSTALL_DIR/command-center" data \
    2>/dev/null || true
fi
if [ -f "$INSTALL_DIR/.env" ]; then
  cp "$INSTALL_DIR/.env" "$ENV_BACKUP_FILE" 2>/dev/null || true
fi
# Keep only last 5 of each backup family
ls -1t "$BACKUP_DIR"/data-*.tar.gz 2>/dev/null | tail -n +6 | xargs -r rm -f
ls -1t "$BACKUP_DIR"/env-*.bak 2>/dev/null | tail -n +6 | xargs -r rm -f
ok "Backup saved to $BACKUP_FILE (and $ENV_BACKUP_FILE)"

# ── PULL LATEST CODE ────────────────────────────
info "Pulling latest code..."
cd "$SCRIPT_DIR"
git pull 2>&1
ok "Code updated"

# ── STOP SERVICE ────────────────────────────────
info "Stopping Command Center..."
systemctl stop command-center 2>/dev/null || true
ok "Service stopped"

# ── SYNC FILES (preserve customer data) ─────────
if [ "$SCRIPT_DIR" != "$INSTALL_DIR" ]; then
  info "Syncing files to $INSTALL_DIR..."

  for component in command-center config; do
    if [ -d "$SCRIPT_DIR/$component" ]; then
      rsync -a --delete \
        --exclude='node_modules' \
        --exclude='.env' \
        --exclude='data/brand.json' \
        --exclude='data/brand-configs.json' \
        --exclude='data/brand-assets/' \
        --exclude='data/avatars.json' \
        --exclude='data/social-connections.json' \
        --exclude='data/notifications.json' \
        --exclude='data/*-tasks.json' \
        --exclude='data/research-reports.json' \
        --exclude='data/canva-oauth.json' \
        --exclude='data/ads-rules.json' \
        --exclude='data/video-projects/' \
        --exclude='data/generated-images/' \
        --exclude='data/ai-video-uploads/' \
        --exclude='data/transcripts/' \
        --exclude='data/community/' \
        --exclude='data/social-media/' \
        --exclude='data/nb-input-*.json' \
        --exclude='data/*.log' \
        --exclude='public/media/' \
        --exclude='logs' \
        "$SCRIPT_DIR/$component/" "$INSTALL_DIR/$component/"
    fi
  done
  ok "Files synced (customer data preserved)"
fi

# ── UPDATE DEPENDENCIES ─────────────────────────
info "Updating npm dependencies..."
cd "$INSTALL_DIR/command-center" && npm install --omit=dev --no-fund --no-audit 2>&1
npm audit fix --no-fund 2>&1 || true
ok "Dependencies updated"

# ── REGENERATE CONFIGS ──────────────────────────
if [ -x "$INSTALL_DIR/config/generate-configs.sh" ]; then
  info "Regenerating configs..."
  bash "$INSTALL_DIR/config/generate-configs.sh"
  ok "Configs regenerated"
fi

# ── UPDATE SYSTEMD SERVICES ─────────────────────
info "Updating systemd services..."
for tpl in "$INSTALL_DIR/config/systemd/"*.tpl; do
  if [ -f "$tpl" ]; then
    svc_name=$(basename "$tpl" .service.tpl)
    sed "s|{{INSTALL_DIR}}|${INSTALL_DIR}|g" "$tpl" > "/etc/systemd/system/${svc_name}.service"
  fi
done
systemctl daemon-reload
ok "Systemd services updated"

# ── RESTART SERVICE ─────────────────────────────
info "Starting Command Center..."
systemctl start command-center 2>/dev/null || warn "Failed to start — check: journalctl -u command-center -n 20"

sleep 2
if systemctl is-active --quiet command-center 2>/dev/null; then
  ok "Command Center is running"
else
  warn "Command Center is not running — check: journalctl -u command-center -n 20"
fi

# ── SUMMARY ─────────────────────────────────────
echo ""
echo -e "${CYAN}╔══════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║   Update Complete!                        ║${NC}"
echo -e "${CYAN}╚══════════════════════════════════════════╝${NC}"
echo ""

SERVER_IP=$(hostname -I | awk '{print $1}')
echo -e "  ${GREEN}▸${NC} Open ${CYAN}http://${SERVER_IP}:3004${NC} in your browser"
echo -e "  ${GREEN}▸${NC} Your .env and customer data have been preserved"
echo -e "  ${GREEN}▸${NC} Safety backup saved to ${CYAN}${BACKUP_FILE}${NC}"
echo ""
echo -e "${GREEN}Done!${NC}"
