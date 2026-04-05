"""
Jarvis Client — drop-in vervanging voor info_post() in alle bots.

Leest data uit Redis (gevuld door Jarvis). Als Redis niet beschikbaar is
of data verlopen is, valt de client terug op directe API calls.

Gebruik:
    from client import HLDataClient

    data = HLDataClient(wallet_address="0x...", base_url="https://api.hyperliquid.xyz")
    mids = data.get_all_mids()
    book = data.get_l2book("BTC")
"""
import time
import json
import threading
import logging
from typing import Optional, Callable, Dict, List
from dataclasses import dataclass

import msgpack
import redis
import requests

log = logging.getLogger(__name__)

# Redis connectie config
_REDIS_HOST = "127.0.0.1"
_REDIS_PORT = 6379
_REDIS_DB   = 0


@dataclass
class LiquidationEvent:
    """Compatibel met Bot 3's LiquidationEvent dataclass."""
    coin:         str
    side:         str
    size:         float
    price:        float
    timestamp:    str
    timestamp_ms: float = 0.0


class HLDataClient:
    """Client voor de Central data hub. Thread-safe."""

    def __init__(self, wallet_address: str, base_url: str = "https://api.hyperliquid.xyz"):
        self._wallet = wallet_address
        self._base_url = base_url
        self._session = requests.Session()

        # Redis connectie (lazy, met fallback)
        self._rdb: Optional[redis.Redis] = None
        self._redis_available = False
        self._redis_last_check = 0.0
        self._connect_redis()

        # Pub/sub subscribers
        self._subscribers: Dict[str, threading.Thread] = {}
        self._sub_stop = threading.Event()

    def _connect_redis(self):
        try:
            self._rdb = redis.Redis(
                host=_REDIS_HOST, port=_REDIS_PORT, db=_REDIS_DB,
                socket_connect_timeout=2, socket_timeout=2,
                decode_responses=False,
            )
            self._rdb.ping()
            self._redis_available = True
            self._redis_last_check = time.time()
        except Exception:
            self._redis_available = False
            self._rdb = None

    def _check_redis(self) -> bool:
        """Check Redis beschikbaarheid, maar niet vaker dan elke 10s."""
        if self._redis_available:
            return True
        if time.time() - self._redis_last_check < 10:
            return False
        self._connect_redis()
        return self._redis_available

    def _get_from_redis(self, key: str):
        """Haal data uit Redis. Retourneert None als niet beschikbaar."""
        if not self._check_redis():
            return None
        try:
            raw = self._rdb.get(key)
            if raw is not None:
                return msgpack.unpackb(raw, raw=False)
        except (redis.RedisError, msgpack.UnpackException) as e:
            log.debug(f"Redis get {key} mislukt: {e}")
            self._redis_available = False
        return None

    def _fallback_post(self, payload: dict) -> dict:
        """Directe API call als fallback."""
        r = self._session.post(f"{self._base_url}/info", json=payload, timeout=10)
        r.raise_for_status()
        return r.json()

    # ── Hub status ─────────────────────────────────────

    def is_hub_alive(self) -> bool:
        """Check of de data hub draait (heartbeat key aanwezig)."""
        if not self._check_redis():
            return False
        try:
            return self._rdb.get("hl:hub:heartbeat") is not None
        except redis.RedisError:
            return False

    # ── Publieke marktdata (gedeeld) ───────────────────

    def get_all_mids(self) -> dict:
        """Alle mid-prijzen. Drop-in voor info_post({"type": "allMids"})."""
        data = self._get_from_redis("hl:allMids")
        if data is not None:
            return data
        return self._fallback_post({"type": "allMids"})

    def get_meta_and_asset_ctxs(self) -> list:
        """Meta + asset contexts. Drop-in voor info_post({"type": "metaAndAssetCtxs"})."""
        data = self._get_from_redis("hl:metaAndAssetCtxs")
        if data is not None:
            return data
        return self._fallback_post({"type": "metaAndAssetCtxs"})

    def get_meta(self) -> dict:
        """Asset metadata. Drop-in voor info_post({"type": "meta"})."""
        data = self._get_from_redis("hl:meta")
        if data is not None:
            return data
        return self._fallback_post({"type": "meta"})

    def get_spot_meta(self) -> dict:
        """Spot pair metadata. Drop-in voor info_post({"type": "spotMeta"})."""
        data = self._get_from_redis("hl:spotMeta")
        if data is not None:
            return data
        return self._fallback_post({"type": "spotMeta"})

    def get_candles(self, coin: str, interval: str, count: int = 200) -> list:
        """Candle data. Drop-in voor candleSnapshot requests."""
        data = self._get_from_redis(f"hl:candles:{coin}:{interval}")
        if data is not None:
            return data
        now_ms = int(time.time() * 1000)
        multiplier = 3600000 if "h" in interval else 300000
        return self._fallback_post({
            "type": "candleSnapshot",
            "req": {
                "coin": coin,
                "interval": interval,
                "startTime": now_ms - (count * multiplier),
                "endTime": now_ms,
            }
        })

    # ── Per-wallet data ────────────────────────────────

    def get_clearinghouse_state(self) -> dict:
        """Account state. Drop-in voor info_post({"type": "clearinghouseState", "user": ...})."""
        data = self._get_from_redis(f"hl:clState:{self._wallet}")
        if data is not None:
            return data
        return self._fallback_post({"type": "clearinghouseState", "user": self._wallet})

    def get_spot_clearinghouse_state(self) -> dict:
        """Spot account state. Drop-in voor spotClearinghouseState."""
        data = self._get_from_redis(f"hl:spotClState:{self._wallet}")
        if data is not None:
            return data
        return self._fallback_post({"type": "spotClearinghouseState", "user": self._wallet})

    def get_open_orders(self) -> list:
        """Open orders. Drop-in voor info_post({"type": "openOrders", "user": ...})."""
        data = self._get_from_redis(f"hl:openOrders:{self._wallet}")
        if data is not None:
            return data
        return self._fallback_post({"type": "openOrders", "user": self._wallet})

    def get_user_funding(self, start_time_ms: int = None) -> list:
        """User funding payments. Drop-in voor userFunding requests."""
        # Probeer eerst de cached versie (afgelopen 24 uur)
        data = self._get_from_redis(f"hl:userFunding:{self._wallet}")
        if data is not None:
            # Filter op startTime als opgegeven
            if start_time_ms is not None:
                return [e for e in data if e.get("time", 0) >= start_time_ms]
            return data
        # Fallback
        payload = {"type": "userFunding", "user": self._wallet}
        if start_time_ms is not None:
            payload["startTime"] = start_time_ms
        return self._fallback_post(payload)

    # ── Nieuwe data bronnen ──────────────────────────────

    def get_funding_history(self, coin: str) -> list:
        """Funding rate history (24 uur). Toont trend van funding over tijd."""
        data = self._get_from_redis(f"hl:fundingHistory:{coin}")
        if data is not None:
            return data
        now_ms = int(time.time() * 1000)
        return self._fallback_post({
            "type": "fundingHistory",
            "coin": coin,
            "startTime": now_ms - (24 * 60 * 60 * 1000),
            "endTime": now_ms,
        })

    def get_funding_trend(self, coin: str, periods: int = 6) -> Optional[float]:
        """Afgeleide: funding rate trend. Positief = stijgend, negatief = dalend.
        Vergelijkt gemiddelde van laatste N periodes met voorgaande N periodes.
        Retourneert verschil in annualized %, of None als onvoldoende data.
        """
        history = self.get_funding_history(coin)
        if not history or len(history) < periods * 2:
            return None
        try:
            rates = [float(h.get("fundingRate", 0)) for h in history[-periods * 2:]]
            old_avg = sum(rates[:periods]) / periods
            new_avg = sum(rates[periods:]) / periods
            return (new_avg - old_avg) * 3 * 365 * 100  # annualized %
        except (ValueError, TypeError):
            return None

    def get_user_fills(self) -> list:
        """Recente fills voor deze wallet (afgelopen 24 uur)."""
        data = self._get_from_redis(f"hl:fills:{self._wallet}")
        if data is not None:
            return data
        return self._fallback_post({
            "type": "userFillsByTime",
            "user": self._wallet,
            "startTime": int((time.time() - 86400) * 1000),
        })

    def get_spot_meta_and_ctxs(self) -> list:
        """Spot metadata + asset contexts in 1 call."""
        data = self._get_from_redis("hl:spotMetaAndAssetCtxs")
        if data is not None:
            return data
        return self._fallback_post({"type": "spotMetaAndAssetCtxs"})

    def get_oi_history(self, coin: str, max_count: int = 360) -> list:
        """OI tijdreeks (rolling history, elke 30s een snapshot).
        Retourneert lijst van {ts, oi, oi_usd, mark_px, funding} dicts.
        Nieuwste eerst.
        """
        if not self._check_redis():
            return []
        try:
            raw_list = self._rdb.lrange(f"hl:oiHistory:{coin}", 0, max_count - 1)
            return [msgpack.unpackb(r, raw=False) for r in raw_list]
        except Exception:
            return []

    def get_oi_delta(self, coin: str, lookback_secs: int = 300) -> Optional[dict]:
        """Afgeleide: OI verandering over de laatste N seconden.
        Retourneert {delta_oi_usd, delta_pct, current_oi_usd} of None.
        """
        history = self.get_oi_history(coin)
        if not history or len(history) < 2:
            return None
        try:
            now_ts = history[0]["ts"]
            current_oi = history[0]["oi_usd"]
            cutoff = now_ts - lookback_secs

            # Zoek oudste snapshot binnen lookback
            old_oi = current_oi
            for snap in history:
                if snap["ts"] <= cutoff:
                    old_oi = snap["oi_usd"]
                    break

            if old_oi <= 0:
                return None

            delta = current_oi - old_oi
            delta_pct = (delta / old_oi) * 100

            return {
                "delta_oi_usd": delta,
                "delta_pct": delta_pct,
                "current_oi_usd": current_oi,
            }
        except (KeyError, TypeError, ZeroDivisionError):
            return None

    # ── Realtime data (WebSocket via Redis) ────────────

    def get_l2book(self, coin: str) -> Optional[dict]:
        """Laatste orderbook snapshot. Drop-in voor l2Book requests."""
        data = self._get_from_redis(f"hl:l2Book:{coin}")
        if data is not None:
            return data
        # Fallback naar REST
        try:
            return self._fallback_post({"type": "l2Book", "coin": coin})
        except Exception:
            return None

    def get_recent_trades(self, coin: str, max_count: int = 500) -> list:
        """Recente trades uit Redis buffer."""
        if not self._check_redis():
            return []
        try:
            raw_list = self._rdb.lrange(f"hl:recentTrades:{coin}", 0, max_count - 1)
            return [msgpack.unpackb(r, raw=False) for r in raw_list]
        except Exception:
            return []

    def get_liq_history(self, coin: str, max_count: int = 300) -> list:
        """Liquidatie history uit Redis buffer. Retourneert dicts."""
        if not self._check_redis():
            return []
        try:
            raw_list = self._rdb.lrange(f"hl:liqHistory:{coin}", 0, max_count - 1)
            return [msgpack.unpackb(r, raw=False) for r in raw_list]
        except Exception:
            return []

    def get_liq_history_as_events(self, coin: str, max_count: int = 300) -> List[LiquidationEvent]:
        """Liquidatie history als LiquidationEvent objecten (compatibel met Bot 3)."""
        raw_events = self.get_liq_history(coin, max_count)
        events = []
        for e in raw_events:
            try:
                ts = e.get("timestamp", 0)
                from datetime import datetime
                ts_str = datetime.utcfromtimestamp(ts / 1000).strftime("%H:%M:%S") if ts else "?"
                events.append(LiquidationEvent(
                    coin=e.get("coin", coin),
                    side=e.get("side", ""),
                    size=float(e.get("size", 0)),
                    price=float(e.get("price", 0)),
                    timestamp=ts_str,
                    timestamp_ms=float(ts) if ts else time.time() * 1000,
                ))
            except (ValueError, TypeError):
                continue
        return events

    # ── Pub/Sub subscribers ────────────────────────────

    def subscribe_l2book(self, coin: str, callback: Callable[[dict], None]):
        """Subscribe op realtime l2Book updates via Redis pub/sub.
        callback ontvangt het volledige book data dict.
        """
        channel = f"hl:stream:l2Book:{coin}"
        self._start_subscriber(channel, callback)

    def subscribe_trades(self, coin: str, callback: Callable[[dict], None]):
        """Subscribe op realtime trade events."""
        channel = f"hl:stream:trades:{coin}"
        self._start_subscriber(channel, callback)

    def subscribe_liquidations(self, coin: str, callback: Callable[[dict], None]):
        """Subscribe op realtime liquidatie events."""
        channel = f"hl:stream:liquidation:{coin}"
        self._start_subscriber(channel, callback)

    def _start_subscriber(self, channel: str, callback: Callable):
        if channel in self._subscribers:
            return  # Al geabonneerd

        if not self._check_redis():
            log.warning(f"Redis niet beschikbaar, kan niet subscriben op {channel}")
            return

        def _listen():
            sub = self._rdb.pubsub()
            sub.subscribe(channel)
            log.info(f"Geabonneerd op {channel}")
            try:
                for message in sub.listen():
                    if self._sub_stop.is_set():
                        break
                    if message["type"] != "message":
                        continue
                    try:
                        data = msgpack.unpackb(message["data"], raw=False)
                        callback(data)
                    except Exception as e:
                        log.debug(f"Subscriber {channel} callback fout: {e}")
            except Exception as e:
                log.warning(f"Subscriber {channel} gestopt: {e}")
            finally:
                try:
                    sub.unsubscribe(channel)
                    sub.close()
                except Exception:
                    pass

        t = threading.Thread(target=_listen, daemon=True, name=f"sub-{channel}")
        t.start()
        self._subscribers[channel] = t

    def stop(self):
        """Stop alle subscribers."""
        self._sub_stop.set()
        for channel, t in self._subscribers.items():
            t.join(timeout=3)
        self._subscribers.clear()

    # ── Generic info_post vervanging ───────────────────

    def info_post(self, payload: dict) -> dict:
        """Generic vervanging voor info_post(). Probeert eerst Redis, dan fallback.
        Dit is handig voor calls die niet een eigen methode hebben.
        """
        req_type = payload.get("type", "")

        # Map bekende types naar Redis keys
        if req_type == "allMids":
            return self.get_all_mids()
        elif req_type == "metaAndAssetCtxs":
            return self.get_meta_and_asset_ctxs()
        elif req_type == "meta":
            return self.get_meta()
        elif req_type == "spotMeta":
            return self.get_spot_meta()
        elif req_type == "clearinghouseState":
            user = payload.get("user", self._wallet)
            data = self._get_from_redis(f"hl:clState:{user}")
            if data is not None:
                return data
        elif req_type == "spotClearinghouseState":
            user = payload.get("user", self._wallet)
            data = self._get_from_redis(f"hl:spotClState:{user}")
            if data is not None:
                return data
        elif req_type == "openOrders":
            user = payload.get("user", self._wallet)
            data = self._get_from_redis(f"hl:openOrders:{user}")
            if data is not None:
                return data
        elif req_type == "l2Book":
            coin = payload.get("coin", "")
            data = self._get_from_redis(f"hl:l2Book:{coin}")
            if data is not None:
                return data
        elif req_type == "candleSnapshot":
            req = payload.get("req", {})
            coin = req.get("coin", "")
            interval = req.get("interval", "")
            data = self._get_from_redis(f"hl:candles:{coin}:{interval}")
            if data is not None:
                return data
        elif req_type == "fundingHistory":
            coin = payload.get("coin", "")
            data = self._get_from_redis(f"hl:fundingHistory:{coin}")
            if data is not None:
                return data
        elif req_type == "userFillsByTime":
            user = payload.get("user", self._wallet)
            data = self._get_from_redis(f"hl:fills:{user}")
            if data is not None:
                return data
        elif req_type == "spotMetaAndAssetCtxs":
            return self.get_spot_meta_and_ctxs()

        # Fallback naar directe API
        return self._fallback_post(payload)
