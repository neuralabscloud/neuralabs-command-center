#!/bin/bash
# Marks pending analyst tasks as completed after the cron scripts have run.
# Called by cron after diagnose_bots.py and daily_analysis.py finish.

API="http://localhost:3004/analyst/tasks"

# Get all pending analyst tasks and mark them completed
TASKS=$(curl -s "$API" 2>/dev/null)
if [ -z "$TASKS" ] || [ "$TASKS" = "[]" ]; then
  echo "No analyst tasks to process"
  exit 0
fi

echo "$TASKS" | python3 -c "
import sys, json, requests
tasks = json.load(sys.stdin)
for t in tasks:
    if t['status'] == 'pending':
        r = requests.patch('$API/' + t['id'], json={'status': 'completed'}, timeout=5)
        print(f'Completed task {t[\"id\"]}: {t.get(\"type\",\"\")}')
"
echo "Analyst tasks processed at $(date)"
