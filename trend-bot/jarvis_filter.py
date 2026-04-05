"""
Jarvis filter voor OB Imbalance Scalper.
Gebruikt data uit de centrale Jarvis hub om slechte signalen te filteren:

1. Liquidatie filter: blokkeer entries tijdens actieve liquidatie cascades
   (orderbook wordt tijdelijk scheefgetrokken door forced selling, niet echte koopdruk)

2. Volume-bevestiging: orderbook imbalance MOET bevestigd worden door daadwerkelijke
   trade flow (CVD) — anders is het waarschijnlijk spoofing/absorptie

3. Funding rate filter: extreem hoge funding = crowded posities, hoger risico op
   plotselinge reversal
"""
import sys
import time
import logging
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "data-hub"))
from client import HLDataClient

from config import BASE_URL

logger = logging.getLogger("OBScalper")

# ── Filter parameters ──────────────────────────────────
# Liquidatie cascade detectie
LIQ_LOOKBACK_SECS    = 60     # kijk naar liquidaties in de afgelopen 60s
LIQ_MIN_NOTIONAL     = 50_000 # $50K+ aan liquidaties in die periode = cascade
LIQ_COOLDOWN_SECS    = 30     # na cascade, 30s wachten

# Volume-bevestiging (CVD uit recente trades)
CVD_LOOKBACK_TRADES  = 100    # laatste 100 trades analyseren
CVD_MIN_RATIO        = 0.55   # 55% van volume moet in signaalrichting zijn

# Funding rate filter
FUNDING_EXTREME_PCT  = 50.0   # >50% annualized = extreem, pas op

# OI delta filter
OI_DROP_THRESHOLD    = -0.3   # -0.3% OI daling in 5min = posities sluiten, geen momentum


class JarvisFilter:
    """Extra signaalfilters op basis van Jarvis data."""

    def __init__(self):
        self._client = HLDataClient(wallet_address="", base_url=BASE_URL)
        self._liq_cooldown = {}  # coin -> timestamp wanneer cooldown afloopt

    def allows_entry(self, coin: str, direction: str) -> bool:
        """
        Check alle Jarvis filters. Retourneert True als entry is toegestaan.
        """
        # Filter 1: Liquidatie cascade
        if not self._check_liquidation(coin, direction):
            return False

        # Filter 2: Volume bevestiging (CVD)
        if not self._check_volume_confirmation(coin, direction):
            return False

        # Filter 3: Funding rate
        if not self._check_funding(coin, direction):
            return False

        # Filter 4: OI delta
        if not self._check_oi_delta(coin, direction):
            return False

        return True

    def _check_liquidation(self, coin: str, direction: str) -> bool:
        """
        Blokkeer entry als er een actieve liquidatie cascade is.
        Liquidaties trekken het orderbook scheef — imbalance signaal is onbetrouwbaar.
        """
        # Check cooldown
        cooldown_until = self._liq_cooldown.get(coin, 0)
        if time.time() < cooldown_until:
            remaining = cooldown_until - time.time()
            logger.debug(
                "%s: Jarvis liq-cooldown actief (nog %.0fs)", coin, remaining
            )
            return False

        try:
            events = self._client.get_liq_history(coin, max_count=100)
            if not events:
                return True

            now_ms = time.time() * 1000
            cutoff_ms = now_ms - (LIQ_LOOKBACK_SECS * 1000)

            recent_notional = 0.0
            recent_count = 0
            for e in events:
                ts = e.get("timestamp", 0)
                if isinstance(ts, str):
                    continue
                if ts >= cutoff_ms:
                    recent_notional += e.get("notional", 0)
                    recent_count += 1

            if recent_notional >= LIQ_MIN_NOTIONAL:
                self._liq_cooldown[coin] = time.time() + LIQ_COOLDOWN_SECS
                logger.info(
                    "%s: Jarvis BLOKKEER — liquidatie cascade gedetecteerd: "
                    "%d events, $%.0f notional in %ds — cooldown %ds",
                    coin, recent_count, recent_notional,
                    LIQ_LOOKBACK_SECS, LIQ_COOLDOWN_SECS,
                )
                return False

        except Exception as e:
            logger.debug("%s: Jarvis liq-check fout: %s", coin, e)

        return True

    def _check_volume_confirmation(self, coin: str, direction: str) -> bool:
        """
        Bevestig dat de recente trade flow (CVD) overeenkomt met het imbalance signaal.
        Als bids zwaar zijn maar trades toch verkoopkant op gaan = absorptie/spoof.
        """
        try:
            trades = self._client.get_recent_trades(coin, max_count=CVD_LOOKBACK_TRADES)
            if len(trades) < 20:
                # Te weinig data, laat het signaal door
                return True

            buy_vol = 0.0
            sell_vol = 0.0
            for t in trades:
                try:
                    size = float(t.get("sz", 0))
                    price = float(t.get("px", 0))
                    notional = size * price
                    side = t.get("side", "")
                    if side == "B":
                        buy_vol += notional
                    elif side == "A":
                        sell_vol += notional
                except (ValueError, TypeError):
                    continue

            total = buy_vol + sell_vol
            if total <= 0:
                return True

            buy_ratio = buy_vol / total

            # LONG signaal: verwacht meer buy volume
            if direction == "LONG" and buy_ratio < CVD_MIN_RATIO:
                logger.info(
                    "%s: Jarvis BLOKKEER — LONG signaal maar CVD bearish "
                    "(buy=%.0f%%, drempel=%.0f%%)",
                    coin, buy_ratio * 100, CVD_MIN_RATIO * 100,
                )
                return False

            # SHORT signaal: verwacht meer sell volume
            sell_ratio = 1.0 - buy_ratio
            if direction == "SHORT" and sell_ratio < CVD_MIN_RATIO:
                logger.info(
                    "%s: Jarvis BLOKKEER — SHORT signaal maar CVD bullish "
                    "(sell=%.0f%%, drempel=%.0f%%)",
                    coin, sell_ratio * 100, CVD_MIN_RATIO * 100,
                )
                return False

        except Exception as e:
            logger.debug("%s: Jarvis CVD-check fout: %s", coin, e)

        return True

    def _check_funding(self, coin: str, direction: str) -> bool:
        """
        Blokkeer entries die meegaan met extreme funding (crowded trade).
        Hoge pos funding + LONG = crowded longs, risico op dump.
        Hoge neg funding + SHORT = crowded shorts, risico op squeeze.
        """
        try:
            data = self._client.get_meta_and_asset_ctxs()
            if not data or len(data) < 2:
                return True

            universe = data[0].get("universe", [])
            ctxs = data[1]

            for i, asset in enumerate(universe):
                if asset.get("name") != coin:
                    continue
                if i >= len(ctxs):
                    break

                funding_8h = float(ctxs[i].get("funding", 0))
                annual_pct = funding_8h * 3 * 365 * 100

                # LONG bij hoge positieve funding = crowded longs
                if direction == "LONG" and annual_pct > FUNDING_EXTREME_PCT:
                    logger.info(
                        "%s: Jarvis BLOKKEER — LONG bij extreme pos funding "
                        "(%.1f%% ann.)",
                        coin, annual_pct,
                    )
                    return False

                # SHORT bij hoge negatieve funding = crowded shorts
                if direction == "SHORT" and annual_pct < -FUNDING_EXTREME_PCT:
                    logger.info(
                        "%s: Jarvis BLOKKEER — SHORT bij extreme neg funding "
                        "(%.1f%% ann.)",
                        coin, annual_pct,
                    )
                    return False

                break

        except Exception as e:
            logger.debug("%s: Jarvis funding-check fout: %s", coin, e)

        return True

    def _check_oi_delta(self, coin: str, direction: str) -> bool:
        """
        Blokkeer entry als OI dalend is — posities worden gesloten,
        orderbook imbalance is niet gedreven door nieuwe interesse.
        """
        try:
            oi = self._client.get_oi_delta(coin, lookback_secs=300)
            if oi and oi["delta_pct"] < OI_DROP_THRESHOLD:
                logger.info(
                    "%s: Jarvis BLOKKEER — OI dalend (%+.2f%% in 5min, "
                    "drempel=%+.1f%%), geen echt momentum",
                    coin, oi["delta_pct"], OI_DROP_THRESHOLD,
                )
                return False
        except Exception as e:
            logger.debug("%s: Jarvis OI-check fout: %s", coin, e)
        return True

    def get_status(self, coin: str) -> str:
        """Status label voor logging."""
        parts = []

        # Liq cooldown?
        cd = self._liq_cooldown.get(coin, 0)
        if time.time() < cd:
            parts.append("LIQ-COOL")

        # CVD richting
        try:
            trades = self._client.get_recent_trades(coin, max_count=CVD_LOOKBACK_TRADES)
            if len(trades) >= 20:
                buy_vol = sum(
                    float(t.get("sz", 0)) * float(t.get("px", 0))
                    for t in trades if t.get("side") == "B"
                )
                sell_vol = sum(
                    float(t.get("sz", 0)) * float(t.get("px", 0))
                    for t in trades if t.get("side") == "A"
                )
                total = buy_vol + sell_vol
                if total > 0:
                    ratio = buy_vol / total
                    if ratio > 0.55:
                        parts.append("CVD:BUY")
                    elif ratio < 0.45:
                        parts.append("CVD:SELL")
                    else:
                        parts.append("CVD:FLAT")
        except Exception:
            pass

        # OI delta
        try:
            oi = self._client.get_oi_delta(coin, lookback_secs=300)
            if oi:
                parts.append(f"OI:{oi['delta_pct']:+.2f}%")
        except Exception:
            pass

        return " | ".join(parts) if parts else "OK"
