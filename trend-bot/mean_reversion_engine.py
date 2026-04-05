"""
Mean-Reversion Engine voor Bot 5 — Bollinger Band + RSI strategie.

Signalen op 15m candles:
  LONG:  Prijs <= lower BB + RSI < 30 + ADX < 25
  SHORT: Prijs >= upper BB + RSI > 70 + ADX < 25

Complementair aan Bot 3 (liquidation): handelt alleen in range-bound markten
waar Bot 3 stil zit.
"""

import time
import math
import logging
from dataclasses import dataclass
from typing import Optional

from config import (
    BASE_URL, WALLET_ADDRESS,
    CANDLE_INTERVAL, CANDLE_LOOKBACK,
    BB_PERIOD, BB_STD,
    RSI_PERIOD, RSI_OVERSOLD, RSI_OVERBOUGHT,
    ADX_PERIOD, ADX_MAX,
)

logger = logging.getLogger("MeanRevBot")

# Data client (centraal via Redis, fallback naar directe API)
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "data-hub"))
from client import HLDataClient as _HLDataClient
_data_client = _HLDataClient(wallet_address=WALLET_ADDRESS, base_url=BASE_URL)


@dataclass
class MRSignal:
    asset: str
    direction: str        # "LONG" | "SHORT"
    bb_upper: float
    bb_middle: float
    bb_lower: float
    rsi: float
    adx: float
    price: float
    bb_width_pct: float   # bandbreedte in %
    reason: str


def _sma(prices, period):
    """Bereken Simple Moving Average."""
    if len(prices) < period:
        return []
    result = []
    for i in range(period - 1, len(prices)):
        result.append(sum(prices[i - period + 1:i + 1]) / period)
    return result


def _std(prices, period):
    """Bereken standaard deviatie (rolling)."""
    if len(prices) < period:
        return []
    result = []
    for i in range(period - 1, len(prices)):
        window = prices[i - period + 1:i + 1]
        mean = sum(window) / period
        variance = sum((x - mean) ** 2 for x in window) / period
        result.append(math.sqrt(variance))
    return result


def _rsi(prices, period):
    """Bereken RSI voor een lijst van prijzen."""
    if len(prices) < period + 1:
        return []

    deltas = [prices[i + 1] - prices[i] for i in range(len(prices) - 1)]
    gains = [max(d, 0) for d in deltas]
    losses = [abs(min(d, 0)) for d in deltas]

    avg_gain = sum(gains[:period]) / period
    avg_loss = sum(losses[:period]) / period

    result = []
    for i in range(period, len(deltas)):
        if avg_loss == 0:
            result.append(100.0)
        else:
            rs = avg_gain / avg_loss
            result.append(100.0 - (100.0 / (1.0 + rs)))
        avg_gain = (avg_gain * (period - 1) + gains[i]) / period
        avg_loss = (avg_loss * (period - 1) + losses[i]) / period

    # Laatste waarde
    if avg_loss == 0:
        result.append(100.0)
    else:
        rs = avg_gain / avg_loss
        result.append(100.0 - (100.0 / (1.0 + rs)))

    return result


def _adx(highs, lows, closes, period):
    """Bereken ADX voor een lijst van OHLC data."""
    if len(closes) < period * 2 + 1:
        return []

    tr_list = []
    plus_dm_list = []
    minus_dm_list = []

    for i in range(1, len(closes)):
        high_diff = highs[i] - highs[i - 1]
        low_diff = lows[i - 1] - lows[i]

        plus_dm = high_diff if high_diff > low_diff and high_diff > 0 else 0
        minus_dm = low_diff if low_diff > high_diff and low_diff > 0 else 0

        tr = max(
            highs[i] - lows[i],
            abs(highs[i] - closes[i - 1]),
            abs(lows[i] - closes[i - 1]),
        )
        tr_list.append(tr)
        plus_dm_list.append(plus_dm)
        minus_dm_list.append(minus_dm)

    if len(tr_list) < period * 2:
        return []

    # Smoothed TR, +DM, -DM (Wilder's smoothing)
    atr = sum(tr_list[:period])
    plus_dm_smooth = sum(plus_dm_list[:period])
    minus_dm_smooth = sum(minus_dm_list[:period])

    dx_list = []

    for i in range(period, len(tr_list)):
        atr = atr - (atr / period) + tr_list[i]
        plus_dm_smooth = plus_dm_smooth - (plus_dm_smooth / period) + plus_dm_list[i]
        minus_dm_smooth = minus_dm_smooth - (minus_dm_smooth / period) + minus_dm_list[i]

        if atr == 0:
            dx_list.append(0)
            continue

        plus_di = 100 * plus_dm_smooth / atr
        minus_di = 100 * minus_dm_smooth / atr
        di_sum = plus_di + minus_di

        if di_sum == 0:
            dx_list.append(0)
        else:
            dx_list.append(100 * abs(plus_di - minus_di) / di_sum)

    if len(dx_list) < period:
        return []

    # ADX = smoothed DX
    adx_val = sum(dx_list[:period]) / period
    result = [adx_val]
    for i in range(period, len(dx_list)):
        adx_val = (adx_val * (period - 1) + dx_list[i]) / period
        result.append(adx_val)

    return result


class MeanReversionEngine:
    """Genereert mean-reversion signalen op basis van Bollinger Bands + RSI + ADX."""

    def __init__(self):
        self._cache = {}            # asset -> {"data": ..., "ts": float}
        self._cache_ttl = 55        # cache candle data 55 seconden
        self._last_block_log = {}   # asset -> timestamp, voorkom spam

    def _fetch_candles(self, asset):
        """Haal candle data op via data client (met cache)."""
        cached = self._cache.get(asset)
        if cached and (time.time() - cached["ts"]) < self._cache_ttl:
            return cached["data"]

        try:
            end_ms = int(time.time() * 1000)
            interval_ms = 15 * 60 * 1000  # 15 minuten
            start_ms = end_ms - CANDLE_LOOKBACK * interval_ms * 2

            payload = {
                "type": "candleSnapshot",
                "req": {
                    "coin": asset,
                    "interval": CANDLE_INTERVAL,
                    "startTime": start_ms,
                    "endTime": end_ms,
                },
            }
            candles = _data_client.info_post(payload)
            if candles:
                candles = candles[-CANDLE_LOOKBACK:]
                self._cache[asset] = {"data": candles, "ts": time.time()}
                return candles
        except Exception as e:
            logger.error("Candle data ophalen mislukt voor %s: %s", asset, e)

        return None

    def _compute_indicators(self, candles):
        """Bereken alle indicators uit candle data."""
        min_needed = max(BB_PERIOD, RSI_PERIOD, ADX_PERIOD * 2) + 5
        if not candles or len(candles) < min_needed:
            return None

        closes = [float(c["c"]) for c in candles]
        highs = [float(c["h"]) for c in candles]
        lows = [float(c["l"]) for c in candles]

        sma_vals = _sma(closes, BB_PERIOD)
        std_vals = _std(closes, BB_PERIOD)
        rsi_vals = _rsi(closes, RSI_PERIOD)
        adx_vals = _adx(highs, lows, closes, ADX_PERIOD)

        if not sma_vals or not std_vals or not rsi_vals or not adx_vals:
            return None

        bb_middle = sma_vals[-1]
        bb_std = std_vals[-1]
        bb_upper = bb_middle + BB_STD * bb_std
        bb_lower = bb_middle - BB_STD * bb_std

        # Bandbreedte als percentage van midden
        bb_width_pct = (bb_upper - bb_lower) / bb_middle * 100 if bb_middle > 0 else 0

        return {
            "price": closes[-1],
            "bb_upper": bb_upper,
            "bb_middle": bb_middle,
            "bb_lower": bb_lower,
            "bb_width_pct": bb_width_pct,
            "rsi": rsi_vals[-1],
            "adx": adx_vals[-1],
        }

    def check_signal(self, asset) -> Optional[MRSignal]:
        """
        Controleer of er een mean-reversion signaal is voor het asset.

        Signaal vereist:
        1. Prijs raakt Bollinger Band (upper of lower)
        2. RSI bevestiging (< 30 oversold, > 70 overbought)
        3. ADX < 25 (range-bound markt, geen sterke trend)
        """
        candles = self._fetch_candles(asset)
        if not candles:
            return None

        ind = self._compute_indicators(candles)
        if not ind:
            return None

        price = ind["price"]

        # ADX filter: alleen range-bound markten
        if ind["adx"] >= ADX_MAX:
            block_key = f"{asset}_ADX"
            last_log = self._last_block_log.get(block_key, 0)
            if time.time() - last_log > 300:
                logger.info(
                    "%s: MR signaal geblokkeerd — ADX %.1f >= %d (trending, bot 3 territorium)",
                    asset, ind["adx"], ADX_MAX,
                )
                self._last_block_log[block_key] = time.time()
            return None

        # Minimale bandbreedte: te smalle bands = geen volatiliteit = geen edge
        if ind["bb_width_pct"] < 0.3:
            return None

        signal_dir = None

        # LONG: prijs <= lower band + RSI oversold
        if price <= ind["bb_lower"] and ind["rsi"] <= RSI_OVERSOLD:
            signal_dir = "LONG"

        # SHORT: prijs >= upper band + RSI overbought
        elif price >= ind["bb_upper"] and ind["rsi"] >= RSI_OVERBOUGHT:
            signal_dir = "SHORT"

        if signal_dir is None:
            return None

        reason = (
            f"BB({BB_PERIOD},{BB_STD}) {signal_dir}"
            f" | Prijs={'<= LB' if signal_dir == 'LONG' else '>= UB'}"
            f" | RSI={ind['rsi']:.1f}"
            f" | ADX={ind['adx']:.1f}"
            f" | BB-breedte={ind['bb_width_pct']:.2f}%"
        )
        logger.info("%s: SIGNAAL %s — %s", asset, signal_dir, reason)

        return MRSignal(
            asset=asset,
            direction=signal_dir,
            bb_upper=ind["bb_upper"],
            bb_middle=ind["bb_middle"],
            bb_lower=ind["bb_lower"],
            rsi=ind["rsi"],
            adx=ind["adx"],
            price=price,
            bb_width_pct=ind["bb_width_pct"],
            reason=reason,
        )

    def get_indicators(self, asset):
        """Haal huidige indicator waarden op voor status logging."""
        candles = self._fetch_candles(asset)
        if not candles:
            return None
        return self._compute_indicators(candles)
