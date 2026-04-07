# NeuraLabs Command Center — Daily automation tasks
# Installed by install.sh — edit with: crontab -e

# Daily task trigger — 07:00 UTC
0 7 * * * {{INSTALL_DIR}}/command-center/daily-research-trigger.sh >> {{INSTALL_DIR}}/command-center/data/cron.log 2>&1

# Research agent — 07:05 UTC (processes research tasks via Claude API)
5 7 * * * python3 {{INSTALL_DIR}}/command-center/research-agent.py >> {{INSTALL_DIR}}/command-center/data/research-agent.log 2>&1
