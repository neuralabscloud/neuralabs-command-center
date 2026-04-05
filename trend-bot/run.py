#!/usr/bin/env python3
"""
Trend Bot — Mean-Reversion Bot - Entry Point

Gebruik:
    python run.py           Start de bot
    python run.py --check   Test de verbinding en toon indicator data
    python run.py --status  Toon huidige posities en statistieken
"""

import os
import sys
import signal
import atexit
import argparse
import time
import json
import logging
from pathlib import Path
from dotenv import load_dotenv
load_dotenv(Path(__file__).resolve().parent.parent / '.env')

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from config import TESTNET, ASSETS, BASE_URL, WALLET_ADDRESS, ADX_MAX, RSI_OVERSOLD, RSI_OVERBOUGHT
from logger_setup import setup_logger


BOT_DIR  = os.path.dirname(os.path.abspath(__file__))
LOCKFILE = os.path.join(BOT_DIR, ".bot5.lock")
logger = None


def _is_bot5_process(pid: int) -> bool:
    """Check of een PID daadwerkelijk een bot 5 python proces is."""
    try:
        cwd = os.readlink(f"/proc/{pid}/cwd")
        if cwd != BOT_DIR:
            return False
        with open(f"/proc/{pid}/cmdline", "r") as f:
            cmdline = f.read()
        return "python" in cmdline and "run.py" in cmdline
    except (OSError, IOError):
        return False


def acquire_lock():
    """Voorkom dubbele instanties via PID lockfile + cwd verificatie."""
    if os.path.exists(LOCKFILE):
        try:
            with open(LOCKFILE, "r") as f:
                old_pid = int(f.read().strip())
            if _is_bot5_process(old_pid):
                print(f"FOUT: Bot 5 draait al (PID {old_pid}). Stop eerst de andere instantie.")
                return False
            else:
                print(f"Stale lockfile gevonden (PID {old_pid} draait niet meer), wordt overschreven")
        except (ValueError, FileNotFoundError):
            print("Ongeldige lockfile gevonden, wordt overschreven")

    with open(LOCKFILE, "w") as f:
        f.write(str(os.getpid()))
    atexit.register(release_lock)

    def _signal_handler(signum, frame):
        release_lock()
        sys.exit(0)
    signal.signal(signal.SIGTERM, _signal_handler)
    signal.signal(signal.SIGINT, _signal_handler)
    return True


def release_lock():
    """Verwijder lockfile bij afsluiten."""
    try:
        if os.path.exists(LOCKFILE):
            with open(LOCKFILE, "r") as f:
                pid = int(f.read().strip())
            if pid == os.getpid():
                os.remove(LOCKFILE)
    except Exception:
        pass


def mode_check():
    """Test modus: verbinding testen en indicator data tonen."""
    from mean_reversion_engine import MeanReversionEngine

    print("=== Mean-Reversion Bot - Verbindingstest ===")
    print("Netwerk: %s" % ("TESTNET" if TESTNET else "MAINNET"))
    print("URL: %s" % BASE_URL)
    print()

    engine = MeanReversionEngine()

    for asset in ASSETS:
        ind = engine.get_indicators(asset)
        if ind:
            dist_upper = (ind["bb_upper"] - ind["price"]) / ind["price"] * 100
            dist_lower = (ind["price"] - ind["bb_lower"]) / ind["price"] * 100
            market = "RANGE" if ind["adx"] < ADX_MAX else "TRENDING"

            print("--- %s ---" % asset)
            print("  Prijs:     $%.2f" % ind["price"])
            print("  BB Upper:  $%.2f (+%.2f%%)" % (ind["bb_upper"], dist_upper))
            print("  BB Midden: $%.2f" % ind["bb_middle"])
            print("  BB Lower:  $%.2f (-%.2f%%)" % (ind["bb_lower"], dist_lower))
            print("  BB Breedte: %.2f%%" % ind["bb_width_pct"])
            print("  RSI:       %.1f  %s" % (ind["rsi"],
                  "(OVERSOLD)" if ind["rsi"] < RSI_OVERSOLD else
                  "(OVERBOUGHT)" if ind["rsi"] > RSI_OVERBOUGHT else ""))
            print("  ADX:       %.1f  (%s)" % (ind["adx"], market))
            print()
        else:
            print("--- %s --- Geen data" % asset)
            print()

    print("Test voltooid.")


def mode_status():
    """Status modus: toon huidige posities en statistieken."""
    import requests

    print("=== Mean-Reversion Bot - Status ===")
    print("Netwerk: %s" % ("TESTNET" if TESTNET else "MAINNET"))
    print()

    try:
        url = "%s/info" % BASE_URL
        resp = requests.post(url, json={
            "type": "clearinghouseState",
            "user": WALLET_ADDRESS,
        }, timeout=10)
        data = resp.json()

        positions = data.get("assetPositions", [])
        if positions:
            print("Open posities:")
            for p in positions:
                pos = p.get("position", {})
                coin = pos.get("coin", "?")
                szi = float(pos.get("szi", 0))
                entry_px = float(pos.get("entryPx", 0))
                unrealized = float(pos.get("unrealizedPnl", 0))
                if szi != 0:
                    direction = "LONG" if szi > 0 else "SHORT"
                    print("  %s %s | Grootte: %.6f | Entry: $%.2f | uPnL: $%.2f"
                          % (direction, coin, abs(szi), entry_px, unrealized))
        else:
            print("Geen open posities.")
    except Exception as e:
        print("Fout bij ophalen posities: %s" % e)

    print()

    from config import DATA_FILE
    if os.path.exists(DATA_FILE):
        try:
            with open(DATA_FILE, "r") as f:
                trades = json.load(f)
            if trades:
                total_pnl = sum(t.get("pnl", 0) for t in trades)
                wins = sum(1 for t in trades if t.get("pnl", 0) >= 0)
                print("Trade geschiedenis: %d trades | Wins: %d | Totaal PnL: $%.2f"
                      % (len(trades), wins, total_pnl))
                print("\nLaatste trades:")
                for t in trades[-5:]:
                    pnl_sign = "+" if t.get("pnl", 0) >= 0 else ""
                    print("  %s %s | PnL: $%s%.2f | %s | %s"
                          % (t.get("direction", "?"), t.get("asset", "?"),
                             pnl_sign, t.get("pnl", 0),
                             t.get("reason_close", "?"), t.get("dt", "?")))
            else:
                print("Geen trade geschiedenis.")
        except Exception as e:
            print("Fout bij laden trade geschiedenis: %s" % e)
    else:
        print("Geen trade geschiedenis bestand gevonden.")


def mode_run():
    """Start de bot in productie modus."""
    from mean_reversion_bot import MeanReversionBot

    if not TESTNET:
        print("WAARSCHUWING: Je staat op het punt de bot te starten op MAINNET!")
        print("Typ 'BEVESTIG' om door te gaan:")
        confirm = input("> ").strip()
        if confirm != "BEVESTIG":
            print("Afgebroken.")
            return

    if not acquire_lock():
        return

    try:
        logger.info("=" * 60)
        logger.info("MEAN-REVERSION BOT - BOT 5 GESTART")
        logger.info("Netwerk: %s", "TESTNET" if TESTNET else "MAINNET")
        logger.info("Assets: %s", ", ".join(ASSETS))
        logger.info("=" * 60)

        bot = MeanReversionBot()
        bot.run()

    except Exception as e:
        logger.critical("Fatale fout: %s", e, exc_info=True)
    finally:
        release_lock()
        logger.info("Bot gestopt.")


def main():
    global logger

    parser = argparse.ArgumentParser(
        description="Trend Bot — Mean-Reversion Bot"
    )
    parser.add_argument("--check", action="store_true", help="Test verbinding en toon indicators")
    parser.add_argument("--status", action="store_true", help="Toon posities en statistieken")
    args = parser.parse_args()

    logger = setup_logger()

    if args.check:
        mode_check()
    elif args.status:
        mode_status()
    else:
        mode_run()


if __name__ == "__main__":
    main()
