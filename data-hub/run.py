#!/usr/bin/env python3
"""
Jarvis — Central Data Hub

Gebruik:
    python run.py          # start Jarvis
    python run.py --check  # test Redis + API verbinding
    python run.py --status # toon status van alle Redis keys
"""
import sys
import os
from pathlib import Path
from dotenv import load_dotenv
load_dotenv(Path(__file__).resolve().parent.parent / '.env')

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))


def check():
    """Test Redis en Hyperliquid API verbinding."""
    import redis
    import requests
    from config import REDIS_HOST, REDIS_PORT, REDIS_DB, BASE_URL, WALLETS

    print("=== Jarvis — Connection Check ===\n")

    # Redis
    try:
        rdb = redis.Redis(host=REDIS_HOST, port=REDIS_PORT, db=REDIS_DB)
        rdb.ping()
        print("[OK] Redis verbinding")
    except Exception as e:
        print(f"[FOUT] Redis: {e}")

    # Hyperliquid API
    try:
        r = requests.post(f"{BASE_URL}/info", json={"type": "allMids"}, timeout=10)
        r.raise_for_status()
        mids = r.json()
        btc = float(mids.get("BTC", 0))
        print(f"[OK] Hyperliquid API — BTC: ${btc:,.2f}")
    except Exception as e:
        print(f"[FOUT] Hyperliquid API: {e}")

    # Wallets
    print(f"\nGeconfigureerde wallets:")
    for name, addr in WALLETS.items():
        status = "actief" if addr else "niet geconfigureerd"
        display = f"{addr[:10]}...{addr[-6:]}" if addr else "-"
        print(f"  {name}: {display} ({status})")


def status():
    """Toon status van alle Redis keys."""
    import redis
    import msgpack
    from config import REDIS_HOST, REDIS_PORT, REDIS_DB

    rdb = redis.Redis(host=REDIS_HOST, port=REDIS_PORT, db=REDIS_DB, decode_responses=False)

    print("=== Jarvis — Redis Status ===\n")

    # Heartbeat
    hb = rdb.get("hl:hub:heartbeat")
    if hb:
        import time
        age = time.time() - float(hb)
        print(f"Jarvis heartbeat: {age:.1f}s geleden {'[OK]' if age < 20 else '[STALE]'}")
    else:
        print("Jarvis heartbeat: NIET GEVONDEN — Jarvis draait niet?")

    print()

    # Alle hl: keys
    keys = sorted([k.decode() for k in rdb.keys("hl:*")])
    if not keys:
        print("Geen data keys gevonden. Start Jarvis met: python run.py")
        return

    print(f"Totaal {len(keys)} keys:\n")
    for key in keys:
        ttl = rdb.ttl(key)
        key_type = rdb.type(key).decode()
        if key_type == "string":
            size = rdb.strlen(key)
            print(f"  {key:<45} type=string  size={size:>6}B  ttl={ttl}s")
        elif key_type == "list":
            length = rdb.llen(key)
            print(f"  {key:<45} type=list    len={length:>5}     ttl={ttl}s")
        else:
            print(f"  {key:<45} type={key_type:<8}             ttl={ttl}s")


if __name__ == "__main__":
    if "--check" in sys.argv:
        check()
    elif "--status" in sys.argv:
        status()
    else:
        from hub import main
        main()
