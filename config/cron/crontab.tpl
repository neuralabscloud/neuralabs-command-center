# Trading Platform — Daily automation tasks
# Installed by install.sh — edit with: crontab -e

# Daily task trigger — 07:00 UTC
0 7 * * * {{INSTALL_DIR}}/command-center/daily-research-trigger.sh >> {{INSTALL_DIR}}/command-center/data/cron.log 2>&1

# Daily bot diagnostics — 07:03 UTC
3 7 * * * {{INSTALL_DIR}}/data-hub/venv/bin/python {{INSTALL_DIR}}/scripts/diagnose_bots.py >> {{INSTALL_DIR}}/scripts/diagnose_bots.log 2>&1

# Daily performance analysis — 07:05 UTC
5 7 * * * {{INSTALL_DIR}}/data-hub/venv/bin/python {{INSTALL_DIR}}/scripts/daily_analysis.py >> {{INSTALL_DIR}}/scripts/daily_analysis.log 2>&1

# Analyst agent — 07:08 UTC (marks tasks complete after diagnostics)
8 7 * * * {{INSTALL_DIR}}/command-center/analyst-agent.sh >> {{INSTALL_DIR}}/command-center/data/cron.log 2>&1

# Research agent — 07:12 UTC (processes research tasks via Claude API)
12 7 * * * {{INSTALL_DIR}}/data-hub/venv/bin/python {{INSTALL_DIR}}/command-center/research-agent.py >> {{INSTALL_DIR}}/command-center/data/research-agent.log 2>&1
