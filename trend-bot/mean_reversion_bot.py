"""
Trend Bot — Mean-Reversion Bot

Bollinger Band + RSI mean-reversion strategie op 15m candles.
Handelt alleen in range-bound markten (ADX < 25).
Complementair aan Bot 3 (liquidation) die alleen in trending markten handelt.
"""

import os
import json
import time
import logging
from datetime import datetime, timezone

from eth_account import Account
from hyperliquid.exchange import Exchange

from config import (
    PRIVATE_KEY, WALLET_ADDRESS, TESTNET, BASE_URL,
    ASSETS, LEVERAGE, POSITION_SIZE_PCT,
    TAKE_PROFIT_PCT, STOP_LOSS_PCT,
    TRAILING_STOP_ENABLED, TRAILING_STOP_ACTIVATION_PCT, TRAILING_STOP_DISTANCE_PCT,
    COOLDOWN_SECONDS, SCAN_INTERVAL, MAX_HOLD_SECONDS,
    MAX_DAILY_LOSS_PCT, MAX_TRADES_PER_DAY,
    TICK_SIZES, SZ_DECIMALS,
    DATA_FILE,
    RSI_OVERSOLD, RSI_OVERBOUGHT, ADX_MAX,
)
from logger_setup import setup_logger
from mean_reversion_engine import MeanReversionEngine
from order_manager import OrderManager
from notifier import Notifier

logger = logging.getLogger("MeanRevBot")

# Data client
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "data-hub"))
from client import HLDataClient as _HLDataClient
_data_client = _HLDataClient(wallet_address=WALLET_ADDRESS, base_url=BASE_URL)


def _info_post(payload):
    try:
        return _data_client.info_post(payload)
    except Exception as e:
        logger.error("REST fout: %s", e)
        return None


class MeanReversionBot:
    """Hyperliquid Mean-Reversion Bot — hoofdklasse."""

    def __init__(self):
        logger.info("=" * 60)
        logger.info("  Trend Bot — Mean-Reversion Bot")
        logger.info("  Bollinger Bands + RSI op 15m candles")
        logger.info("  Complementair aan Bot 3 (range vs trending)")
        logger.info("=" * 60)

        account = Account.from_key(PRIVATE_KEY)
        self._exchange = Exchange(account, BASE_URL, account_address=WALLET_ADDRESS)

        self._mr_engine = MeanReversionEngine()
        self._order_manager = OrderManager(self._exchange)
        self._notifier = Notifier()

        # Positie tracking
        self._position = None
        self._cooldown_until = {}  # asset -> timestamp

        # Statistieken
        self._daily_pnl = 0.0
        self._daily_trades = 0
        self._daily_wins = 0
        self._daily_losses = 0
        self._last_reset_date = datetime.now(timezone.utc).date()
        self._peak_balance = 0.0
        self._current_balance = 0.0
        self._kill_switch = False

        # Trade geschiedenis
        self._trade_history = []
        self._load_trade_history()

        self._running = False

        # Haal startbalans op
        self._current_balance = self._fetch_balance()
        self._peak_balance = self._current_balance

        logger.info("Netwerk: %s", "TESTNET" if TESTNET else "MAINNET")
        logger.info("Wallet: %s...%s", WALLET_ADDRESS[:10], WALLET_ADDRESS[-6:])
        logger.info("Assets: %s", ", ".join(ASSETS))
        logger.info("Balans: $%.2f", self._current_balance)
        logger.info("Positie: %.0f%% ($%.2f) | Leverage: %dx",
                     POSITION_SIZE_PCT * 100,
                     self._current_balance * POSITION_SIZE_PCT,
                     LEVERAGE)
        logger.info("TP: %.2f%% | SL: %.2f%% | Max hold: %ds",
                     TAKE_PROFIT_PCT, STOP_LOSS_PCT, MAX_HOLD_SECONDS)

    def _fetch_balance(self):
        """Haal account balans op."""
        try:
            state = _info_post({"type": "clearinghouseState", "user": WALLET_ADDRESS})
            if state:
                perp = float(state.get("marginSummary", {}).get("accountValue", 0))
                spot_data = _info_post({"type": "spotClearinghouseState", "user": WALLET_ADDRESS})
                spot_free = 0.0
                if spot_data:
                    for b in spot_data.get("balances", []):
                        if b.get("coin") == "USDC":
                            spot_free = float(b.get("total", 0)) - float(b.get("hold", 0))
                            break
                return perp + spot_free
        except Exception as e:
            logger.error("Balans ophalen mislukt: %s", e)
        return 100.0

    def _get_current_price(self, asset):
        """Haal huidige mid-price op."""
        try:
            prices = _info_post({"type": "allMids"})
            if prices:
                return float(prices.get(asset, 0))
        except Exception:
            pass
        return 0.0

    def _round_to_tick(self, price, asset):
        tick = TICK_SIZES.get(asset, 0.1)
        return round(round(price / tick) * tick, 10)

    # -- Risk management --

    def _check_daily_reset(self):
        today = datetime.now(timezone.utc).date()
        if today != self._last_reset_date:
            logger.info(
                "Dagelijkse reset: PnL=$%.2f, Trades=%d, Wins=%d, Losses=%d",
                self._daily_pnl, self._daily_trades, self._daily_wins, self._daily_losses,
            )
            self._kill_switch = False
            self._last_reset_date = today
            self._recalc_daily_stats()

    def _can_trade(self):
        if self._kill_switch:
            return False, "Kill switch actief"
        if self._daily_trades >= MAX_TRADES_PER_DAY:
            return False, f"Max trades per dag bereikt ({MAX_TRADES_PER_DAY})"
        loss_limit = self._current_balance * (MAX_DAILY_LOSS_PCT / 100)
        if self._daily_pnl <= -loss_limit:
            self._kill_switch = True
            logger.warning("KILL SWITCH: dagverlies $%.2f >= limiet $%.2f", abs(self._daily_pnl), loss_limit)
            return False, f"Dagverlies limiet bereikt (${abs(self._daily_pnl):.2f})"
        return True, "OK"

    # -- Position management --

    def _open_position(self, signal):
        """Open een positie op basis van een mean-reversion signaal."""
        if self._position is not None:
            return False

        # Cooldown check
        cooldown = self._cooldown_until.get(signal.asset, 0)
        if time.time() < cooldown:
            remaining = int(cooldown - time.time())
            logger.debug("%s: Cooldown actief, nog %ds", signal.asset, remaining)
            return False

        can, reason = self._can_trade()
        if not can:
            logger.info("Trade geblokkeerd: %s", reason)
            return False

        price = self._get_current_price(signal.asset)
        if price <= 0:
            return False

        # Positiegrootte berekenen
        size_usd = self._current_balance * POSITION_SIZE_PCT
        if size_usd < 11.0:
            size_usd = 11.0

        decimals = SZ_DECIMALS.get(signal.asset, 2)
        size = round(size_usd / price, decimals)

        # TP/SL berekenen
        # Dynamische TP: richting BB midden, maar begrensd
        if signal.direction == "LONG":
            # TP richting BB midden (boven entry)
            bb_tp_pct = (signal.bb_middle - price) / price * 100
            tp_pct = max(0.3, min(bb_tp_pct, TAKE_PROFIT_PCT))
            tp = self._round_to_tick(price * (1 + tp_pct / 100), signal.asset)
            sl = self._round_to_tick(price * (1 - STOP_LOSS_PCT / 100), signal.asset)
        else:
            # TP richting BB midden (onder entry)
            bb_tp_pct = (price - signal.bb_middle) / price * 100
            tp_pct = max(0.3, min(bb_tp_pct, TAKE_PROFIT_PCT))
            tp = self._round_to_tick(price * (1 - tp_pct / 100), signal.asset)
            sl = self._round_to_tick(price * (1 + STOP_LOSS_PCT / 100), signal.asset)

        # Market order plaatsen
        is_buy = signal.direction == "LONG"
        success = self._order_manager.place_market_order(signal.asset, is_buy, size)
        if not success:
            logger.error("Market order mislukt voor %s", signal.asset)
            return False

        # TP/SL trigger orders plaatsen op exchange
        self._place_exchange_tp_sl(signal.asset, signal.direction, size, tp, sl)

        self._position = {
            "asset": signal.asset,
            "direction": signal.direction,
            "entry_price": price,
            "size": size,
            "size_usd": size_usd,
            "tp": tp,
            "sl": sl,
            "tp_pct": tp_pct,
            "bb_middle": signal.bb_middle,
            "opened_at": time.time(),
            "trailing_active": False,
            "trailing_best_pnl": 0.0,
            "reason": signal.reason,
        }

        logger.info(
            "POSITIE GEOPEND: %s %s @ $%.2f | TP: $%.2f (%.2f%%) | SL: $%.2f | Size: $%.2f",
            signal.direction, signal.asset, price, tp, tp_pct, sl, size_usd,
        )
        logger.info("  BB midden: $%.2f | Reden: %s", signal.bb_middle, signal.reason)

        self._notifier.notify_trade_opened(
            signal.asset, signal.direction, price, size_usd, signal.rsi,
        )
        return True

    def _place_exchange_tp_sl(self, asset, direction, size, tp, sl):
        """Plaats TP/SL trigger orders op de exchange als vangnet."""
        try:
            tp = float(tp)
            sl = float(sl)
            is_buy = direction == "SHORT"  # tegenovergestelde richting
            # TP trigger order
            self._exchange.order(
                asset, is_buy, size, tp,
                {"trigger": {"triggerPx": str(tp), "isMarket": True, "tpsl": "tp"}},
                reduce_only=True,
            )
            # SL trigger order
            self._exchange.order(
                asset, is_buy, size, sl,
                {"trigger": {"triggerPx": str(sl), "isMarket": True, "tpsl": "sl"}},
                reduce_only=True,
            )
            logger.info("Exchange TP/SL orders geplaatst voor %s (TP=$%.2f, SL=$%.2f)", asset, tp, sl)
        except Exception as e:
            logger.warning("Exchange TP/SL plaatsen mislukt voor %s: %s — software fallback actief", asset, e)

    def _close_position(self, reason):
        """Sluit de huidige positie."""
        if self._position is None:
            return

        pos = self._position
        asset = pos["asset"]

        # Annuleer trigger orders
        try:
            self._exchange.cancel(asset, None)
        except Exception:
            pass

        price = self._get_current_price(asset)
        if price <= 0:
            price = pos["entry_price"]

        # Market close
        is_buy = pos["direction"] == "SHORT"
        self._order_manager.place_market_order(asset, is_buy, pos["size"], reduce_only=True)

        # PnL berekenen
        if pos["direction"] == "LONG":
            pnl = (price - pos["entry_price"]) / pos["entry_price"] * pos["size_usd"]
        else:
            pnl = (pos["entry_price"] - price) / pos["entry_price"] * pos["size_usd"]

        hold_time = time.time() - pos["opened_at"]

        # Statistieken bijwerken
        self._daily_pnl += pnl
        self._daily_trades += 1
        self._current_balance += pnl
        if pnl >= 0:
            self._daily_wins += 1
        else:
            self._daily_losses += 1
        if self._current_balance > self._peak_balance:
            self._peak_balance = self._current_balance

        # Cooldown instellen
        self._cooldown_until[asset] = time.time() + COOLDOWN_SECONDS

        # Trade opslaan
        trade_record = {
            "asset": asset,
            "direction": pos["direction"],
            "entry_price": pos["entry_price"],
            "exit_price": price,
            "size_usd": pos["size_usd"],
            "pnl": round(pnl, 4),
            "hold_time": round(hold_time, 1),
            "reason_open": pos["reason"],
            "reason_close": reason,
            "bb_middle": pos.get("bb_middle", 0),
            "ts": time.time(),
            "dt": datetime.now(timezone.utc).isoformat(),
        }
        self._trade_history.append(trade_record)
        self._save_trade_history()

        pnl_sign = "+" if pnl >= 0 else ""
        logger.info(
            "POSITIE GESLOTEN: %s %s | Entry: $%.2f | Exit: $%.2f | PnL: $%s%.2f | Houdtijd: %.0fs | %s",
            pos["direction"], asset, pos["entry_price"], price,
            pnl_sign, pnl, hold_time, reason,
        )

        self._notifier.notify_trade_closed(
            asset, pos["direction"], pos["entry_price"], price,
            pnl, hold_time, reason,
        )

        self._position = None

    def _check_exit_conditions(self):
        """Controleer of de positie gesloten moet worden."""
        if self._position is None:
            return

        pos = self._position
        price = self._get_current_price(pos["asset"])
        if price <= 0:
            return

        # Check of exchange de positie al gesloten heeft (TP/SL trigger)
        try:
            state = _info_post({"type": "clearinghouseState", "user": WALLET_ADDRESS})
            if state:
                has_position = False
                for p in state.get("assetPositions", []):
                    if p["position"]["coin"] == pos["asset"] and float(p["position"]["szi"]) != 0:
                        has_position = True
                        break
                if not has_position:
                    self._close_position("Exchange TP/SL trigger")
                    return
        except Exception:
            pass

        # PnL berekenen
        if pos["direction"] == "LONG":
            pnl_pct = (price - pos["entry_price"]) / pos["entry_price"] * 100
        else:
            pnl_pct = (pos["entry_price"] - price) / pos["entry_price"] * 100

        # Software SL fallback
        if pnl_pct <= -STOP_LOSS_PCT:
            self._close_position(f"Stop-Loss ({pnl_pct:.2f}%)")
            return

        # Software TP fallback
        if pnl_pct >= pos.get("tp_pct", TAKE_PROFIT_PCT):
            self._close_position(f"Take-Profit ({pnl_pct:.2f}%)")
            return

        # BB midden bereikt exit: als prijs BB midden passeert, doel bereikt
        bb_mid = pos.get("bb_middle", 0)
        if bb_mid > 0:
            if pos["direction"] == "LONG" and price >= bb_mid:
                self._close_position(f"BB midden bereikt (${bb_mid:.2f})")
                return
            if pos["direction"] == "SHORT" and price <= bb_mid:
                self._close_position(f"BB midden bereikt (${bb_mid:.2f})")
                return

        # Max houdtijd
        hold_time = time.time() - pos["opened_at"]
        if hold_time >= MAX_HOLD_SECONDS:
            self._close_position(f"Max houdtijd ({int(hold_time)}s)")
            return

        # Trailing stop
        if TRAILING_STOP_ENABLED:
            if pnl_pct >= TRAILING_STOP_ACTIVATION_PCT:
                if not pos["trailing_active"]:
                    pos["trailing_active"] = True
                    logger.info(
                        "Trailing stop geactiveerd: %s @ %.2f%% winst",
                        pos["asset"], pnl_pct,
                    )
                pos["trailing_best_pnl"] = max(pos["trailing_best_pnl"], pnl_pct)

            if pos["trailing_active"]:
                drawback = pos["trailing_best_pnl"] - pnl_pct
                if drawback >= TRAILING_STOP_DISTANCE_PCT:
                    self._close_position(
                        f"Trailing stop ({pos['trailing_best_pnl']:.1f}% -> {pnl_pct:.1f}%)"
                    )
                    return

    # -- Status --

    def _log_status(self):
        now_str = datetime.now(timezone.utc).strftime("%H:%M:%S")
        logger.info("-" * 60)
        logger.info("MEAN-REVERSION BOT STATUS - %s UTC", now_str)

        for asset in ASSETS:
            ind = self._mr_engine.get_indicators(asset)
            if ind:
                # Afstand tot bands
                dist_upper = (ind["bb_upper"] - ind["price"]) / ind["price"] * 100
                dist_lower = (ind["price"] - ind["bb_lower"]) / ind["price"] * 100
                logger.info(
                    "  %s  BB: $%.2f / $%.2f / $%.2f | RSI: %.1f | ADX: %.1f | Prijs: $%.2f",
                    asset.ljust(4), ind["bb_lower"], ind["bb_middle"], ind["bb_upper"],
                    ind["rsi"], ind["adx"], ind["price"],
                )
                logger.info(
                    "  %s  BB-breedte: %.2f%% | Afstand UB: %.2f%% | Afstand LB: %.2f%%",
                    asset.ljust(4), ind["bb_width_pct"], dist_upper, dist_lower,
                )
                # Toon of markt range of trending is
                market_type = "RANGE" if ind["adx"] < ADX_MAX else "TRENDING"
                logger.info("  %s  Markt: %s", asset.ljust(4), market_type)
            else:
                logger.info("  %s  Geen indicator data", asset.ljust(4))

            # Cooldown status
            cd = self._cooldown_until.get(asset, 0)
            if time.time() < cd:
                logger.info("  %s  Cooldown: nog %ds", asset.ljust(4), int(cd - time.time()))

        if self._position:
            pos = self._position
            price = self._get_current_price(pos["asset"])
            if pos["direction"] == "LONG":
                pnl = (price - pos["entry_price"]) / pos["entry_price"] * pos["size_usd"] if price > 0 else 0
            else:
                pnl = (pos["entry_price"] - price) / pos["entry_price"] * pos["size_usd"] if price > 0 else 0
            trail_str = f" [TRAILING best={pos['trailing_best_pnl']:.2f}%]" if pos["trailing_active"] else ""
            logger.info(
                "  POSITIE: %s %s @ $%.2f | PnL: $%+.2f | TP: $%.2f | SL: $%.2f%s",
                pos["direction"], pos["asset"], pos["entry_price"],
                pnl, pos["tp"], pos["sl"], trail_str,
            )
            logger.info("  BB midden target: $%.2f", pos.get("bb_middle", 0))
        else:
            logger.info("  Geen open positie")

        wr = (self._daily_wins / self._daily_trades * 100) if self._daily_trades > 0 else 0
        logger.info(
            "  Dag PnL: $%+.2f | Trades: %d/%d | WR: %.0f%% | Balans: $%.2f | Kill: %s",
            self._daily_pnl, self._daily_trades, MAX_TRADES_PER_DAY,
            wr, self._current_balance,
            "AAN" if self._kill_switch else "UIT",
        )
        logger.info("-" * 60)

    # -- Persistence --

    def _load_trade_history(self):
        if os.path.exists(DATA_FILE):
            try:
                with open(DATA_FILE, "r") as f:
                    self._trade_history = json.load(f)
                logger.info("Trade geschiedenis geladen: %d trades", len(self._trade_history))
            except Exception:
                self._trade_history = []
        else:
            data_dir = os.path.dirname(DATA_FILE)
            if data_dir:
                os.makedirs(data_dir, exist_ok=True)
        self._recalc_daily_stats()

    def _recalc_daily_stats(self):
        """Herbereken dagstats vanuit trade_history (inclusief trades van andere bots)."""
        today = datetime.now(timezone.utc).date()
        self._daily_pnl = 0.0
        self._daily_trades = 0
        self._daily_wins = 0
        self._daily_losses = 0
        for t in self._trade_history:
            dt_str = t.get("dt", "")
            if not dt_str:
                continue
            try:
                trade_date = datetime.fromisoformat(dt_str).date()
            except Exception:
                continue
            if trade_date == today:
                pnl = t.get("pnl", 0.0)
                self._daily_pnl += pnl
                self._daily_trades += 1
                if pnl >= 0:
                    self._daily_wins += 1
                else:
                    self._daily_losses += 1
        if self._daily_trades > 0:
            logger.info(
                "Dagstats hersteld vanuit history: PnL=$%.2f, Trades=%d, W=%d, L=%d",
                self._daily_pnl, self._daily_trades, self._daily_wins, self._daily_losses,
            )

    def _save_trade_history(self):
        try:
            data_dir = os.path.dirname(DATA_FILE)
            if data_dir:
                os.makedirs(data_dir, exist_ok=True)
            with open(DATA_FILE, "w") as f:
                json.dump(self._trade_history, f, indent=2)
        except Exception as e:
            logger.error("Trade history opslaan mislukt: %s", e)

    # -- Orphaned position cleanup --

    def _close_orphaned_positions(self):
        """Sluit posities die on-chain openstaan van een vorige sessie."""
        try:
            state = _info_post({"type": "clearinghouseState", "user": WALLET_ADDRESS})
            if not state:
                return
            for ap in state.get("assetPositions", []):
                pos = ap.get("position", {})
                coin = pos.get("coin", "")
                szi = float(pos.get("szi", 0))
                if coin in ASSETS and abs(szi) > 0:
                    direction = "LONG" if szi > 0 else "SHORT"
                    entry = float(pos.get("entryPx", 0))
                    logger.warning(
                        "Orphaned positie gevonden: %s %s @ $%.2f — sluiten",
                        direction, coin, entry,
                    )
                    try:
                        self._exchange.market_close(coin)
                        logger.info("Orphaned positie gesloten: %s", coin)
                    except Exception as e:
                        logger.error("Kan orphaned positie niet sluiten: %s: %s", coin, e)
        except Exception as e:
            logger.warning("Orphaned positie check mislukt: %s", e)

    # -- Main loop --

    def run(self):
        logger.info("Bot starten...")

        # Leverage instellen
        for asset in ASSETS:
            try:
                self._exchange.update_leverage(LEVERAGE, asset)
                logger.info("Leverage ingesteld: %dx voor %s", LEVERAGE, asset)
            except Exception as e:
                logger.error("Leverage instellen mislukt voor %s: %s", asset, e)

        # Sluit orphaned posities
        self._close_orphaned_positions()

        self._running = True
        scan_count = 0

        logger.info("Scanning elke %d seconden op %s candles...", SCAN_INTERVAL, "15m")
        logger.info("Strategie: LONG bij lower BB + RSI<%d | SHORT bij upper BB + RSI>%d | ADX<%d",
                     RSI_OVERSOLD, RSI_OVERBOUGHT, ADX_MAX)

        while self._running:
            try:
                self._check_daily_reset()

                # Check exit conditions voor open positie
                if self._position:
                    self._check_exit_conditions()

                # Zoek nieuwe signalen (alleen als geen positie open)
                if self._position is None:
                    can, reason = self._can_trade()
                    if can:
                        for asset in ASSETS:
                            signal = self._mr_engine.check_signal(asset)
                            if signal:
                                if self._open_position(signal):
                                    break  # max 1 positie

                # Status loggen elke 5 scans (~5 min)
                if scan_count % 5 == 0:
                    self._log_status()

                # Balans update elke 30 scans (~30 min)
                if scan_count % 30 == 0 and scan_count > 0:
                    new_bal = self._fetch_balance()
                    if new_bal > 0:
                        self._current_balance = new_bal
                        if new_bal > self._peak_balance:
                            self._peak_balance = new_bal

                scan_count += 1
                time.sleep(SCAN_INTERVAL)

            except KeyboardInterrupt:
                logger.info("Keyboard interrupt")
                break
            except Exception as e:
                logger.error("Fout in hoofdlus: %s", e, exc_info=True)
                time.sleep(30)

        self.graceful_shutdown()

    def graceful_shutdown(self):
        logger.info("Graceful shutdown gestart...")
        self._running = False

        if self._position:
            self._close_position("Bot shutdown")

        logger.info(
            "Sessie: PnL $%+.2f | Trades %d | Wins %d | Losses %d",
            self._daily_pnl, self._daily_trades, self._daily_wins, self._daily_losses,
        )
        logger.info("Graceful shutdown voltooid")
