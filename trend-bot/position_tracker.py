import time
import threading
import logging
from dataclasses import dataclass, field
from typing import Optional

from config import MAX_HOLD_SECONDS


logger = logging.getLogger("OBScalper")


@dataclass
class ActivePosition:
    """Representeert een actieve positie."""
    asset: str
    direction: str             # "LONG" of "SHORT"
    entry_price: float
    size: float
    size_usd: float
    entry_time: float
    tp_price: float
    sl_price: float
    tp_oid: Optional[int] = None
    entry_oid: Optional[int] = None


class PositionTracker:
    """Houdt actieve posities bij op een thread-safe manier."""

    def __init__(self):
        self._positions = {}   # asset -> ActivePosition
        self._lock = threading.Lock()

    def open_position(self, asset, direction, entry_price, size, size_usd, tp_price, sl_price):
        """Registreer een nieuwe positie."""
        pos = ActivePosition(
            asset=asset,
            direction=direction,
            entry_price=entry_price,
            size=size,
            size_usd=size_usd,
            entry_time=time.time(),
            tp_price=tp_price,
            sl_price=sl_price,
        )
        with self._lock:
            self._positions[asset] = pos

        logger.info(
            "Positie geopend: %s %s @ %.2f (TP=%.2f, SL=%.2f, grootte=%.6f)",
            direction, asset, entry_price, tp_price, sl_price, size,
        )
        return pos

    def close_position(self, asset):
        """Sluit een positie en retourneer de positie-info, of None."""
        with self._lock:
            pos = self._positions.pop(asset, None)

        if pos:
            logger.info("Positie gesloten: %s %s", pos.direction, asset)
        return pos

    def has_position(self, asset):
        """Controleer of er een positie open is voor dit asset."""
        with self._lock:
            return asset in self._positions

    def has_any_position(self):
        """Controleer of er een positie open is voor EEN asset."""
        with self._lock:
            return len(self._positions) > 0

    def get_position(self, asset):
        """Haal positie-info op, of None."""
        with self._lock:
            return self._positions.get(asset)

    def check_timeouts(self, current_time=None):
        """
        Controleer welke posities de maximale houdtijd overschrijden.

        Retourneert een lijst van asset-namen die timeout hebben.
        """
        if current_time is None:
            current_time = time.time()

        timed_out = []
        with self._lock:
            for asset, pos in self._positions.items():
                elapsed = current_time - pos.entry_time
                if elapsed >= MAX_HOLD_SECONDS:
                    timed_out.append(asset)

        return timed_out

    def get_unrealized_pnl(self, asset, current_price):
        """
        Bereken de ongerealiseerde PnL voor een positie.

        Retourneert PnL in USD, of 0 als er geen positie is.
        """
        with self._lock:
            pos = self._positions.get(asset)

        if not pos or current_price <= 0:
            return 0.0

        if pos.direction == "LONG":
            pnl = (current_price - pos.entry_price) / pos.entry_price * pos.size_usd
        else:
            pnl = (pos.entry_price - current_price) / pos.entry_price * pos.size_usd

        return pnl

    def get_all_positions(self):
        """Retourneer een kopie van alle actieve posities."""
        with self._lock:
            return dict(self._positions)
