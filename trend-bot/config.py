import os

PRIVATE_KEY = os.environ["TREND_BOT_PRIVATE_KEY"]
WALLET_ADDRESS = os.environ["TREND_BOT_WALLET_ADDRESS"]

TESTNET = False

ASSETS = ["BTC", "ETH", "SOL", "BNB", "HYPE", "XRP", "AAVE", "ADA", "WLD"]
LEVERAGE = 5
POSITION_SIZE_PCT = 0.15   # 15% van account per trade

# Mean-reversion signaal parameters (15m candles)
CANDLE_INTERVAL = "15m"
CANDLE_LOOKBACK = 100          # candles ophalen voor indicator berekening

# Bollinger Bands
BB_PERIOD = 20                 # SMA periode
BB_STD = 2.0                   # standaard deviaties

# RSI
RSI_PERIOD = 14
RSI_OVERSOLD = 30              # RSI < 30 = oversold (LONG signaal)
RSI_OVERBOUGHT = 70            # RSI > 70 = overbought (SHORT signaal)

# ADX — alleen handelen in RANGE (niet trending)
ADX_PERIOD = 14
ADX_MAX = 25                   # ADX < 25 = range-bound markt (verhoogd van 22 — te veel signalen geblokkeerd)

# Exit parameters — strakke exits, mean-reversion is snel
TAKE_PROFIT_PCT = 1.2          # 1.2% vaste TP (verhoogd van 0.8% — betere R:R ratio)
STOP_LOSS_PCT = 0.65           # 0.65% SL (verruimd van 0.5% — meer ruimte voor reversion)
TRAILING_STOP_ENABLED = True
TRAILING_STOP_ACTIVATION_PCT = 0.3   # activeer na 0.3% winst (verlaagd van 0.4% — sneller beschermen)
TRAILING_STOP_DISTANCE_PCT = 0.2     # volg op 0.2% afstand (aangescherpt van 0.25% — minder winst weggeven)

# Positie management
MAX_HOLD_SECONDS = 7200        # max 2 uur houden (MR moet snel zijn)
COOLDOWN_SECONDS = 900         # 15 min cooldown na sluiting
SCAN_INTERVAL = 60             # elke 60 seconden scannen

# Risk management
MAX_DAILY_LOSS_PCT = 3.0       # 3% dagverlies = kill switch (conservatiever voor MR)
MAX_DRAWDOWN_PCT = 8.0
MAX_TRADES_PER_DAY = 8         # max 8 trades per dag

# Telegram
TELEGRAM_BOT_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "")
TELEGRAM_CHAT_ID = os.environ.get("TELEGRAM_CHAT_ID", "")
TELEGRAM_ENABLED = bool(TELEGRAM_BOT_TOKEN)

BASE_URL = "https://api.hyperliquid-testnet.xyz" if TESTNET else "https://api.hyperliquid.xyz"
WS_URL = "wss://api.hyperliquid-testnet.xyz/ws" if TESTNET else "wss://api.hyperliquid.xyz/ws"

LOG_FILE = "logs/mean_reversion_bot.log"
DATA_FILE = "data/trade_history.json"

# Tick sizes per asset
TICK_SIZES = {
    "BTC": 1.0,
    "ETH": 0.1,
    "SOL": 0.01,
    "BNB": 0.1,
    "HYPE": 0.01,
    "XRP": 0.0001,
    "AAVE": 0.01,
    "ADA": 0.0001,
    "WLD": 0.0001,
}

# Size decimals per asset
SZ_DECIMALS = {
    "BTC": 5,
    "ETH": 4,
    "SOL": 2,
    "BNB": 3,
    "HYPE": 2,
    "XRP": 0,
    "AAVE": 2,
    "ADA": 0,
    "WLD": 1,
}
