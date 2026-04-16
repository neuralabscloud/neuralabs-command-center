import sys
import os
import signal
import atexit
import argparse
from logger_setup import setup_logger
from config import PRIVATE_KEY, WALLET_ADDRESS, TESTNET

logger = setup_logger()

BOT_DIR  = os.path.dirname(os.path.abspath(__file__))
LOCKFILE = os.path.join(BOT_DIR, ".bot1.lock")


def _is_this_bot_process(pid: int) -> bool:
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
    if os.path.exists(LOCKFILE):
        try:
            with open(LOCKFILE, "r") as f:
                old_pid = int(f.read().strip())
            if _is_this_bot_process(old_pid):
                logger.error(f"Bot 1 draait al (PID {old_pid}). Stop eerst de andere instantie.")
                sys.exit(1)
            else:
                logger.warning(f"Stale lockfile gevonden (PID {old_pid}), wordt overschreven")
        except (ValueError, FileNotFoundError):
            logger.warning("Ongeldige lockfile gevonden, wordt overschreven")
    with open(LOCKFILE, "w") as f:
        f.write(str(os.getpid()))
    atexit.register(release_lock)
    def _signal_handler(signum, frame):
        release_lock()
        sys.exit(0)
    signal.signal(signal.SIGTERM, _signal_handler)
    signal.signal(signal.SIGINT,  _signal_handler)


def release_lock():
    try:
        if os.path.exists(LOCKFILE):
            with open(LOCKFILE, "r") as f:
                pid = int(f.read().strip())
            if pid == os.getpid():
                os.remove(LOCKFILE)
    except Exception:
        pass

def validate_config():
    errors = []
    if PRIVATE_KEY == "0xYOUR_PRIVATE_KEY_HERE":
        errors.append("PRIVATE_KEY niet ingevuld in config.py")
    if WALLET_ADDRESS == "0xYOUR_WALLET_ADDRESS_HERE":
        errors.append("WALLET_ADDRESS niet ingevuld in config.py")
    return errors

def check_mode():
    errors = validate_config()
    if errors:
        for e in errors:
            logger.error(e)
        return
    from funding_bot import FundingArbitrageBot
    bot = FundingArbitrageBot()
    rates = bot.get_funding_rates()
    if rates:
        logger.info("-" * 50)
        logger.info("HUIDIGE FUNDING RATES (annualized)")
        for asset, info in sorted(rates.items(), key=lambda x: abs(x[1]["rate"]), reverse=True):
            rate = info["rate"]
            oi = info["oi_usd"]
            oi_str = f"${oi/1e6:.1f}M" if oi >= 1e6 else f"${oi/1e3:.0f}K"
            flag = ">>> ENTRY SIGNAAL" if rate >= 8 else "(negatief, niet tradeable)" if rate <= -8 else ""
            logger.info(f"  {asset:<8} {rate:+8.2f}%  OI {oi_str:>8}  {flag}")
        logger.info("-" * 50)
    logger.info(f"Account balans: ${bot.get_account_balance():.2f}")
    logger.info("Connectie check geslaagd")

def main():
    parser = argparse.ArgumentParser(description="NeuraLabs Funding Rate Arbitrage Bot")
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--status", action="store_true")
    args = parser.parse_args()
    if args.check:
        check_mode()
        return
    errors = validate_config()
    if errors:
        for e in errors:
            logger.error(e)
        logger.error("Vul je config.py in voor je de bot start!")
        sys.exit(1)
    acquire_lock()

    if not TESTNET:
        confirm = input("Type 'BEVESTIG' voor mainnet: ")
        if confirm != "BEVESTIG":
            sys.exit(0)
    from funding_bot import FundingArbitrageBot
    bot = FundingArbitrageBot()
    bot.run()

if __name__ == "__main__":
    main()
