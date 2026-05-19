#!/usr/bin/env python3
"""
Research Agent — Daily automated trend & competitor research.
Triggered by cron, uses Claude API with web search to gather intel,
posts results to the local command center API.
"""

import json
import os
import sys
import requests
from datetime import datetime, timezone
from pathlib import Path

# Load env
env_path = Path(__file__).parent / ".env"
if env_path.exists():
    for line in env_path.read_text().strip().split("\n"):
        if "=" in line and not line.startswith("#"):
            k, v = line.split("=", 1)
            os.environ[k.strip()] = v.strip()

import anthropic

API_BASE = "http://localhost:3004"
MODEL = "claude-sonnet-4-6"

client = anthropic.Anthropic()


def get_pending_tasks():
    """Get pending research tasks from the API."""
    try:
        res = requests.get(f"{API_BASE}/research/tasks", timeout=5)
        return [t for t in res.json() if t["status"] == "pending"]
    except Exception as e:
        print(f"Error fetching tasks: {e}")
        return []


def update_task(task_id, updates):
    """Update a task status."""
    try:
        requests.patch(
            f"{API_BASE}/research/tasks/{task_id}",
            json=updates,
            timeout=5,
        )
    except Exception as e:
        print(f"Error updating task {task_id}: {e}")


def post_report(report):
    """Post a research report to the API."""
    try:
        requests.post(f"{API_BASE}/research/reports", json=report, timeout=10)
    except Exception as e:
        print(f"Error posting report: {e}")


def run_research(task):
    """Use Claude with web search to do research."""
    task_type = task.get("type", "daily_full")
    query = task.get("query", "")
    niche = task.get("niche", "crypto trading")
    platforms = task.get("platforms", ["tiktok", "x", "reddit"])

    language = task.get("language", "NL")
    prompt = build_prompt(task_type, query, niche, platforms, language)

    print(f"Running research: {task_type} — {query[:60]}...")

    try:
        response = client.messages.create(
            model=MODEL,
            max_tokens=4096,
            messages=[{"role": "user", "content": prompt}],
        )

        text = response.content[0].text
        report = parse_report(text, task)
        return report

    except Exception as e:
        print(f"Claude API error: {e}")
        return None


def build_prompt(task_type, query, niche, platforms, language="NL"):
    """Build research prompt based on task type."""
    platform_str = ", ".join(platforms)
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")

    lang_instruction = ""
    if language == "NL":
        lang_instruction = """
TAAL: Schrijf ALLE content in het Nederlands. Alle hooks, topics, content ideas, suggesties en beschrijvingen moeten volledig in het Nederlands zijn. Alleen merknamen, platformnamen en technische termen (zoals Bitcoin, Ethereum, DeFi) mogen in het Engels blijven. De JSON keys blijven in het Engels."""
    else:
        lang_instruction = """
LANGUAGE: Write ALL content in English. All hooks, topics, content ideas, suggestions and descriptions must be in English. JSON keys stay in English."""

    base = f"""You are a social media research agent for a {niche} brand.
Today is {today}. Research the following and return results as JSON.
{lang_instruction}

IMPORTANT: Return ONLY valid JSON, no markdown, no explanation. The JSON must have this exact structure:
{{
  "sections": [
    {{
      "type": "trending",
      "items": [
        {{"topic": "...", "hook": "...", "platform": "...", "potential": 85}}
      ]
    }},
    {{
      "type": "competitors",
      "items": [
        {{"name": "...", "handle": "@...", "followers": "...", "avg_views": "...", "trend": "+X%", "trend_up": true}}
      ]
    }},
    {{
      "type": "hooks",
      "items": [
        {{"text": "...", "category": "..."}}
      ]
    }},
    {{
      "type": "content_ideas",
      "items": [
        {{"text": "..."}}
      ]
    }}
  ]
}}
"""

    if task_type == "daily_full" and language == "NL":
        return base + f"""
Doe een uitgebreide dagelijkse scan:

1. TRENDING TOPICS (6-8 items): Wat is trending in {niche} op {platform_str}?
   Zoek actuele hot topics, nieuws en debatten. Geef bij elk item een hook-angle in het Nederlands.
   Beoordeel potentieel 0-100 op basis van viraliteitspotentieel.

2. COMPETITORS (3-5 items): Analyseer top crypto/trading content creators.
   Focus op: metavers3nl, crypto influencers in de Nederlandse/Europese markt.
   Vermeld volgersaantallen, gemiddelde views, groeitrend.

3. HOOKS (6-8 items): Genereer virale hook-formules specifiek voor {niche}, in het Nederlands.
   Categoriseer elk (Contrarian, Curiosity Gap, Social Proof, etc.)

4. CONTENT IDEAS (4-6 items): Specifieke video/post ideeën die trends + hooks combineren.
   Elk idee moet concreet en uitvoerbaar zijn, specifiek voor {niche}. Schrijf in het Nederlands.
"""
    elif task_type == "daily_full":
        return base + f"""
Do a comprehensive daily scan:

1. TRENDING TOPICS (6-8 items): What's trending in {niche} on {platform_str} right now?
   Find current hot topics, news, debates. For each, suggest a hook angle.
   Rate potential 0-100 based on virality potential.

2. COMPETITORS (3-5 items): Analyze top crypto/trading content creators.
   Focus on: metavers3nl, crypto influencers in the Dutch/European market.
   Include follower counts, average views, growth trend.

3. HOOKS (6-8 items): Generate viral hook formulas specific to {niche}.
   Categorize each (Contrarian, Curiosity Gap, Social Proof, etc.)

4. CONTENT IDEAS (4-6 items): Specific video/post ideas combining trends + hooks.
   Each should be actionable and specific to {niche}.
"""
    elif task_type == "trending":
        return base + f"Focus ONLY on trending topics in {niche} on {platform_str}. Return 8-10 trending items with hook angles. {query}"
    elif task_type == "competitors":
        return base + f"Focus ONLY on competitor analysis for {niche} creators on {platform_str}. {query}"
    elif task_type == "hooks":
        return base + f"Focus ONLY on generating 10-12 viral hook formulas for {niche} content. {query}"
    elif task_type == "hashtags":
        return base + f"Focus on trending hashtags for {niche} on {platform_str}. Return as content_ideas items. {query}"
    else:
        return base + f"Research the following: {query}"


def parse_report(text, task):
    """Parse Claude's response into a report."""
    # Try to extract JSON from response
    try:
        # Remove markdown code blocks if present
        cleaned = text.strip()
        if cleaned.startswith("```"):
            cleaned = cleaned.split("\n", 1)[1]
            if cleaned.endswith("```"):
                cleaned = cleaned[:-3]
            cleaned = cleaned.strip()

        data = json.loads(cleaned)
        sections = data.get("sections", [])
    except json.JSONDecodeError:
        # Fallback: store raw text as a content idea
        print(f"Warning: Could not parse JSON, storing as raw text")
        sections = [
            {
                "type": "content_ideas",
                "items": [{"text": text[:500]}],
            }
        ]

    return {
        "task_id": task.get("id"),
        "type": task.get("type", "daily_full"),
        "title": f"Research Report — {datetime.now(timezone.utc).strftime('%d %b %Y %H:%M')} UTC",
        "sections": sections,
    }


def main():
    tasks = get_pending_tasks()

    if not tasks:
        print("No pending research tasks.")
        return

    print(f"Found {len(tasks)} pending task(s)")

    for task in tasks:
        task_id = task["id"]
        update_task(task_id, {"status": "processing"})

        report = run_research(task)

        if report:
            post_report(report)
            update_task(task_id, {"status": "completed"})
            print(f"Task {task_id} completed")
        else:
            update_task(task_id, {"status": "failed", "error": "Claude API error"})
            print(f"Task {task_id} failed")


if __name__ == "__main__":
    main()
