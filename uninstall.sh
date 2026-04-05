#!/usr/bin/env bash
# Uninstall script — removes services, cron jobs, and optionally files
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

INSTALL_DIR="${1:-/opt/commandcenter}"

echo -e "${YELLOW}This will stop and remove all trading platform services.${NC}"
echo -en "Continue? (y/N): "
read -r confirm
[ "$confirm" != "y" ] && echo "Aborted." && exit 0

echo "[1/4] Stopping services..."
for svc in command-center trading-dashboard data-hub; do
  systemctl stop "$svc" 2>/dev/null || true
  systemctl disable "$svc" 2>/dev/null || true
  rm -f "/etc/systemd/system/${svc}.service"
done
systemctl daemon-reload

echo "[2/4] Removing cron jobs..."
crontab -l 2>/dev/null | grep -v "$INSTALL_DIR" | crontab - 2>/dev/null || true

echo "[3/4] Services and cron removed."

echo -en "${YELLOW}Also delete all files in ${INSTALL_DIR}? (y/N): ${NC}"
read -r delete_files
if [ "$delete_files" = "y" ]; then
  rm -rf "$INSTALL_DIR"
  echo -e "${GREEN}Files deleted.${NC}"
else
  echo "Files kept at $INSTALL_DIR"
fi

echo -e "${GREEN}Uninstall complete.${NC}"
