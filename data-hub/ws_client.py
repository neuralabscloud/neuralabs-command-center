"""
Jarvis WebSocket client — enkele verbinding naar Hyperliquid voor realtime data.
Schrijft l2Book snapshots en trade/liquidatie events naar Redis.
"""
import json
import time
import threading
import logging
import msgpack
import redis
import websocket

from config import (
    WS_URL, REDIS_HOST, REDIS_PORT, REDIS_DB,
    ASSETS,
    WS_RECONNECT_DELAY, WS_MAX_RECONNECT_DELAY,
    TTL_L2BOOK, LIQ_HISTORY_MAX,
)

log = logging.getLogger("data_hub")


class WsClient:
    def __init__(self):
        self._rdb = redis.Redis(host=REDIS_HOST, port=REDIS_PORT, db=REDIS_DB)
        self._ws = None
        self._thread = None
        self._stop = threading.Event()
        self._connected = False
        self._reconnect_delay = WS_RECONNECT_DELAY

    @property
    def is_connected(self) -> bool:
        return self._connected

    def start(self):
        self._stop.clear()
        self._thread = threading.Thread(target=self._run_loop, daemon=True, name="WsClient")
        self._thread.start()
        log.info(f"WebSocket client gestart -> {WS_URL}")

    def stop(self):
        log.info("WebSocket client stoppen...")
        self._stop.set()
        if self._ws:
            try:
                self._ws.close()
            except Exception:
                pass
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=5)
        log.info("WebSocket client gestopt")

    def _run_loop(self):
        while not self._stop.is_set():
            try:
                self._connect()
            except Exception as e:
                log.error(f"WS verbindingsfout: {e}")

            if self._stop.is_set():
                break

            self._connected = False
            log.warning(f"WS herverbinden in {self._reconnect_delay}s...")
            self._stop.wait(timeout=self._reconnect_delay)
            self._reconnect_delay = min(self._reconnect_delay * 2, WS_MAX_RECONNECT_DELAY)

    def _connect(self):
        self._ws = websocket.WebSocketApp(
            WS_URL,
            on_open=self._on_open,
            on_message=self._on_message,
            on_error=self._on_error,
            on_close=self._on_close,
        )
        self._ws.run_forever(ping_interval=30, ping_timeout=10)

    def _on_open(self, ws):
        self._connected = True
        self._reconnect_delay = WS_RECONNECT_DELAY
        log.info(f"WS verbonden met {WS_URL}")

        for coin in ASSETS:
            ws.send(json.dumps({
                "method": "subscribe",
                "subscription": {"type": "l2Book", "coin": coin}
            }))
            ws.send(json.dumps({
                "method": "subscribe",
                "subscription": {"type": "trades", "coin": coin}
            }))
        log.info(f"WS ingeschreven op l2Book + trades voor: {', '.join(ASSETS)}")

    def _on_message(self, ws, raw: str):
        try:
            msg = json.loads(raw)
        except Exception:
            return

        channel = msg.get("channel", "")
        data = msg.get("data")
        if data is None:
            return

        if channel == "l2Book":
            self._handle_l2book(data)
        elif channel == "trades":
            self._handle_trades(data)

    def _on_error(self, ws, error):
        log.error(f"WS fout: {error}")

    def _on_close(self, ws, code, msg):
        self._connected = False
        log.warning(f"WS verbinding gesloten (code={code})")

    def _handle_l2book(self, data: dict):
        coin = data.get("coin", "")
        if coin not in ASSETS:
            return

        packed = msgpack.packb(data, use_bin_type=True)

        pipe = self._rdb.pipeline(transaction=False)
        # Snapshot key voor bots die on-demand lezen
        pipe.set(f"hl:l2Book:{coin}", packed, ex=TTL_L2BOOK)
        # Pub/sub voor bots die realtime luisteren
        pipe.publish(f"hl:stream:l2Book:{coin}", packed)
        pipe.execute()

    def _handle_trades(self, trades: list):
        if not isinstance(trades, list):
            return

        for t in trades:
            coin = t.get("coin") or t.get("s", "")
            if coin not in ASSETS:
                continue

            # Publiceer alle trades
            packed = msgpack.packb(t, use_bin_type=True)
            self._rdb.publish(f"hl:stream:trades:{coin}", packed)

            # Liquidatie detectie: size-based heuristiek
            # HL WebSocket trades hebben geen 'crossed' veld
            LIQ_THRESHOLDS = {"BTC": 50000, "ETH": 25000, "SOL": 20000, "BNB": 20000}
            liq_threshold = LIQ_THRESHOLDS.get(coin, 20000)
            price_val = float(t.get("px", 0))
            size_val = float(t.get("sz", 0))
            if (price_val * size_val) >= liq_threshold:
                try:
                    price = float(t.get("px", 0))
                    size = float(t.get("sz", 0))
                    side = t.get("side", "")
                    ts = t.get("time", 0)

                    event = {
                        "coin": coin,
                        "side": side,
                        "size": size,
                        "price": price,
                        "timestamp": ts,
                        "notional": price * size,
                    }
                    packed_event = msgpack.packb(event, use_bin_type=True)

                    pipe = self._rdb.pipeline(transaction=False)
                    # Pub/sub voor realtime liquidatie alerts
                    pipe.publish(f"hl:stream:liquidation:{coin}", packed_event)
                    # History list voor zone-constructie
                    pipe.lpush(f"hl:liqHistory:{coin}", packed_event)
                    pipe.ltrim(f"hl:liqHistory:{coin}", 0, LIQ_HISTORY_MAX - 1)
                    pipe.execute()

                    notional = price * size
                    log.info(
                        f"Liquidatie: {coin} {side} {size} @ ${price:,.2f} "
                        f"(${notional:,.0f})"
                    )
                except (ValueError, TypeError):
                    pass

            # Sla recente trades op in een lijst (voor Bot 3)
            pipe = self._rdb.pipeline(transaction=False)
            pipe.lpush(f"hl:recentTrades:{coin}", packed)
            pipe.ltrim(f"hl:recentTrades:{coin}", 0, 499)  # max 500
            pipe.execute()
