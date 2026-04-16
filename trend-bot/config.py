import os

PRIVATE_KEY = os.getenv("HL_PRIVATE_KEY_BOT5", "")
WALLET_ADDRESS = os.getenv("HL_WALLET_ADDRESS_BOT5", "")

TESTNET = False

ASSETS = ["BTC", "ETH", "SOL", "BNB", "HYPE", "XRP", "AAVE", "ADA", "WLD", "DOGE", "AVAX", "SUI", "LINK"]
LEVERAGE = 7
POSITION_SIZE_PCT = 0.11   # 11% van account per trade (verlaagd van 15% — compenseert hogere leverage)

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

# BTC regime filter — blokkeer mean-reversion shorts/longs tegen een sterke BTC beweging
# 3 correlated SHORTS op 2026-04-11 stopped tijdens BTC rally +0.8%/uur — deze filter fixt dat
BTC_REGIME_ENABLED = True
BTC_REGIME_LOOKBACK_CANDLES = 4   # 4 x 15m = laatste uur
BTC_REGIME_THRESHOLD_PCT = 0.5    # > +0.5% = shorts blokkeren, < -0.5% = longs blokkeren

# Telegram
TELEGRAM_ENABLED = False
TELEGRAM_BOT_TOKEN = ""
TELEGRAM_CHAT_ID = ""

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
    "DOGE": 0.000001,
    "AVAX": 0.0001,
    "SUI": 0.00001,
    "LINK": 0.0001,
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
    "DOGE": 0,
    "AVAX": 2,
    "SUI": 1,
    "LINK": 1,
}
