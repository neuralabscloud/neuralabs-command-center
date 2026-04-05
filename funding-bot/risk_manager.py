from datetime import datetime, date
from typing import Dict
from logger_setup import setup_logger
from config import MAX_DAILY_LOSS_PCT, MAX_DRAWDOWN_PCT, MAX_OPEN_POSITIONS

logger = setup_logger()

class RiskManager:
    def __init__(self):
        self.daily_pnl = 0.0
        self.daily_funding_earned = 0.0
        self.session_start_balance = 0.0
        self.peak_balance = 0.0
        self.current_balance = 0.0
        self.today = date.today()
        self.daily_trades = 0
        self.winning_trades = 0
        self.total_trades = 0
        self.total_funding_earned = 0.0
        self.total_pnl = 0.0
        self.kill_switch = False
        self.kill_reason = ""

    def set_initial_balance(self, balance):
        self.session_start_balance = balance
        self.peak_balance = balance
        self.current_balance = balance
        logger.info(f"Startbalans ingesteld: ${balance:.2f}")

    def update_balance(self, new_balance):
        self.current_balance = new_balance
        if new_balance > self.peak_balance:
            self.peak_balance = new_balance

    def check_daily_reset(self):
        today = date.today()
        if today != self.today:
            logger.info(f"Nieuwe dag - dagelijkse stats gereset. Vorige dag PnL: ${self.daily_pnl:+.2f}")
            self.daily_pnl = 0.0
            self.daily_funding_earned = 0.0
            self.daily_trades = 0
            self.winning_trades = 0
            self.today = today

    def can_open_position(self, open_positions_count):
        self.check_daily_reset()
        if self.kill_switch:
            return False, f"Kill switch actief: {self.kill_reason}"
        if open_positions_count >= MAX_OPEN_POSITIONS:
            return False, f"Max posities bereikt ({MAX_OPEN_POSITIONS})"
        max_daily_loss = self.session_start_balance * MAX_DAILY_LOSS_PCT
        if self.daily_pnl <= -max_daily_loss:
            self.activate_kill_switch(f"Dagelijks verlies limiet bereikt (${self.daily_pnl:.2f} / limiet ${max_daily_loss:.2f})")
            return False, self.kill_reason
        if self.peak_balance > 0:
            drawdown = ((self.peak_balance - self.current_balance) / self.peak_balance) * 100
            if drawdown >= MAX_DRAWDOWN_PCT:
                self.activate_kill_switch(f"Max drawdown bereikt ({drawdown:.1f}%)")
                return False, self.kill_reason
        return True, "OK"

    def record_trade_close(self, pnl, funding):
        self.daily_pnl += pnl
        self.total_pnl += pnl
        self.daily_funding_earned += funding
        self.total_funding_earned += funding
        self.daily_trades += 1
        self.total_trades += 1
        if pnl >= 0:
            self.winning_trades += 1

    def get_win_rate(self):
        return 0.0 if self.total_trades == 0 else (self.winning_trades / self.total_trades) * 100

    def activate_kill_switch(self, reason):
        self.kill_switch = True
        self.kill_reason = reason
        logger.critical(f"KILL SWITCH GEACTIVEERD: {reason}")

    def deactivate_kill_switch(self):
        self.kill_switch = False
        self.kill_reason = ""
        logger.warning("Kill switch gedeactiveerd")

    def get_status_report(self):
        drawdown = 0.0
        if self.peak_balance > 0:
            drawdown = ((self.peak_balance - self.current_balance) / self.peak_balance) * 100
        return {
            "balance": self.current_balance,
            "daily_pnl": self.daily_pnl,
            "total_pnl": self.total_pnl,
            "funding_earned_today": self.daily_funding_earned,
            "total_funding_earned": self.total_funding_earned,
            "drawdown_pct": drawdown,
            "daily_trades": self.daily_trades,
            "total_trades": self.total_trades,
            "win_rate": self.get_win_rate(),
            "kill_switch": self.kill_switch,
            "kill_reason": self.kill_reason
        }
