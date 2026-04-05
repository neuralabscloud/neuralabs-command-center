import logging
import requests

from config import TELEGRAM_ENABLED, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID


logger = logging.getLogger("MeanRevBot")


class Notifier:
    """Telegram notificaties voor de Mean-Reversion Bot."""

    def __init__(self):
        self._enabled = TELEGRAM_ENABLED
        self._token = TELEGRAM_BOT_TOKEN
        self._chat_id = TELEGRAM_CHAT_ID

    def send(self, msg):
        if not self._enabled or not self._token or not self._chat_id:
            return
        url = f"https://api.telegram.org/bot{self._token}/sendMessage"
        payload = {
            "chat_id": self._chat_id,
            "text": msg,
            "parse_mode": "HTML",
            "disable_web_page_preview": True,
        }
        try:
            resp = requests.post(url, json=payload, timeout=10)
            if resp.status_code != 200:
                logger.debug("Telegram fout: %s", resp.text)
        except Exception as e:
            logger.debug("Telegram verzending mislukt: %s", e)

    def notify_trade_opened(self, asset, direction, entry_price, size_usd, rsi):
        msg = (
            "<b>[MR] Trade Geopend</b>\n"
            f"Asset: <code>{asset}</code>\n"
            f"Richting: <code>{direction}</code>\n"
            f"Entry: <code>${entry_price:,.2f}</code>\n"
            f"Grootte: <code>${size_usd:.2f}</code>\n"
            f"RSI: <code>{rsi:.1f}</code>"
        )
        self.send(msg)

    def notify_trade_closed(self, asset, direction, entry_price, exit_price, pnl, hold_time, reason):
        pnl_sign = "+" if pnl >= 0 else ""
        msg = (
            "<b>[MR] Trade Gesloten</b>\n"
            f"Asset: <code>{asset}</code>\n"
            f"Richting: <code>{direction}</code>\n"
            f"Entry: <code>${entry_price:,.2f}</code>\n"
            f"Exit: <code>${exit_price:,.2f}</code>\n"
            f"PnL: <code>{pnl_sign}${pnl:.2f}</code>\n"
            f"Houdtijd: <code>{hold_time:.0f}s</code>\n"
            f"Reden: <code>{reason}</code>"
        )
        self.send(msg)

    def notify_kill_switch(self, reason):
        msg = (
            "<b>[MR] KILL SWITCH GEACTIVEERD</b>\n"
            f"Reden: <code>{reason}</code>"
        )
        self.send(msg)
