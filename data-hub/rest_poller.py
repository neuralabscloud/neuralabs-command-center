"""
Jarvis REST poller — haalt marktdata op van Hyperliquid en schrijft naar Redis.
Elke data-type heeft een eigen poll interval en TTL.
"""
import time
import threading
import msgpack
import requests
import redis
import logging

from config import (
    BASE_URL, REDIS_HOST, REDIS_PORT, REDIS_DB,
    ASSETS, WALLETS,
    POLL_ALL_MIDS, POLL_META_AND_ASSET_CTXS, POLL_META,
    POLL_SPOT_META, POLL_CLEARINGHOUSE, POLL_OPEN_ORDERS,
    POLL_CANDLES, POLL_USER_FUNDING,
    POLL_FUNDING_HISTORY, POLL_USER_FILLS, POLL_SPOT_META_CTXS,
    POLL_OI_SNAPSHOT,
    TTL_ALL_MIDS, TTL_META_AND_ASSET_CTXS, TTL_META,
    TTL_SPOT_META, TTL_CLEARINGHOUSE, TTL_OPEN_ORDERS,
    TTL_CANDLES, TTL_USER_FUNDING, TTL_SPOT_CLEARINGHOUSE,
    TTL_FUNDING_HISTORY, TTL_USER_FILLS, TTL_SPOT_META_CTXS,
    CANDLE_CONFIGS, OI_HISTORY_MAX,
)

log = logging.getLogger("data_hub")


def _info_post(session: requests.Session, payload: dict) -> dict:
    r = session.post(f"{BASE_URL}/info", json=payload, timeout=10)
    r.raise_for_status()
    return r.json()


class RestPoller:
    def __init__(self):
        self._rdb = redis.Redis(host=REDIS_HOST, port=REDIS_PORT, db=REDIS_DB)
        self._session = requests.Session()
        self._stop = threading.Event()
        self._threads: list[threading.Thread] = []

    def start(self):
        polls = [
            ("allMids",           self._poll_all_mids,            POLL_ALL_MIDS),
            ("metaAndAssetCtxs",  self._poll_meta_and_asset_ctxs, POLL_META_AND_ASSET_CTXS),
            ("meta",              self._poll_meta,                 POLL_META),
            ("spotMeta",          self._poll_spot_meta,            POLL_SPOT_META),
            ("clearinghouseState",self._poll_clearinghouse,        POLL_CLEARINGHOUSE),
            ("openOrders",        self._poll_open_orders,          POLL_OPEN_ORDERS),
            ("candles",           self._poll_candles,              POLL_CANDLES),
            ("userFunding",       self._poll_user_funding,         POLL_USER_FUNDING),
            ("fundingHistory",   self._poll_funding_history,      POLL_FUNDING_HISTORY),
            ("userFills",        self._poll_user_fills,           POLL_USER_FILLS),
            ("spotMetaCtxs",     self._poll_spot_meta_ctxs,       POLL_SPOT_META_CTXS),
            ("oiSnapshot",       self._poll_oi_snapshot,          POLL_OI_SNAPSHOT),
        ]
        for name, fn, interval in polls:
            t = threading.Thread(target=self._loop, args=(name, fn, interval), daemon=True, name=f"poll-{name}")
            t.start()
            self._threads.append(t)
        log.info(f"REST poller gestart: {len(polls)} poll threads")

    def stop(self):
        self._stop.set()
        for t in self._threads:
            t.join(timeout=5)
        log.info("REST poller gestopt")

    def _loop(self, name: str, fn, interval: float):
        while not self._stop.is_set():
            try:
                fn()
            except Exception as e:
                log.error(f"Poll {name} mislukt: {e}")
            self._stop.wait(timeout=interval)

    def _set(self, key: str, data, ttl: int):
        self._rdb.set(key, msgpack.packb(data, use_bin_type=True), ex=ttl)

    # ── Poll functies ──────────────────────────────────

    def _poll_all_mids(self):
        data = _info_post(self._session, {"type": "allMids"})
        self._set("hl:allMids", data, TTL_ALL_MIDS)

    def _poll_meta_and_asset_ctxs(self):
        data = _info_post(self._session, {"type": "metaAndAssetCtxs"})
        self._set("hl:metaAndAssetCtxs", data, TTL_META_AND_ASSET_CTXS)

    def _poll_meta(self):
        data = _info_post(self._session, {"type": "meta"})
        self._set("hl:meta", data, TTL_META)

    def _poll_spot_meta(self):
        data = _info_post(self._session, {"type": "spotMeta"})
        self._set("hl:spotMeta", data, TTL_SPOT_META)

    def _poll_clearinghouse(self):
        for bot_name, wallet in WALLETS.items():
            if not wallet:
                continue
            try:
                data = _info_post(self._session, {"type": "clearinghouseState", "user": wallet})
                self._set(f"hl:clState:{wallet}", data, TTL_CLEARINGHOUSE)
            except Exception as e:
                log.error(f"Poll clearinghouse {bot_name} mislukt: {e}")
            # Spot clearinghouse alleen voor bot1
            if bot_name == "bot1":
                try:
                    data = _info_post(self._session, {"type": "spotClearinghouseState", "user": wallet})
                    self._set(f"hl:spotClState:{wallet}", data, TTL_SPOT_CLEARINGHOUSE)
                except Exception as e:
                    log.error(f"Poll spotClearinghouse {bot_name} mislukt: {e}")

    def _poll_open_orders(self):
        for bot_name, wallet in WALLETS.items():
            if not wallet:
                continue
            try:
                data = _info_post(self._session, {"type": "openOrders", "user": wallet})
                self._set(f"hl:openOrders:{wallet}", data, TTL_OPEN_ORDERS)
            except Exception as e:
                log.error(f"Poll openOrders {bot_name} mislukt: {e}")

    def _poll_candles(self):
        now_ms = int(time.time() * 1000)
        for cfg in CANDLE_CONFIGS:
            try:
                data = _info_post(self._session, {
                    "type": "candleSnapshot",
                    "req": {
                        "coin": cfg["coin"],
                        "interval": cfg["interval"],
                        "startTime": now_ms - (cfg["count"] * 60 * 60 * 1000 if "h" in cfg["interval"]
                                               else cfg["count"] * 5 * 60 * 1000),
                        "endTime": now_ms,
                    }
                })
                key = f"hl:candles:{cfg['coin']}:{cfg['interval']}"
                self._set(key, data, TTL_CANDLES)
            except Exception as e:
                log.error(f"Poll candles {cfg['coin']}/{cfg['interval']} mislukt: {e}")

    def _poll_user_funding(self):
        # Alleen bot1 wallet
        wallet = WALLETS.get("bot1", "")
        if not wallet:
            return
        try:
            # Haal funding van afgelopen 24 uur
            start_ms = int((time.time() - 86400) * 1000)
            data = _info_post(self._session, {
                "type": "userFunding",
                "user": wallet,
                "startTime": start_ms,
            })
            self._set(f"hl:userFunding:{wallet}", data, TTL_USER_FUNDING)
        except Exception as e:
            log.error(f"Poll userFunding mislukt: {e}")

    def _poll_funding_history(self):
        """Funding rate history per asset — toont trend over de afgelopen uren."""
        for coin in ASSETS:
            try:
                now_ms = int(time.time() * 1000)
                start_ms = now_ms - (24 * 60 * 60 * 1000)  # 24 uur terug
                data = _info_post(self._session, {
                    "type": "fundingHistory",
                    "coin": coin,
                    "startTime": start_ms,
                    "endTime": now_ms,
                })
                self._set(f"hl:fundingHistory:{coin}", data, TTL_FUNDING_HISTORY)
            except Exception as e:
                log.error(f"Poll fundingHistory {coin} mislukt: {e}")

    def _poll_user_fills(self):
        """Recente fills per wallet — welke orders zijn gevuld tegen welke prijs."""
        for bot_name, wallet in WALLETS.items():
            if not wallet:
                continue
            try:
                data = _info_post(self._session, {
                    "type": "userFillsByTime",
                    "user": wallet,
                    "startTime": int((time.time() - 86400) * 1000),
                })
                self._set(f"hl:fills:{wallet}", data, TTL_USER_FILLS)
            except Exception as e:
                log.error(f"Poll userFills {bot_name} mislukt: {e}")

    def _poll_spot_meta_ctxs(self):
        """Spot metadata + asset contexts in 1 call — prijzen, volume, etc."""
        try:
            data = _info_post(self._session, {"type": "spotMetaAndAssetCtxs"})
            self._set("hl:spotMetaAndAssetCtxs", data, TTL_SPOT_META_CTXS)
        except Exception as e:
            log.error(f"Poll spotMetaAndAssetCtxs mislukt: {e}")

    def _poll_oi_snapshot(self):
        """OI tijdreeks — sla huidige OI per asset op als rolling history in Redis list."""
        try:
            data = _info_post(self._session, {"type": "metaAndAssetCtxs"})
            universe = data[0].get("universe", [])
            ctxs = data[1]
            now = time.time()

            for coin in ASSETS:
                for i, asset in enumerate(universe):
                    if asset.get("name") != coin or i >= len(ctxs):
                        continue
                    try:
                        oi = float(ctxs[i].get("openInterest", 0))
                        mark_px = float(ctxs[i].get("markPx", 0))
                        funding = float(ctxs[i].get("funding", 0))
                        snapshot = {
                            "ts": now,
                            "oi": oi,
                            "oi_usd": oi * mark_px,
                            "mark_px": mark_px,
                            "funding": funding,
                        }
                        packed = msgpack.packb(snapshot, use_bin_type=True)
                        pipe = self._rdb.pipeline(transaction=False)
                        pipe.lpush(f"hl:oiHistory:{coin}", packed)
                        pipe.ltrim(f"hl:oiHistory:{coin}", 0, OI_HISTORY_MAX - 1)
                        pipe.execute()
                    except (ValueError, TypeError, IndexError):
                        pass
                    break
        except Exception as e:
            log.error(f"Poll oiSnapshot mislukt: {e}")
