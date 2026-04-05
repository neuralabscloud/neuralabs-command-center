#!/usr/bin/env bash
# ============================================================
# Trading Bot Platform — Installer
# Run: chmod +x install.sh && sudo ./install.sh
# ============================================================
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

banner() {
  echo ""
  echo -e "${CYAN}╔══════════════════════════════════════════╗${NC}"
  echo -e "${CYAN}║   Trading Bot Platform — Installer       ║${NC}"
  echo -e "${CYAN}╚══════════════════════════════════════════╝${NC}"
  echo ""
}

info()  { echo -e "${CYAN}[INFO]${NC} $1"; }
ok()    { echo -e "${GREEN}[OK]${NC} $1"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; }

ask() {
  local prompt="$1" default="${2:-}" var_name="$3" secret="${4:-false}"
  if [ -n "$default" ]; then
    prompt="$prompt [${default}]"
  fi
  echo -en "${CYAN}> ${NC}${prompt}: "
  if [ "$secret" = "true" ]; then
    read -rs val
    echo ""
  else
    read -r val
  fi
  val="${val:-$default}"
  eval "$var_name=\"\$val\""
}

ask_required() {
  local prompt="$1" var_name="$2" secret="${3:-false}"
  while true; do
    ask "$prompt" "" "$var_name" "$secret"
    eval "local v=\"\$$var_name\""
    [ -n "$v" ] && break
    error "This field is required."
  done
}

# ── PRE-FLIGHT CHECKS ──────────────────────────────────────
banner

if [ "$EUID" -ne 0 ]; then
  error "Please run as root: sudo ./install.sh"
  exit 1
fi

info "Checking system requirements..."

# Check Ubuntu
if ! grep -qi "ubuntu" /etc/os-release 2>/dev/null; then
  warn "This installer is designed for Ubuntu. Proceeding anyway..."
fi

# Check RAM (minimum 2GB)
TOTAL_RAM=$(free -m | awk '/^Mem:/ {print $2}')
if [ "$TOTAL_RAM" -lt 1800 ]; then
  error "Minimum 2GB RAM required. Found: ${TOTAL_RAM}MB"
  exit 1
fi

# Check disk (minimum 5GB free)
FREE_DISK=$(df -BG / | awk 'NR==2 {print $4}' | tr -d 'G')
if [ "$FREE_DISK" -lt 5 ]; then
  error "Minimum 5GB free disk required. Found: ${FREE_DISK}GB"
  exit 1
fi

ok "System checks passed (RAM: ${TOTAL_RAM}MB, Disk: ${FREE_DISK}GB free)"

# ── INTERACTIVE CONFIGURATION ──────────────────────────────
echo ""
echo -e "${CYAN}═══ BRANDING ═══${NC}"
ask "Company/platform name" "MyTradingCo" COMPANY_NAME
ask "AI assistant name" "Assistant" ASSISTANT_NAME
ask "Tagline" "Your Trading Platform" TAGLINE
ask "Primary color hue (0-360, 264=purple, 210=blue, 142=green)" "264" PRIMARY_COLOR_HUE
PRIMARY_COLOR_SAT=65
PRIMARY_COLOR_LIT=49

echo ""
echo -e "${CYAN}═══ AUTHENTICATION ═══${NC}"
ask_required "Dashboard login password" CC_PASSWORD true
CC_SESSION_SECRET=$(openssl rand -hex 32)
ok "Session secret auto-generated"

echo ""
echo -e "${CYAN}═══ AI API KEY ═══${NC}"
ask_required "Anthropic Claude API key" ANTHROPIC_API_KEY true

echo ""
echo -e "${CYAN}═══ FUNDING BOT (Hyperliquid) ═══${NC}"
info "Leave empty to skip bot setup (you can configure later in .env)"
ask "Funding bot private key" "" FUNDING_BOT_PRIVATE_KEY true
ask "Funding bot wallet address" "" FUNDING_BOT_WALLET_ADDRESS

echo ""
echo -e "${CYAN}═══ TREND BOT (Hyperliquid) ═══${NC}"
ask "Trend bot private key" "" TREND_BOT_PRIVATE_KEY true
ask "Trend bot wallet address" "" TREND_BOT_WALLET_ADDRESS

echo ""
echo -e "${CYAN}═══ OPTIONAL INTEGRATIONS ═══${NC}"
info "Press Enter to skip any integration"
ask "Telegram bot token (@BotFather)" "" TELEGRAM_BOT_TOKEN
ask "Telegram chat ID" "" TELEGRAM_CHAT_ID
ask "HeyGen API key (video generation)" "" HEYGEN_API_KEY true
ask "Stripe secret key (revenue tracking)" "" STRIPE_SECRET_KEY true
ask "Composio API key (calendar)" "" COMPOSIO_API_KEY true

echo ""
echo -e "${CYAN}═══ INSTALLATION ═══${NC}"
ask "Install directory" "/opt/commandcenter" INSTALL_DIR
DASHBOARD_URL="http://localhost:3000"

# ── INSTALL SYSTEM DEPENDENCIES ───────────────────────────
echo ""
info "Installing system dependencies..."

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq

# Node.js 18+ via NodeSource if not installed
if ! command -v node &>/dev/null || [ "$(node -v | tr -d 'v' | cut -d. -f1)" -lt 18 ]; then
  info "Installing Node.js 18..."
  curl -fsSL https://deb.nodesource.com/setup_18.x | bash -
  apt-get install -y -qq nodejs
fi
ok "Node.js $(node -v)"

# Python 3.10+
if ! command -v python3 &>/dev/null; then
  apt-get install -y -qq python3 python3-venv python3-pip
fi
ok "Python $(python3 --version)"

# Redis
if ! command -v redis-server &>/dev/null; then
  apt-get install -y -qq redis-server
  systemctl enable redis-server
  systemctl start redis-server
fi
ok "Redis installed"

# Pip essentials
pip3 install -q python-dotenv 2>/dev/null || true

# ── COPY FILES ────────────────────────────────────────────
info "Installing to ${INSTALL_DIR}..."
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

mkdir -p "$INSTALL_DIR"

# Copy all components
for component in command-center funding-bot trend-bot trading-dashboard data-hub scripts config; do
  if [ -d "$SCRIPT_DIR/$component" ]; then
    cp -r "$SCRIPT_DIR/$component" "$INSTALL_DIR/"
  fi
done

# Copy root-level files
cp "$SCRIPT_DIR/.env.example" "$INSTALL_DIR/"

ok "Files copied to $INSTALL_DIR"

# ── WRITE .ENV ────────────────────────────────────────────
info "Writing .env configuration..."

cat > "$INSTALL_DIR/.env" <<EOF
# Generated by installer on $(date -u +"%Y-%m-%d %H:%M UTC")
COMPANY_NAME=${COMPANY_NAME}
ASSISTANT_NAME=${ASSISTANT_NAME}
TAGLINE=${TAGLINE}
PRIMARY_COLOR_HUE=${PRIMARY_COLOR_HUE}
PRIMARY_COLOR_SAT=${PRIMARY_COLOR_SAT}
PRIMARY_COLOR_LIT=${PRIMARY_COLOR_LIT}
CC_PASSWORD=${CC_PASSWORD}
CC_SESSION_SECRET=${CC_SESSION_SECRET}
ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}
FUNDING_BOT_PRIVATE_KEY=${FUNDING_BOT_PRIVATE_KEY}
FUNDING_BOT_WALLET_ADDRESS=${FUNDING_BOT_WALLET_ADDRESS}
TREND_BOT_PRIVATE_KEY=${TREND_BOT_PRIVATE_KEY}
TREND_BOT_WALLET_ADDRESS=${TREND_BOT_WALLET_ADDRESS}
TELEGRAM_BOT_TOKEN=${TELEGRAM_BOT_TOKEN}
TELEGRAM_CHAT_ID=${TELEGRAM_CHAT_ID}
HEYGEN_API_KEY=${HEYGEN_API_KEY}
STRIPE_SECRET_KEY=${STRIPE_SECRET_KEY}
COMPOSIO_API_KEY=${COMPOSIO_API_KEY}
BRAND_ASSET_URL=
INSTALL_DIR=${INSTALL_DIR}
DASHBOARD_URL=${DASHBOARD_URL}
EOF

chmod 600 "$INSTALL_DIR/.env"
ok ".env written (permissions: 600)"

# ── GENERATE COMPONENT CONFIGS ───────────────────────────
info "Generating component configs..."
chmod +x "$INSTALL_DIR/config/generate-configs.sh"
bash "$INSTALL_DIR/config/generate-configs.sh"

# ── INSTALL NODE.JS DEPENDENCIES ─────────────────────────
info "Installing Command Center dependencies..."
cd "$INSTALL_DIR/command-center" && npm install --production --silent 2>/dev/null
ok "Command Center npm packages installed"

info "Installing Trading Dashboard dependencies..."
cd "$INSTALL_DIR/trading-dashboard" && npm install --production --silent 2>/dev/null
ok "Trading Dashboard npm packages installed"

# ── INSTALL PYTHON DEPENDENCIES ──────────────────────────
info "Setting up Python virtual environments..."

for bot_dir in funding-bot trend-bot; do
  info "  $bot_dir..."
  python3 -m venv "$INSTALL_DIR/$bot_dir/venv"
  "$INSTALL_DIR/$bot_dir/venv/bin/pip" install -q -r "$INSTALL_DIR/$bot_dir/requirements.txt" 2>/dev/null
done
ok "Bot venvs created"

info "  data-hub..."
python3 -m venv "$INSTALL_DIR/data-hub/venv"
"$INSTALL_DIR/data-hub/venv/bin/pip" install -q redis requests python-dotenv 2>/dev/null
ok "Data hub venv created"

# ── INSTALL SYSTEMD SERVICES ────────────────────────────
info "Installing systemd services..."

for tpl in "$INSTALL_DIR/config/systemd/"*.tpl; do
  svc_name=$(basename "$tpl" .service.tpl)
  sed "s|{{INSTALL_DIR}}|${INSTALL_DIR}|g" "$tpl" > "/etc/systemd/system/${svc_name}.service"
  ok "  ${svc_name}.service installed"
done

systemctl daemon-reload

# Enable and start services
for svc in data-hub trading-dashboard command-center; do
  systemctl enable "$svc" --quiet 2>/dev/null
  systemctl start "$svc" 2>/dev/null || warn "Failed to start $svc — check: journalctl -u $svc"
done
ok "Services enabled and started"

# ── INSTALL CRON JOBS ───────────────────────────────────
info "Installing cron jobs..."
chmod +x "$INSTALL_DIR/command-center/daily-research-trigger.sh" 2>/dev/null || true
chmod +x "$INSTALL_DIR/command-center/analyst-agent.sh" 2>/dev/null || true

CRON_CONTENT=$(sed "s|{{INSTALL_DIR}}|${INSTALL_DIR}|g" "$INSTALL_DIR/config/cron/crontab.tpl")

# Append to existing crontab (preserve existing entries)
(crontab -l 2>/dev/null || true; echo "$CRON_CONTENT") | crontab -
ok "Cron jobs installed"

# ── VERIFICATION ────────────────────────────────────────
echo ""
info "Verifying installation..."
sleep 3

ALL_OK=true
for svc in command-center trading-dashboard data-hub; do
  if systemctl is-active --quiet "$svc" 2>/dev/null; then
    ok "$svc is running"
  else
    warn "$svc is not running — check: journalctl -u $svc -n 20"
    ALL_OK=false
  fi
done

# ── SUMMARY ─────────────────────────────────────────────
echo ""
echo -e "${CYAN}╔══════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║   Installation Complete!                  ║${NC}"
echo -e "${CYAN}╚══════════════════════════════════════════╝${NC}"
echo ""

SERVER_IP=$(hostname -I | awk '{print $1}')

echo -e "  ${GREEN}Command Center:${NC}  http://${SERVER_IP}:3004"
echo -e "  ${GREEN}Trading Dashboard:${NC} http://${SERVER_IP}:3000"
echo -e "  ${GREEN}Login password:${NC}  (the one you set)"
echo ""
echo -e "  ${YELLOW}Config file:${NC} ${INSTALL_DIR}/.env"
echo -e "  ${YELLOW}Edit config:${NC} nano ${INSTALL_DIR}/.env"
echo -e "  ${YELLOW}Regenerate:${NC}  bash ${INSTALL_DIR}/config/generate-configs.sh"
echo ""
echo -e "  ${YELLOW}Manage services:${NC}"
echo "    systemctl status command-center"
echo "    systemctl restart command-center"
echo "    journalctl -u command-center -f"
echo ""

if [ "$ALL_OK" = false ]; then
  warn "Some services failed to start. Check the logs above."
fi

echo -e "${GREEN}Done! Open http://${SERVER_IP}:3004 in your browser.${NC}"
