#!/usr/bin/env python3
"""
diagnose_bots.py - Dagelijkse diagnostiek van alle NeuraLabs bots.
Controleert: proces actief, log frisheid, recente fouten, bot-specifieke metrics.
Stuurt volledig rapport naar Telegram.

Gebruik:
  python3 /root/diagnose_bots.py
"""

import os
import json
import subprocess
import requests
import html
from datetime import datetime, timezone
from pathlib import Path

# ─── CONFIG ──────────────────────────────────────────────────────────────────

INSTALL_DIR = os.getenv("INSTALL_DIR", "/opt/commandcenter")

TELEGRAM_TOKEN   = os.getenv("TELEGRAM_BOT_TOKEN", "")
TELEGRAM_CHAT_ID = os.getenv("TELEGRAM_CHAT_ID", "")

BOTS = [
    {
        "name":   "Funding Bot",
        "script": "run.py",
        "workdir": f"{INSTALL_DIR}/funding-bot",
        "log":    f"{INSTALL_DIR}/funding-bot/logs/neuralabs_funding_bot.log",
        "emoji":  "💰",
    },
    {
        "name":   "Trend Bot",
        "script": "run.py",
        "workdir": f"{INSTALL_DIR}/trend-bot",
        "log":    f"{INSTALL_DIR}/trend-bot/logs/mean_reversion_bot.log",
        "emoji":  "📈",
    },
]

# Log is "staal" als er langer dan N minuten niet naar geschreven is
STALE_MINS = 60

# Aantal regels om op fouten te scannen
ERROR_SCAN_LINES = 300

# Fout-keywords (case-insensitive)
ERROR_KEYWORDS = ("error", "exception", "critical", "traceback", "failed", "❌")

# Regels die geen echte fout zijn (bijv. al opgeloste bekende melding)
ERROR_IGNORE = (
    "geoblock",                    # polymarket geoblock — is opgelost via proxy
    "no market found",
    "ping/pong timed out",         # tijdelijke websocket blip, herstelt zichzelf
)


# ─── TELEGRAM ────────────────────────────────────────────────────────────────

def send_telegram(text: str):
    url     = f"https://api.telegram.org/bot{TELEGRAM_TOKEN}/sendMessage"
    payload = {
        "chat_id":                  TELEGRAM_CHAT_ID,
        "text":                     text,
        "parse_mode":               "HTML",
        "disable_web_page_preview": True,
    }
    try:
        r = requests.post(url, json=payload, timeout=15)
        if r.status_code != 200:
            print(f"[TELEGRAM] Fout: {r.text}")
    except Exception as e:
        print(f"[TELEGRAM] Kon bericht niet sturen: {e}")


# ─── CHECKS ──────────────────────────────────────────────────────────────────

def check_process(script: str, workdir: str) -> tuple:
    """
    Returns (running: bool, pids: str).
    Vindt processen die `script` draaien vanuit `workdir`,
    door /proc/PID/cwd te lezen (werkt voor 'run.py' dat in meerdere dirs draait).
    """
    try:
        result = subprocess.run(["pgrep", "-f", script],
                                capture_output=True, text=True)
        all_pids = result.stdout.strip().split()
        matched  = []
        for pid in all_pids:
            try:
                cwd = os.readlink(f"/proc/{pid}/cwd")
                if os.path.normpath(cwd) == os.path.normpath(workdir):
                    matched.append(pid)
            except Exception:
                pass
        return bool(matched), ", ".join(matched)
    except Exception:
        return False, ""


def check_log_freshness(log_path: str) -> tuple:
    """Returns (is_fresh: bool, age_str: str)"""
    p = Path(log_path)
    if not p.exists():
        return False, "log niet gevonden"
    age_secs = (datetime.now(timezone.utc).timestamp() - p.stat().st_mtime)
    mins = int(age_secs / 60)
    if mins < 60:
        age_str = f"{mins}m geleden"
    elif mins < 1440:
        age_str = f"{mins // 60}u {mins % 60}m geleden"
    else:
        age_str = f"{mins // 1440}d geleden"
    return age_secs < STALE_MINS * 60, age_str


def get_recent_errors(log_path: str) -> list:
    """Geeft de laatste ERROR-regels terug (max 5)."""
    p = Path(log_path)
    if not p.exists():
        return []
    try:
        with open(p) as f:
            lines = f.readlines()
        tail   = lines[-ERROR_SCAN_LINES:]
        errors = []
        for line in tail:
            ll = line.lower()
            if not any(k in ll for k in ERROR_KEYWORDS):
                continue
            if any(ig in ll for ig in ERROR_IGNORE):
                continue
            errors.append(line.strip())
        return errors[-5:]
    except Exception:
        return []


def get_last_log_line(log_path: str) -> str:
    p = Path(log_path)
    if not p.exists():
        return ""
    try:
        with open(p) as f:
            lines = [l.strip() for l in f if l.strip()]
        return lines[-1][:120] if lines else ""
    except Exception:
        return ""


# ─── REPORT BUILDER ──────────────────────────────────────────────────────────

def build_report() -> tuple:
    """Returns (report_text: str, all_ok: bool)"""
    now      = datetime.now(timezone.utc).strftime("%d-%m-%Y %H:%M UTC")
    lines    = [f"<b>🔍 DAGELIJKSE BOT DIAGNOSE</b>", f"<i>{now}</i>", ""]
    all_ok   = True
    problems = []

    for bot in BOTS:
        running, pids     = check_process(bot["script"], bot["workdir"])
        fresh, age_str    = check_log_freshness(bot["log"])
        errors            = get_recent_errors(bot["log"])
        bot_ok            = running and fresh and not errors

        if not bot_ok:
            all_ok = False

        status = "🟢" if bot_ok else "🔴"
        lines.append(f"{bot['emoji']} <b>{bot['name']}</b> {status}")

        # Proces
        if running:
            lines.append(f"  ✅ Actief (PID {pids})")
        else:
            lines.append(f"  ❌ GESTOPT — proces niet gevonden!")
            problems.append(f"{bot['name']}: proces gestopt")

        # Log frisheid
        if fresh:
            lines.append(f"  📝 Log actief: {age_str}")
        else:
            lines.append(f"  ⚠️ Log STAAL: {age_str}")
            problems.append(f"{bot['name']}: log staal ({age_str})")

        # Fouten
        if errors:
            lines.append(f"  🚨 {len(errors)} recente fout(en):")
            for e in errors[:2]:
                lines.append(f"  <code>{html.escape(e[:100])}</code>")
            problems.append(f"{bot['name']}: {len(errors)} fouten in log")
        else:
            lines.append(f"  ✅ Geen recente fouten")

        # Laatste log regel
        last = get_last_log_line(bot["log"])
        if last:
            lines.append(f"  💬 <code>{html.escape(last[-100:])}</code>")

        lines.append("")

    # Samenvatting
    lines.append("━" * 28)
    if all_ok:
        lines.append("✅ <b>Alle systemen operationeel</b>")
    else:
        lines.append(f"⚠️ <b>{len(problems)} probleem/problemen gevonden:</b>")
        for p in problems:
            lines.append(f"  • {p}")

    return "\n".join(lines), all_ok


# ─── ENTRY POINT ─────────────────────────────────────────────────────────────

if __name__ == "__main__":
    print("[DIAGNOSE] Start...")
    report, ok = build_report()
    print(report)
    print("\n[DIAGNOSE] Sturen naar Telegram...")
    send_telegram(report)
    print(f"[DIAGNOSE] Klaar. Status: {'OK' if ok else 'PROBLEMEN GEVONDEN'}")
