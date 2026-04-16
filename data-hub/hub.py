"""
Jarvis — NeuraLabs Centrale Data Hub
Start REST poller + WebSocket client, schrijft heartbeat naar Redis.
"""
import time
import signal
import sys
import os
import threading
import logging
import redis

from config import (
    REDIS_HOST, REDIS_PORT, REDIS_DB,
    HEARTBEAT_INTERVAL, LOG_FILE, LOG_LEVEL,
)
from rest_poller import RestPoller
from ws_client import WsClient

# ── Logging setup ──────────────────────────────────────
os.makedirs(os.path.dirname(LOG_FILE), exist_ok=True)

log = logging.getLogger("data_hub")
log.setLevel(getattr(logging, LOG_LEVEL))
log.propagate = False

fmt = logging.Formatter("%(asctime)s | %(levelname)s | %(message)s", datefmt="%Y-%m-%d %H:%M:%S")

fh = logging.FileHandler(LOG_FILE)
fh.setFormatter(fmt)
log.addHandler(fh)

sh = logging.StreamHandler(sys.stdout)
sh.setFormatter(fmt)
log.addHandler(sh)


class DataHub:
    def __init__(self):
        self._rdb = redis.Redis(host=REDIS_HOST, port=REDIS_PORT, db=REDIS_DB)
        self._poller = RestPoller()
        self._ws = WsClient()
        self._stop = threading.Event()
        self._heartbeat_thread = None

    def start(self):
        log.info("=" * 55)
        log.info("  Jarvis — NeuraLabs Data Hub")
        log.info("  Centrale data layer voor alle bots")
        log.info("=" * 55)

        # Test Redis
        try:
            self._rdb.ping()
            log.info("Redis verbinding OK")
        except redis.RedisError as e:
            log.error(f"Redis niet bereikbaar: {e}")
            sys.exit(1)

        # Start componenten
        self._poller.start()
        self._ws.start()

        # Heartbeat
        self._heartbeat_thread = threading.Thread(
            target=self._heartbeat_loop, daemon=True, name="heartbeat"
        )
        self._heartbeat_thread.start()

        log.info("Jarvis is online")

    def stop(self):
        log.info("Jarvis afsluiten...")
        self._stop.set()
        self._poller.stop()
        self._ws.stop()
        try:
            self._rdb.delete("hl:hub:heartbeat")
        except Exception:
            pass
        log.info("Jarvis offline")

    def _heartbeat_loop(self):
        while not self._stop.is_set():
            try:
                self._rdb.set("hl:hub:heartbeat", str(time.time()), ex=HEARTBEAT_INTERVAL * 3)
            except Exception:
                pass
            self._stop.wait(timeout=HEARTBEAT_INTERVAL)

    def run_forever(self):
        self.start()
        try:
            while not self._stop.is_set():
                self._stop.wait(timeout=1)
        except KeyboardInterrupt:
            pass
        finally:
            self.stop()


def main():
    hub = DataHub()

    def _signal_handler(sig, frame):
        log.info(f"Signaal {sig} ontvangen, afsluiten...")
        hub.stop()
        sys.exit(0)

    signal.signal(signal.SIGINT, _signal_handler)
    signal.signal(signal.SIGTERM, _signal_handler)

    hub.run_forever()


if __name__ == "__main__":
    main()
