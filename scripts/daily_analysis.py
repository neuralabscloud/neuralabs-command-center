#!/usr/bin/env python3
"""
daily_analysis.py - Dagelijkse performance analyse van alle NeuraLabs bots.
Analyseert trades, PnL, winrate, en key metrics per bot.
Stuurt rapport naar Telegram.

Gebruik:
  python3 /root/daily_analysis.py
"""

import json
import os
import requests
import html
from datetime import datetime, timezone, timedelta
from pathlib import Path
from collections import defaultdict

# ─── CONFIG ──────────────────────────────────────────────────────────────────

INSTALL_DIR = os.getenv("INSTALL_DIR", "/opt/commandcenter")

TELEGRAM_TOKEN   = os.getenv("TELEGRAM_BOT_TOKEN", "")
TELEGRAM_CHAT_ID = os.getenv("TELEGRAM_CHAT_ID", "")

HL_API = "https://api.hyperliquid.xyz/info"

WALLETS = {
    "Funding Bot":    os.getenv("HL_WALLET_ADDRESS_BOT1", ""),
    "Trend Bot":      os.getenv("HL_WALLET_ADDRESS_BOT5", ""),
}

TRADE_FILES = {
    "Funding Bot":     f"{INSTALL_DIR}/funding-bot/data/trade_history.json",
    "Trend Bot":       f"{INSTALL_DIR}/trend-bot/data/trade_history.json",
}


# ─── TELEGRAM ────────────────────────────────────────────────────────────────

def send_telegram(text: str):
    url = f"https://api.telegram.org/bot{TELEGRAM_TOKEN}/sendMessage"
    # Split long messages (Telegram max 4096 chars)
    chunks = [text[i:i+4000] for i in range(0, len(text), 4000)]
    for chunk in chunks:
        try:
            r = requests.post(url, json={
                "chat_id": TELEGRAM_CHAT_ID,
                "text": chunk,
                "parse_mode": "HTML",
                "disable_web_page_preview": True,
            }, timeout=15)
            if r.status_code != 200:
                print(f"[TG] Fout: {r.text}")
        except Exception as e:
            print(f"[TG] Kon bericht niet sturen: {e}")


# ─── HELPERS ─────────────────────────────────────────────────────────────────

def hl_post(payload: dict) -> dict:
    r = requests.post(HL_API, json=payload, timeout=10)
    r.raise_for_status()
    return r.json()


def get_equity(wallet: str) -> float:
    try:
        perp = hl_post({"type": "clearinghouseState", "user": wallet})
        perp_val = float(perp.get("marginSummary", {}).get("accountValue", 0))
        spot = hl_post({"type": "spotClearinghouseState", "user": wallet})
        spot_val = sum(
            float(b.get("total", 0)) for b in spot.get("balances", [])
            if b.get("coin") == "USDC"
        )
        return perp_val + spot_val
    except Exception:
        return 0.0


def get_open_positions(wallet: str) -> list:
    try:
        state = hl_post({"type": "clearinghouseState", "user": wallet})
        positions = []
        for ap in state.get("assetPositions", []):
            pos = ap.get("position", {})
            size = float(pos.get("szi", 0))
            if abs(size) > 0:
                positions.append({
                    "coin": pos.get("coin", "?"),
                    "size": size,
                    "entry": float(pos.get("entryPx", 0)),
                    "upnl": float(pos.get("unrealizedPnl", 0)),
                })
        return positions
    except Exception:
        return []


def load_trades(filepath: str) -> list:
    if not os.path.exists(filepath):
        return []
    try:
        with open(filepath) as f:
            return json.load(f)
    except Exception:
        return []


# ─── BOT ANALYZERS ──────────────────────────────────────────────────────────

def analyze_funding_bot(trades: list, today: str, yesterday: str) -> dict:
    """Analyze funding bot trades."""
    total_pnl = sum(t.get("total_pnl", 0) for t in trades)
    funding = sum(t.get("funding_collected", 0) for t in trades)
    today_trades = [t for t in trades if t.get("closed_at", "").startswith(today)]
    yesterday_trades = [t for t in trades if t.get("closed_at", "").startswith(yesterday)]
    today_pnl = sum(t.get("total_pnl", 0) for t in today_trades)
    yesterday_pnl = sum(t.get("total_pnl", 0) for t in yesterday_trades)

    return {
        "total_trades": len(trades),
        "total_pnl": total_pnl,
        "funding_collected": funding,
        "today_trades": len(today_trades),
        "today_pnl": today_pnl,
        "yesterday_trades": len(yesterday_trades),
        "yesterday_pnl": yesterday_pnl,
    }


def analyze_directional_bot(trades: list, today: str, yesterday: str) -> dict:
    """Analyze bot 3 (liq) or bot 5 (trend) - standard trade format."""
    total_pnl = sum(t.get("total_pnl", t.get("pnl_usd", 0)) for t in trades)
    wins = sum(1 for t in trades if t.get("total_pnl", t.get("pnl_usd", 0)) > 0)
    losses = len(trades) - wins

    # Per exit reason
    reasons = defaultdict(lambda: {"count": 0, "pnl": 0})
    for t in trades:
        r = t.get("close_reason", t.get("reason", "unknown"))
        if "Trailing" in r:
            r = "Trailing stop"
        elif "TAKE PROFIT" in r or "Take-Profit" in r:
            r = "Take Profit"
        elif "STOP LOSS" in r or "Stop-Loss" in r:
            r = "Stop Loss"
        elif "TP/SL" in r:
            r = "TP/SL trigger"
        pnl = t.get("total_pnl", t.get("pnl_usd", 0))
        reasons[r]["count"] += 1
        reasons[r]["pnl"] += pnl

    close_field = "closed_at"
    today_trades = [t for t in trades if t.get(close_field, "").startswith(today)]
    yesterday_trades = [t for t in trades if t.get(close_field, "").startswith(yesterday)]
    today_pnl = sum(t.get("total_pnl", t.get("pnl_usd", 0)) for t in today_trades)
    yesterday_pnl = sum(t.get("total_pnl", t.get("pnl_usd", 0)) for t in yesterday_trades)

    avg_win = sum(t.get("total_pnl", t.get("pnl_usd", 0)) for t in trades if t.get("total_pnl", t.get("pnl_usd", 0)) > 0) / wins if wins else 0
    avg_loss = sum(t.get("total_pnl", t.get("pnl_usd", 0)) for t in trades if t.get("total_pnl", t.get("pnl_usd", 0)) <= 0) / losses if losses else 0

    return {
        "total_trades": len(trades),
        "total_pnl": total_pnl,
        "wins": wins,
        "losses": losses,
        "winrate": (wins / len(trades) * 100) if trades else 0,
        "avg_win": avg_win,
        "avg_loss": avg_loss,
        "rr_ratio": abs(avg_win / avg_loss) if avg_loss else 0,
        "today_trades": len(today_trades),
        "today_pnl": today_pnl,
        "yesterday_trades": len(yesterday_trades),
        "yesterday_pnl": yesterday_pnl,
        "exit_reasons": dict(reasons),
    }


# ─── REPORT BUILDER ─────────────────────────────────────────────────────────

def build_report() -> str:
    now = datetime.now(timezone.utc)
    today = now.strftime("%Y-%m-%d")
    yesterday = (now - timedelta(days=1)).strftime("%Y-%m-%d")
    timestamp = now.strftime("%d-%m-%Y %H:%M UTC")

    lines = [
        f"<b>📊 DAGELIJKSE BOT ANALYSE</b>",
        f"<i>{timestamp}</i>",
        "",
    ]

    total_equity = 0
    total_pnl_today = 0
    total_pnl_all = 0

    # ── Bot 1: Funding ──
    equity = get_equity(WALLETS["Funding Bot"])
    total_equity += equity
    trades = load_trades(TRADE_FILES["Funding Bot"])
    stats = analyze_funding_bot(trades, today, yesterday)
    total_pnl_all += stats["total_pnl"]
    total_pnl_today += stats["today_pnl"]
    positions = get_open_positions(WALLETS["Funding Bot"])

    lines.append(f"<b>1. Funding Bot</b>")
    lines.append(f"  Equity: ${equity:,.2f}")
    lines.append(f"  Trades: {stats['total_trades']} | PnL: ${stats['total_pnl']:+.2f}")
    lines.append(f"  Funding: ${stats['funding_collected']:+.4f}")
    if stats["yesterday_trades"]:
        lines.append(f"  Gisteren: {stats['yesterday_trades']} trades | ${stats['yesterday_pnl']:+.2f}")
    if stats["today_trades"]:
        lines.append(f"  Vandaag: {stats['today_trades']} trades | ${stats['today_pnl']:+.2f}")
    if not stats["today_trades"] and not stats["yesterday_trades"]:
        lines.append(f"  Geen recente trades (wacht op opportunities)")
    if positions:
        for p in positions:
            d = "LONG" if p["size"] > 0 else "SHORT"
            lines.append(f"  Open: {d} {p['coin']} | uPnL: ${p['upnl']:+.2f}")
    lines.append("")

    # ── Bot 5: Trend ──
    equity = get_equity(WALLETS["Trend Bot"])
    total_equity += equity
    trades = load_trades(TRADE_FILES["Trend Bot"])
    stats = analyze_directional_bot(trades, today, yesterday)
    total_pnl_all += stats["total_pnl"]
    total_pnl_today += stats["today_pnl"]
    positions = get_open_positions(WALLETS["Trend Bot"])

    lines.append(f"<b>5. Trend Bot</b>")
    lines.append(f"  Equity: ${equity:,.2f}")
    lines.append(f"  Trades: {stats['total_trades']} | WR: {stats['winrate']:.0f}% | R:R: {stats['rr_ratio']:.2f}")
    lines.append(f"  PnL: ${stats['total_pnl']:+.2f} | EV/trade: ${stats['total_pnl']/stats['total_trades']:+.4f}" if stats["total_trades"] else "  Geen trades")
    if stats["yesterday_trades"]:
        lines.append(f"  Gisteren: {stats['yesterday_trades']} trades | ${stats['yesterday_pnl']:+.2f}")
    if stats["today_trades"]:
        lines.append(f"  Vandaag: {stats['today_trades']} trades | ${stats['today_pnl']:+.2f}")
    if stats.get("exit_reasons"):
        top = sorted(stats["exit_reasons"].items(), key=lambda x: -x[1]["count"])[:3]
        reasons_str = " | ".join(f"{r}: {v['count']}x ${v['pnl']:+.2f}" for r, v in top)
        lines.append(f"  Exits: {reasons_str}")
    if positions:
        for p in positions:
            d = "LONG" if p["size"] > 0 else "SHORT"
            lines.append(f"  Open: {d} {p['coin']} | uPnL: ${p['upnl']:+.2f}")
    lines.append("")

    # ── Totaal ──
    lines.append("━" * 28)
    lines.append(f"<b>TOTAAL</b>")
    lines.append(f"  Equity: ${total_equity:,.2f}")
    lines.append(f"  PnL totaal: ${total_pnl_all:+.2f}")
    if total_pnl_today != 0:
        lines.append(f"  PnL vandaag: ${total_pnl_today:+.2f}")

    return "\n".join(lines)


# ─── ENTRY POINT ─────────────────────────────────────────────────────────────

if __name__ == "__main__":
    print("[ANALYSE] Start...")
    report = build_report()
    print(report)
    print("\n[ANALYSE] Sturen naar Telegram...")
    send_telegram(report)
    print("[ANALYSE] Klaar.")
