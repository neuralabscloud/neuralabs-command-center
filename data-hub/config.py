"""
Jarvis — Central Data Hub
De data layer waar alle bots hun marktdata uit halen.
"""
import os

# ── Redis ──────────────────────────────────────────────
REDIS_HOST = "127.0.0.1"
REDIS_PORT = 6379
REDIS_DB   = 0

# ── Hyperliquid ────────────────────────────────────────
TESTNET  = False
BASE_URL = "https://api.hyperliquid-testnet.xyz" if TESTNET else "https://api.hyperliquid.xyz"
WS_URL   = "wss://api.hyperliquid-testnet.xyz/ws" if TESTNET else "wss://api.hyperliquid.xyz/ws"

# ── Assets (unie van alle bots) ────────────────────────
# Bot 1: dynamische discovery (alle perps met spot)
# Bot 2: BTC, ETH
# Bot 3: BTC, ETH
# Bot 4: BTC, ETH, SOL
# Bot 5: BTC, ETH
ASSETS = ["BTC", "ETH", "SOL"]

# ── Wallets per bot ────────────────────────────────────
# Per-wallet data (clearinghouseState, openOrders, etc.)
WALLETS = {
    "funding": os.environ.get("FUNDING_BOT_WALLET_ADDRESS", ""),
    "trend":   os.environ.get("TREND_BOT_WALLET_ADDRESS", ""),
}

# ── Poll intervals (seconden) ─────────────────────────
POLL_ALL_MIDS            = 5     # prijzen voor alle bots
POLL_META_AND_ASSET_CTXS = 30    # funding rates, OI
POLL_META                = 120   # asset metadata
POLL_SPOT_META           = 120   # spot pair listings
POLL_CLEARINGHOUSE       = 10    # account state per wallet
POLL_OPEN_ORDERS         = 10    # open orders per wallet
POLL_CANDLES             = 30    # OHLCV candles per asset
POLL_USER_FUNDING        = 60    # funding payments (bot 1)
POLL_FUNDING_HISTORY     = 300   # funding rate history per asset (elke 5 min)
POLL_USER_FILLS          = 15    # recente fills per wallet
POLL_SPOT_META_CTXS      = 60    # spot meta + asset contexts
POLL_OI_SNAPSHOT         = 30    # OI tijdreeks snapshot

# Candle configuraties die bots nodig hebben
CANDLE_CONFIGS = [
    {"coin": "BTC", "interval": "1h", "count": 200},   # Bot 3 pivot heatmap
    {"coin": "ETH", "interval": "1h", "count": 200},   # Bot 3 pivot heatmap
    {"coin": "BTC", "interval": "5m", "count": 40},    # Bot 4 CVD
    {"coin": "ETH", "interval": "5m", "count": 40},    # Bot 4 CVD
    {"coin": "SOL", "interval": "5m", "count": 40},    # Bot 4 CVD
]

# ── Redis key TTLs (seconden) ─────────────────────────
TTL_ALL_MIDS            = 15
TTL_META_AND_ASSET_CTXS = 60
TTL_META                = 300
TTL_SPOT_META           = 300
TTL_CLEARINGHOUSE       = 15
TTL_OPEN_ORDERS         = 15
TTL_CANDLES             = 60
TTL_USER_FUNDING        = 90
TTL_L2BOOK              = 5
TTL_SPOT_CLEARINGHOUSE  = 30
TTL_FUNDING_HISTORY     = 600
TTL_USER_FILLS          = 30
TTL_SPOT_META_CTXS      = 90

# ── WebSocket ──────────────────────────────────────────
WS_RECONNECT_DELAY     = 5
WS_MAX_RECONNECT_DELAY = 30

# ── Liquidation history ────────────────────────────────
LIQ_HISTORY_MAX = 500  # max events per asset in Redis list
OI_HISTORY_MAX  = 360  # max OI snapshots per asset (= 3 uur bij 30s interval)

# ── Heartbeat ──────────────────────────────────────────
HEARTBEAT_INTERVAL = 5  # seconden

# ── Logging ────────────────────────────────────────────
LOG_FILE  = "logs/data_hub.log"
LOG_LEVEL = "INFO"
