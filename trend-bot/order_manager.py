import time
import threading
import logging

import requests
import hyperliquid.utils.signing

from config import BASE_URL, WALLET_ADDRESS, SZ_DECIMALS


logger = logging.getLogger("TrendBot")

# ---------------------------------------------------------------------------
# Nonce patch (zelfde als bot2) - voorkom nonce botsingen bij snelle orders
# ---------------------------------------------------------------------------
_nonce_lock = threading.Lock()
_last_nonce = 0


def _unique_nonce():
    """Genereer een unieke nonce op basis van millisecond-timestamp."""
    global _last_nonce
    with _nonce_lock:
        ts = int(time.time() * 1000)
        if ts <= _last_nonce:
            ts = _last_nonce + 1
        _last_nonce = ts
        return ts


# Patch de SDK nonce functie
hyperliquid.utils.signing.get_timestamp_ms = _unique_nonce


# ── Data client (centraal via Redis, fallback naar directe API) ──
import sys
sys.path.insert(0, "/root/neuralabs-data")
from client import HLDataClient as _HLDataClient
_data_client = _HLDataClient(wallet_address=WALLET_ADDRESS, base_url=BASE_URL)

def _info_post(payload):
    """Stuur een REST POST via data hub (fallback naar directe API)."""
    try:
        return _data_client.info_post(payload)
    except Exception as e:
        logger.error("REST POST fout naar /info: %s", e)
        return None


class OrderManager:
    """Beheert alle order-interacties met de Hyperliquid exchange."""

    def __init__(self, exchange):
        self._exchange = exchange
        self._open_orders = {}  # oid -> {"asset": ..., "is_buy": ..., "ts": ...}
        self._sz_decimals = dict(SZ_DECIMALS)  # lokale cache
        self._lock = threading.Lock()

    def get_sz_decimals(self, asset):
        """Haal het aantal size decimalen op voor een asset (met cache)."""
        if asset in self._sz_decimals:
            return self._sz_decimals[asset]

        # Probeer op te halen via REST
        try:
            data = _info_post({"type": "meta"})
            if data and "universe" in data:
                for info in data["universe"]:
                    if info.get("name") == asset:
                        dec = info.get("szDecimals", 2)
                        self._sz_decimals[asset] = dec
                        return dec
        except Exception as e:
            logger.error("Fout bij ophalen sz_decimals voor %s: %s", asset, e)

        # Fallback
        default = 2
        self._sz_decimals[asset] = default
        return default

    def place_limit_order(self, asset, is_buy, size_usd, price):
        """
        Plaats een limit order.

        Retourneert oid (int) bij succes, None bij fout.
        """
        if price <= 0:
            logger.error("Ongeldige prijs voor limit order: %s", price)
            return None

        decimals = self.get_sz_decimals(asset)
        size = round(size_usd / price, decimals)

        if size <= 0:
            logger.error("Berekende grootte is 0 voor %s (usd=%.2f, prijs=%.2f)", asset, size_usd, price)
            return None

        try:
            result = self._exchange.order(
                asset, is_buy, size, price, {"limit": {"tif": "Gtc"}}
            )
            logger.debug("Order response voor %s: %s", asset, result)
        except Exception as e:
            logger.error("Fout bij plaatsen limit order voor %s: %s", asset, e)
            return None

        oid = self._extract_oid(result)
        if oid is not None:
            with self._lock:
                self._open_orders[oid] = {
                    "asset": asset,
                    "is_buy": is_buy,
                    "ts": time.time(),
                }
            side_str = "KOOP" if is_buy else "VERKOOP"
            logger.info(
                "Limit order geplaatst: %s %s %s @ $%.2f (oid=%d)",
                side_str, asset, size, price, oid,
            )
        return oid

    def place_market_order(self, asset, is_buy, size, reduce_only=False):
        """
        Plaats een market order via IOC limit order met slippage.

        Retourneert True bij succes, False bij fout.
        """
        # Haal huidige prijs op voor slippage berekening
        book = _info_post({"type": "l2Book", "coin": asset})
        if not book or "levels" not in book:
            logger.error("Kan orderboek niet ophalen voor market order %s", asset)
            return False

        try:
            levels = book["levels"]
            from config import TICK_SIZES
            tick = TICK_SIZES.get(asset, 1.0)
            if is_buy:
                # Koop: gebruik best ask + 0.5% slippage
                best_ask = float(levels[1][0]["px"])
                raw = best_ask * 1.005
                slippage_price = round(round(raw / tick) * tick, 10)
            else:
                # Verkoop: gebruik best bid - 0.5% slippage
                best_bid = float(levels[0][0]["px"])
                raw = best_bid * 0.995
                slippage_price = round(round(raw / tick) * tick, 10)
        except (KeyError, IndexError, ValueError) as e:
            logger.error("Fout bij berekenen slippage prijs voor %s: %s", asset, e)
            return False

        try:
            if reduce_only:
                result = self._exchange.order(
                    asset, is_buy, size, slippage_price,
                    {"limit": {"tif": "Ioc"}}, reduce_only=True,
                )
            else:
                result = self._exchange.order(
                    asset, is_buy, size, slippage_price,
                    {"limit": {"tif": "Ioc"}},
                )
            logger.debug("Market order response voor %s: %s", asset, result)
        except Exception as e:
            logger.error("Fout bij plaatsen market order voor %s: %s", asset, e)
            return False

        status = result.get("status", "")
        if status == "ok":
            side_str = "KOOP" if is_buy else "VERKOOP"
            logger.info("Market order uitgevoerd: %s %s %.6f", side_str, asset, size)
            return True

        logger.error("Market order mislukt voor %s: %s", asset, result)
        return False

    def cancel_order(self, asset, oid):
        """Annuleer een specifieke order. Retourneert True bij succes."""
        try:
            result = self._exchange.cancel(asset, oid)
            logger.debug("Cancel response voor oid %d: %s", oid, result)
        except Exception as e:
            logger.error("Fout bij annuleren order %d voor %s: %s", oid, asset, e)
            return False

        with self._lock:
            self._open_orders.pop(oid, None)

        logger.info("Order %d geannuleerd voor %s", oid, asset)
        return True

    def cancel_all_orders(self):
        """Annuleer alle bijgehouden open orders. Retourneert aantal geannuleerd."""
        with self._lock:
            orders_copy = dict(self._open_orders)

        count = 0
        for oid, info in orders_copy.items():
            if self.cancel_order(info["asset"], oid):
                count += 1

        logger.info("Alle orders geannuleerd: %d totaal", count)
        return count

    def get_order_status(self, oid):
        """
        Haal de status op van een order.

        Retourneert: "filled", "open", "canceled", of "unknown".
        """
        data = _info_post({
            "type": "orderStatus",
            "user": WALLET_ADDRESS,
            "oid": oid,
        })

        if not data:
            return "unknown"

        try:
            order = data.get("order", {})
            status = order.get("status", "unknown")

            if status == "filled":
                with self._lock:
                    self._open_orders.pop(oid, None)
                return "filled"
            elif status == "open":
                return "open"
            elif status == "canceled":
                with self._lock:
                    self._open_orders.pop(oid, None)
                return "canceled"
            else:
                # Probeer alternatieve structuur
                order_info = order.get("order", {})
                if order_info.get("status") == "filled":
                    with self._lock:
                        self._open_orders.pop(oid, None)
                    return "filled"
                return "unknown"
        except Exception as e:
            logger.debug("Fout bij parsen order status voor oid %d: %s", oid, e)
            return "unknown"

    def _extract_oid(self, result):
        """Extraheer oid uit een order response."""
        if not result or result.get("status") != "ok":
            if result:
                logger.error("Order mislukt: %s", result)
            return None

        try:
            response = result.get("response", {})
            data = response.get("data", {})
            statuses = data.get("statuses", [])

            if not statuses:
                logger.error("Geen statuses in order response")
                return None

            first = statuses[0]

            if "resting" in first:
                return int(first["resting"]["oid"])
            elif "filled" in first:
                filled = first["filled"]
                return int(filled.get("oid", 0)) if filled.get("oid") else None
            elif "error" in first:
                logger.error("Order fout: %s", first["error"])
                return None

        except (KeyError, ValueError, TypeError) as e:
            logger.error("Fout bij extraheren oid: %s (response: %s)", e, result)

        return None
