import requests
from logger_setup import setup_logger
from config import TELEGRAM_ENABLED, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID

logger = setup_logger()

class TelegramNotifier:
    def __init__(self):
        self.enabled = TELEGRAM_ENABLED
        self.token = TELEGRAM_BOT_TOKEN
        self.chat_id = TELEGRAM_CHAT_ID
        self.base_url = f"https://api.telegram.org/bot{self.token}/sendMessage"

    def send(self, message: str, silent: bool = False):
        if not self.enabled:
            return
        try:
            payload = {"chat_id": self.chat_id, "text": message, "parse_mode": "HTML", "disable_notification": silent}
            response = requests.post(self.base_url, json=payload, timeout=10)
            if response.status_code != 200:
                logger.warning(f"Telegram fout: {response.text}")
        except Exception as e:
            logger.error(f"Telegram kon bericht niet sturen: {e}")

    def notify_startup(self, assets, testnet):
        self.send(f"<b>NeuraLabs Bot Gestart</b>\nNetwerk: {'TESTNET' if testnet else 'MAINNET'}\nAssets: {', '.join(assets)}")

    def notify_position_open(self, asset, direction, size, entry_price, funding_rate):
        pass  # alleen dagrapport

    def notify_position_close(self, asset, direction, pnl, funding_collected, reason):
        pass  # alleen dagrapport

    def notify_risk_alert(self, message):
        pass  # alleen dagrapport

    def notify_daily_summary(self, total_pnl, funding_earned, trades, win_rate):
        self.send(f"<b>DAGELIJKS RAPPORT</b>\nPnL: ${total_pnl:+.2f}\nFunding: ${funding_earned:.4f}\nTrades: {trades}\nWin Rate: {win_rate:.1f}%")

    def notify_shutdown(self, reason):
        self.send(f"<b>Bot Gestopt</b>\nReden: {reason}")
