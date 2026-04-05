import os

PRIVATE_KEY = os.environ["FUNDING_BOT_PRIVATE_KEY"]
WALLET_ADDRESS = os.environ["FUNDING_BOT_WALLET_ADDRESS"]

TESTNET = False
BASE_URL = "https://api.hyperliquid-testnet.xyz" if TESTNET else "https://api.hyperliquid.xyz"

# Dynamische asset discovery: bot scant ALLE perp coins met een spot pair op HL.
# Geen hardcoded lijst meer — de bot ontdekt automatisch welke coins
# een perp markt EN een spot equivalent (U-token of direct) hebben.
# Fallback voor als discovery faalt:
FALLBACK_SPOT_PAIR = {
    "BTC": "@142",
    "ETH": "@151",
    "SOL": "@156",
}

FUNDING_ENTRY_THRESHOLD = 8.0    # % annualized, minimale funding rate om in te stappen
FUNDING_EXIT_THRESHOLD  = 4.0    # % annualized, sluit positie als funding hieronder zakt
FUNDING_SCAN_INTERVAL   = 60     # seconden tussen scans

# Min OI in USD — filter illiquide coins die moeilijk in/uit te stappen zijn
MIN_OPEN_INTEREST_USD = 1_000_000

POSITION_SIZE_PCT  = 0.25  # 25% van balance per positie (perp + spot elk ~25%)
MAX_OPEN_POSITIONS = 3     # max 3 paren tegelijk = max 75% ingezet
MAX_LEVERAGE       = 1     # altijd 1x leverage op perp (delta-neutraal vereist dit)

MAX_DAILY_LOSS_PCT = 0.10   # kill switch bij 10% dagverlies (schaalt mee met account)
MAX_DRAWDOWN_PCT   = 10.0

TELEGRAM_BOT_TOKEN  = os.environ.get("TELEGRAM_BOT_TOKEN", "")
TELEGRAM_CHAT_ID    = os.environ.get("TELEGRAM_CHAT_ID", "")
TELEGRAM_ENABLED    = bool(TELEGRAM_BOT_TOKEN)

LOG_LEVEL = "INFO"
LOG_FILE  = "logs/funding_bot.log"
DATA_FILE = "data/trade_history.json"
