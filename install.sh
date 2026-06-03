#!/usr/bin/env bash
# ============================================================
# Command Center — Installer
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
  echo -e "${CYAN}║   Command Center — Installer              ║${NC}"
  echo -e "${CYAN}╚══════════════════════════════════════════╝${NC}"
  echo ""
}

info()  { echo -e "${CYAN}[INFO]${NC} $1"; }
ok()    { echo -e "${GREEN}[OK]${NC} $1"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; }

ask() {
  local prompt="$1" default="${2:-}" var_name="$3" secret="${4:-false}"
  if [ -n "$default" ]; then prompt="$prompt [${default}]"; fi
  echo -en "${CYAN}> ${NC}${prompt}: "
  if [ "$secret" = "true" ]; then read -rs val; echo ""; else read -r val; fi
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

# Wrap a value in single quotes for a .env line, escaping any internal '.
# Output is safe to source from bash with `set -u` and parses cleanly via
# systemd EnvironmentFile= (single quotes are stripped, contents not expanded).
env_quote() {
  local v="${1:-}"
  printf "'%s'" "${v//\'/\'\\\'\'}"
}

# ── PRE-FLIGHT CHECKS ──────────────────────────────────────
banner

if [ "$EUID" -ne 0 ]; then
  error "Please run as root: sudo ./install.sh"
  exit 1
fi

info "Checking system requirements..."

if ! grep -qi "ubuntu" /etc/os-release 2>/dev/null; then
  warn "This installer is designed for Ubuntu. Proceeding anyway..."
fi

TOTAL_RAM=$(free -m | awk '/^Mem:/ {print $2}')
if [ "$TOTAL_RAM" -lt 1800 ]; then
  error "Minimum 2GB RAM required. Found: ${TOTAL_RAM}MB"
  exit 1
fi

FREE_DISK=$(df -BG / | awk 'NR==2 {print $4}' | tr -d 'G')
if [ "$FREE_DISK" -lt 5 ]; then
  error "Minimum 5GB free disk required. Found: ${FREE_DISK}GB"
  exit 1
fi

ok "System checks passed (RAM: ${TOTAL_RAM}MB, Disk: ${FREE_DISK}GB free)"

# ── CONFIGURATION (minimal — rest via setup wizard) ───────
echo ""
echo -e "${CYAN}═══ INSTALLATION ═══${NC}"
ask "Install directory" "/opt/commandcenter" INSTALL_DIR

# Detect existing installation — if .env already exists we MUST NOT overwrite it,
# otherwise the customer's API keys, password, and integrations are lost on re-run.
EXISTING_ENV=false
if [ -f "$INSTALL_DIR/.env" ]; then
  EXISTING_ENV=true
  echo ""
  echo -e "${YELLOW}═══ EXISTING INSTALLATION DETECTED ═══${NC}"
  ok "Found existing .env at $INSTALL_DIR/.env — credentials will be preserved"
  info "If you want to update code only, prefer: cd $INSTALL_DIR && ./update.sh"
  info "Continuing in re-install mode: dependencies, systemd, and code will refresh; .env will NOT be touched."
fi

echo ""
echo -e "${CYAN}═══ AUTHENTICATION ═══${NC}"
if [ "$EXISTING_ENV" = "true" ]; then
  ok "Skipping password prompt (existing .env preserved)"
  CC_PASSWORD=""
  CC_SESSION_SECRET=""
else
  ask_required "Dashboard login password" CC_PASSWORD true
  CC_SESSION_SECRET=$(openssl rand -hex 32)
  ok "Session secret auto-generated"
fi

# All other config is done via the setup wizard in the browser
COMPANY_NAME=""
ASSISTANT_NAME=""
TAGLINE=""
PRIMARY_COLOR_HUE=264
PRIMARY_COLOR_SAT=65
PRIMARY_COLOR_LIT=49
ANTHROPIC_API_KEY=""
INFERENCE_API_KEY=""
TELEGRAM_BOT_TOKEN=""
TELEGRAM_CHAT_ID=""
HEYGEN_API_KEY=""
STRIPE_SECRET_KEY=""
COMPOSIO_API_KEY=""
DASHBOARD_URL="http://localhost:3000"

# ── INSTALL SYSTEM DEPENDENCIES ───────────────────────────
echo ""
info "Installing system dependencies..."

export DEBIAN_FRONTEND=noninteractive

# Wait for any running apt/dpkg process to finish (e.g. unattended-upgrades on fresh servers)
while fuser /var/lib/dpkg/lock-frontend &>/dev/null; do
  info "Waiting for other package manager to finish..."
  sleep 5
done

info "Updating package lists..."
apt-get update -q || { error "apt-get update failed — check your internet connection"; exit 1; }

# Node.js 22+ (via NodeSource) — required by langchain, vite, http-proxy-middleware, and other deps
if ! command -v node &>/dev/null || [ "$(node -v | tr -d 'v' | cut -d. -f1)" -lt 22 ]; then
  info "Installing Node.js 22..."
  curl -fsSL --max-time 30 https://deb.nodesource.com/setup_22.x -o /tmp/nodesource_setup.sh || {
    error "Failed to download NodeSource setup. Check internet connection."
    exit 1
  }
  bash /tmp/nodesource_setup.sh
  apt-get install -y -q nodejs || { error "Failed to install Node.js"; exit 1; }
  rm -f /tmp/nodesource_setup.sh
fi
ok "Node.js $(node -v)"

# Python 3 + pip (Ubuntu minimal ships python3 without pip3)
if ! command -v python3 &>/dev/null || ! command -v pip3 &>/dev/null; then
  info "Installing Python 3 + pip..."
  apt-get install -y -q python3 python3-venv python3-pip || { error "Failed to install Python 3"; exit 1; }
fi
ok "Python $(python3 --version)"

# Redis
if ! command -v redis-server &>/dev/null; then
  info "Installing Redis..."
  apt-get install -y -q redis-server || { error "Failed to install Redis"; exit 1; }
  systemctl enable redis-server 2>/dev/null || true
  systemctl start redis-server 2>/dev/null || true
fi
ok "Redis installed"

# Cron (daily research/analyst scheduler needs crontab)
if ! command -v crontab &>/dev/null; then
  info "Installing cron..."
  apt-get install -y -q cron || { error "Failed to install cron"; exit 1; }
  systemctl enable cron 2>/dev/null || true
  systemctl start cron 2>/dev/null || true
fi
ok "Cron installed"

# rsync (required by update.sh for atomic file sync with preserve-excludes)
if ! command -v rsync &>/dev/null; then
  info "Installing rsync..."
  apt-get install -y -q rsync || { error "Failed to install rsync"; exit 1; }
fi
ok "rsync installed"

# ImageMagick (used by Designer agent to composite the brand logo onto generated images)
if ! command -v convert &>/dev/null; then
  info "Installing ImageMagick..."
  apt-get install -y -q imagemagick || warn "Failed to install ImageMagick — Designer logo overlay will be skipped until installed."
fi
ok "ImageMagick installed"

# Claude Code (optional — timeout after 60s)
info "Installing Claude Code..."
if timeout 60 npm install -g @anthropic-ai/claude-code 2>&1; then
  ok "Claude Code installed"
else
  warn "Claude Code install timed out or failed — install later with: npm install -g @anthropic-ai/claude-code"
fi

# Inference.sh CLI — required by Designer (Nano Banana) and AI Video agents.
# The official one-liner downloads a static binary to /usr/local/bin/inferencesh
# (with `infsh` and `belt` symlinks). Non-fatal: customers can install later.
info "Installing Inference.sh CLI..."
if ! command -v infsh &>/dev/null; then
  if timeout 90 sh -c "curl -fsSL https://cli.inference.sh | sh" 2>&1; then
    ok "Inference.sh CLI installed ($(infsh 2>&1 | head -1 | tr -d '\033' | sed 's/\[[0-9;]*m//g' || echo 'installed'))"
  else
    warn "Inference.sh CLI install failed — install later with: curl -fsSL https://cli.inference.sh | sh"
  fi
else
  ok "Inference.sh CLI already installed"
fi

info "Setting up Python virtualenv for research-agent.py..."
# Use a venv at $INSTALL_DIR/venv so we sidestep PEP 668 (externally-managed-environment)
# on Ubuntu 24.04+ and avoid touching system Python packages.
mkdir -p "$INSTALL_DIR"
if python3 -m venv "$INSTALL_DIR/venv"; then
  "$INSTALL_DIR/venv/bin/pip" install -q --upgrade pip || true
  if "$INSTALL_DIR/venv/bin/pip" install -q python-dotenv anthropic requests; then
    ok "Python deps installed in $INSTALL_DIR/venv"
  else
    warn "Failed to install Python deps — research-agent.py will not work until you run:"
    warn "  $INSTALL_DIR/venv/bin/pip install python-dotenv anthropic requests"
  fi
else
  warn "Failed to create venv at $INSTALL_DIR/venv — research-agent.py will not work."
  warn "Make sure python3-venv is installed: apt-get install -y python3-venv"
fi

# ── COPY FILES ────────────────────────────────────────────
info "Installing to ${INSTALL_DIR}..."
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

mkdir -p "$INSTALL_DIR"

# Copy Command Center components
for component in command-center config; do
  if [ -d "$SCRIPT_DIR/$component" ]; then
    cp -r "$SCRIPT_DIR/$component" "$INSTALL_DIR/"
  fi
done

cp "$SCRIPT_DIR/.env.example" "$INSTALL_DIR/"
ok "Files copied to $INSTALL_DIR"

# ── WRITE .ENV ────────────────────────────────────────────
if [ "$EXISTING_ENV" = "true" ]; then
  info "Preserving existing .env (re-install mode)"
  # Safety net: make absolutely sure permissions are still locked down.
  chmod 600 "$INSTALL_DIR/.env" 2>/dev/null || true
  ok "Existing .env left untouched"
else
  info "Writing .env configuration..."

  cat > "$INSTALL_DIR/.env" <<EOF
# Generated by installer on $(date -u +"%Y-%m-%d %H:%M UTC")
# Branding & integrations are configured via the setup wizard
COMPANY_NAME=$(env_quote "$COMPANY_NAME")
ASSISTANT_NAME=$(env_quote "$ASSISTANT_NAME")
TAGLINE=$(env_quote "$TAGLINE")
PRIMARY_COLOR_HUE=$(env_quote "$PRIMARY_COLOR_HUE")
PRIMARY_COLOR_SAT=$(env_quote "$PRIMARY_COLOR_SAT")
PRIMARY_COLOR_LIT=$(env_quote "$PRIMARY_COLOR_LIT")
CC_PASSWORD=$(env_quote "$CC_PASSWORD")
CC_SESSION_SECRET=$(env_quote "$CC_SESSION_SECRET")
ANTHROPIC_API_KEY=$(env_quote "$ANTHROPIC_API_KEY")
INFERENCE_API_KEY=$(env_quote "$INFERENCE_API_KEY")
TELEGRAM_BOT_TOKEN=$(env_quote "$TELEGRAM_BOT_TOKEN")
TELEGRAM_CHAT_ID=$(env_quote "$TELEGRAM_CHAT_ID")
HEYGEN_API_KEY=$(env_quote "$HEYGEN_API_KEY")
STRIPE_SECRET_KEY=$(env_quote "$STRIPE_SECRET_KEY")
COMPOSIO_API_KEY=$(env_quote "$COMPOSIO_API_KEY")
COMPOSIO_ACCOUNT_ID=''
BRAND_ASSET_URL=''
LANGUAGE=''
TIMEZONE=''
DEFAULT_NICHE=''
INSTALL_DIR=$(env_quote "$INSTALL_DIR")
DASHBOARD_URL=$(env_quote "$DASHBOARD_URL")
EOF

  chmod 600 "$INSTALL_DIR/.env"
  ok ".env written (permissions: 600)"
fi

# ── GENERATE COMPONENT CONFIGS ───────────────────────────
info "Generating configs..."
chmod +x "$INSTALL_DIR/config/generate-configs.sh"
bash "$INSTALL_DIR/config/generate-configs.sh"

# ── INSTALL NODE.JS DEPENDENCIES ─────────────────────────
info "Installing Command Center dependencies (this may take a few minutes)..."
# --legacy-peer-deps: some transitive deps (composio-core / langchain / @langchain/*)
# declare conflicting peer ranges that npm 7+ refuses to resolve strictly. This
# flag accepts the known-good resolution instead of aborting the whole install.
cd "$INSTALL_DIR/command-center" && npm install --omit=dev --no-fund --no-audit --legacy-peer-deps 2>&1
info "Running security audit fix..."
npm audit fix --no-fund --legacy-peer-deps 2>&1 || true
ok "Command Center npm packages installed"

# Playwright browsers (needed for slide designer and browser tools)
# Non-fatal: if this fails the rest of the install must continue
info "Installing Playwright browsers (this may take a few minutes)..."
if npx playwright install chromium 2>&1; then
  info "Installing Playwright system dependencies (this may take a few minutes)..."
  # Wait for any running apt/dpkg process to finish (e.g. unattended-upgrades)
  while fuser /var/lib/dpkg/lock-frontend &>/dev/null; do
    info "Waiting for other package manager to finish..."
    sleep 5
  done
  if DEBIAN_FRONTEND=noninteractive npx playwright install-deps chromium 2>&1; then
    ok "Playwright Chromium installed"
  else
    warn "Playwright system deps failed — slide designer may not work. Install later with: npx playwright install-deps chromium"
  fi
else
  warn "Playwright install failed — slide designer won't work. Install later with: npx playwright install chromium"
fi

# ── INSTALL SYSTEMD SERVICES ────────────────────────────
info "Installing systemd services..."

for tpl in "$INSTALL_DIR/config/systemd/"*.tpl; do
  svc_name=$(basename "$tpl" .service.tpl)
  sed "s|{{INSTALL_DIR}}|${INSTALL_DIR}|g" "$tpl" > "/etc/systemd/system/${svc_name}.service"
  ok "  ${svc_name}.service installed"
done

systemctl daemon-reload 2>/dev/null || true

systemctl enable command-center --quiet 2>/dev/null || true
systemctl start command-center 2>/dev/null || warn "Failed to start command-center — check: journalctl -u command-center"
ok "Command Center service started"

# ── INSTALL CRON JOBS ───────────────────────────────────
# Default: no cron entries (schedules are managed in-app via Agents to Schedules).
# Only install crontab if the template has non-comment, non-blank lines.
if [ -f "$INSTALL_DIR/config/cron/crontab.tpl" ]; then
  CRON_CONTENT=$(sed "s|{{INSTALL_DIR}}|${INSTALL_DIR}|g" "$INSTALL_DIR/config/cron/crontab.tpl")
  if echo "$CRON_CONTENT" | grep -qE '^[^#[:space:]]'; then
    info "Installing cron jobs..."
    (crontab -l 2>/dev/null || true; echo "$CRON_CONTENT") | crontab -
    ok "Cron jobs installed"
  fi
fi

# ── OPEN FIREWALL ────────────────────────────────────────
info "Opening firewall port 3004..."
iptables -I INPUT -p tcp --dport 3004 -j ACCEPT 2>/dev/null || true
ufw allow 3004 2>/dev/null || true
# Persist iptables rules if possible
if command -v netfilter-persistent &>/dev/null; then
  netfilter-persistent save 2>/dev/null || true
elif command -v iptables-save &>/dev/null; then
  iptables-save > /etc/iptables/rules.v4 2>/dev/null || true
fi
ok "Firewall port 3004 opened"

# ── VERIFICATION ────────────────────────────────────────
echo ""
info "Verifying installation..."
sleep 3

if systemctl is-active --quiet command-center 2>/dev/null; then
  ok "Command Center is running"
else
  warn "Command Center is not running — check: journalctl -u command-center -n 20"
fi

# ── SUMMARY ─────────────────────────────────────────────
echo ""
echo -e "${CYAN}╔══════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║   Installation Complete!                  ║${NC}"
echo -e "${CYAN}╚══════════════════════════════════════════╝${NC}"
echo ""

SERVER_IP=$(hostname -I | awk '{print $1}')

echo -e "  ${GREEN}▸ NEXT STEP:${NC}"
echo -e "  Open ${CYAN}http://${SERVER_IP}:3004${NC} in your browser"
echo -e "  Log in with your password and follow the setup wizard."
echo ""
echo -e "  The wizard will help you configure:"
echo "    - Branding (name, colors, tagline)"
echo "    - Anthropic API key (AI features)"
echo "    - Telegram notifications"
echo "    - Integrations (HeyGen, Stripe, Composio)"
echo ""
echo -e "  ${YELLOW}Manage services:${NC}"
echo "    systemctl status command-center"
echo "    systemctl restart command-center"
echo "    journalctl -u command-center -f"
echo ""
echo -e "${GREEN}Done! Open http://${SERVER_IP}:3004 to get started.${NC}"
