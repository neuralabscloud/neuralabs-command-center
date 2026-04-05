import time
import threading
import logging
from datetime import datetime, timezone

from config import MAX_DAILY_LOSS_USD, MAX_DRAWDOWN_PCT, MAX_TRADES_PER_HOUR


logger = logging.getLogger("OBScalper")


class RiskManager:
    """Beheert risicobeperkingen en dagelijkse statistieken."""

    def __init__(self, starting_balance_usd=0.0):
        self._lock = threading.Lock()
        self._daily_pnl = 0.0
        self._peak_balance = starting_balance_usd
        self._current_balance = starting_balance_usd
        self._trade_timestamps = []      # timestamps van recente trades
        self._trade_count_today = 0
        self._wins_today = 0
        self._losses_today = 0
        self._last_reset_date = datetime.now(timezone.utc).date()
        self._kill_switch = False

    @property
    def kill_switch(self):
        """Kill switch status - als True, geen nieuwe trades."""
        with self._lock:
            return self._kill_switch

    @kill_switch.setter
    def kill_switch(self, value):
        with self._lock:
            self._kill_switch = value
        if value:
            logger.warning("KILL SWITCH GEACTIVEERD")

    def can_trade(self):
        """
        Controleer of handelen is toegestaan.

        Retourneert (bool, reden_string).
        """
        with self._lock:
            if self._kill_switch:
                return False, "Kill switch is actief"

            # Dagelijks verlies limiet
            if self._daily_pnl <= -MAX_DAILY_LOSS_USD:
                return False, (
                    "Dagelijks verlies limiet bereikt: $%.2f (max: $%.2f)"
                    % (self._daily_pnl, -MAX_DAILY_LOSS_USD)
                )

            # Drawdown controle
            if self._peak_balance > 0:
                drawdown = (
                    (self._peak_balance - self._current_balance)
                    / self._peak_balance * 100
                )
                if drawdown >= MAX_DRAWDOWN_PCT:
                    return False, (
                        "Maximale drawdown bereikt: %.2f%% (max: %.2f%%)"
                        % (drawdown, MAX_DRAWDOWN_PCT)
                    )

            # Trades per uur limiet
            now = time.time()
            cutoff = now - 3600
            self._trade_timestamps = [
                ts for ts in self._trade_timestamps if ts >= cutoff
            ]
            if len(self._trade_timestamps) >= MAX_TRADES_PER_HOUR:
                return False, (
                    "Maximum trades per uur bereikt: %d (max: %d)"
                    % (len(self._trade_timestamps), MAX_TRADES_PER_HOUR)
                )

            return True, "OK"

    def record_trade(self, pnl_usd):
        """Registreer een voltooide trade."""
        with self._lock:
            self._daily_pnl += pnl_usd
            self._current_balance += pnl_usd
            self._trade_count_today += 1
            self._trade_timestamps.append(time.time())

            if pnl_usd >= 0:
                self._wins_today += 1
            else:
                self._losses_today += 1

            if self._current_balance > self._peak_balance:
                self._peak_balance = self._current_balance

        logger.info(
            "Trade geregistreerd: PnL=$%.2f | Dag PnL=$%.2f | Trades vandaag=%d",
            pnl_usd, self._daily_pnl, self._trade_count_today,
        )

    def check_daily_reset(self):
        """Controleer of het een nieuwe dag is (UTC) en reset statistieken."""
        today = datetime.now(timezone.utc).date()
        with self._lock:
            if today != self._last_reset_date:
                logger.info(
                    "Dagelijkse reset: PnL=$%.2f, Trades=%d, Wins=%d, Losses=%d",
                    self._daily_pnl,
                    self._trade_count_today,
                    self._wins_today,
                    self._losses_today,
                )
                self._daily_pnl = 0.0
                self._trade_count_today = 0
                self._wins_today = 0
                self._losses_today = 0
                self._trade_timestamps.clear()
                self._last_reset_date = today

    def get_status(self):
        """Retourneer alle risico-statistieken als dictionary."""
        with self._lock:
            drawdown = 0.0
            if self._peak_balance > 0:
                drawdown = (
                    (self._peak_balance - self._current_balance)
                    / self._peak_balance * 100
                )

            now = time.time()
            trades_last_hour = len(
                [ts for ts in self._trade_timestamps if ts >= now - 3600]
            )

            return {
                "daily_pnl": self._daily_pnl,
                "current_balance": self._current_balance,
                "peak_balance": self._peak_balance,
                "drawdown_pct": drawdown,
                "trade_count_today": self._trade_count_today,
                "trades_last_hour": trades_last_hour,
                "wins_today": self._wins_today,
                "losses_today": self._losses_today,
                "kill_switch": self._kill_switch,
            }

    def update_balance(self, balance):
        """Werk het saldo bij (bijv. na ophalen van exchange)."""
        with self._lock:
            self._current_balance = balance
            if balance > self._peak_balance:
                self._peak_balance = balance
