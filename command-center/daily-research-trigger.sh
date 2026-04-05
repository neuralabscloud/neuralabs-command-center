#!/bin/bash
# Triggered daily by cron — creates research + analyst tasks

# Research task — NL
curl -s -X POST http://localhost:3004/research/tasks \
  -H "Content-Type: application/json" \
  -d '{
    "type": "daily_full",
    "query": "Daily full scan: trending crypto/trading topics, competitor analysis, content hooks, trending hashtags",
    "platforms": ["tiktok", "x", "reddit", "youtube", "instagram"],
    "niche": "crypto trading",
    "language": "NL"
  }'
echo " — Research task NL created at $(date)"

# Research task — EN
curl -s -X POST http://localhost:3004/research/tasks \
  -H "Content-Type: application/json" \
  -d '{
    "type": "daily_full",
    "query": "Daily full scan: trending crypto/trading topics, competitor analysis, content hooks, trending hashtags",
    "platforms": ["tiktok", "x", "reddit", "youtube", "instagram"],
    "niche": "crypto trading",
    "language": "EN"
  }'
echo " — Research task EN created at $(date)"

# Analyst tasks (diagnose + performance report)
curl -s -X POST http://localhost:3004/analyst/tasks \
  -H "Content-Type: application/json" \
  -d '{
    "type": "daily_diagnose",
    "description": "Dagelijkse bot diagnose: process check, log health, error scan"
  }'
echo " — Analyst diagnose task created at $(date)"

curl -s -X POST http://localhost:3004/analyst/tasks \
  -H "Content-Type: application/json" \
  -d '{
    "type": "daily_report",
    "description": "Dagelijkse performance analyse: PnL, win rate, trade breakdown per bot"
  }'
echo " — Analyst report task created at $(date)"
