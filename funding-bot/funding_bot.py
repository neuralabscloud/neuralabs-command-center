import sys
import time
import json
import os
import requests
from datetime import datetime
from typing import Dict, List
from eth_account import Account
from hyperliquid.exchange import Exchange
from hyperliquid.utils import constants

from config import (
    PRIVATE_KEY, WALLET_ADDRESS, TESTNET,
    FALLBACK_SPOT_PAIR,
    FUNDING_ENTRY_THRESHOLD,
    FUNDING_EXIT_THRESHOLD, FUNDING_SCAN_INTERVAL,
    POSITION_SIZE_PCT, DATA_FILE,
    MIN_OPEN_INTEREST_USD,
)
from risk_manager import RiskManager
from notifier import TelegramNotifier
from logger_setup import setup_logger

logger = setup_logger(name="FundingBot", log_file="logs/neuralabs_funding_bot.log")
BASE_URL = constants.TESTNET_API_URL if TESTNET else constants.MAINNET_API_URL

# ── Data client (centraal via Redis, fallback naar directe API) ──
sys.path.insert(0, "/root/neuralabs-data")
from client import HLDataClient
_data_client = HLDataClient(wallet_address=WALLET_ADDRESS, base_url=BASE_URL)

def info_post(payload: dict) -> dict:
    return _data_client.info_post(payload)


class Position:
    """
    Vertegenwoordigt een delta-neutraal paar:

    Positieve funding (longs betalen shorts):
      - SHORT perp + LONG spot  -> ontvang funding

    Negatieve funding (shorts betalen longs):
      - LONG perp + SHORT spot  -> ontvang funding
    """
    def __init__(self, asset, direction, size_usd, perp_entry_price, spot_entry_price,
                 perp_size, spot_size, funding_at_entry):
        self.asset             = asset
        self.direction         = direction   # "SHORT_PERP" of "LONG_PERP"
        self.size_usd          = size_usd
        self.perp_entry_price  = perp_entry_price
        self.spot_entry_price  = spot_entry_price
        self.perp_size         = perp_size
        self.spot_size         = spot_size
        self.funding_at_entry  = funding_at_entry
        self.opened_at         = datetime.utcnow().isoformat()
        self.funding_collected = 0.0

    def to_dict(self):
        return self.__dict__


class FundingArbitrageBot:
    def __init__(self):
        logger.info("=" * 55)
        logger.info("  NeuraLabs - Funding Rate Arbitrage Bot")
        logger.info("  Delta-Neutraal: SHORT Perp + LONG Spot")
        logger.info("  Modus: Dynamische asset discovery")
        logger.info("=" * 55)
        self.account  = Account.from_key(PRIVATE_KEY)
        spot_meta     = self._fetch_spot_meta()
        self.exchange = Exchange(
            self.account, BASE_URL,
            account_address=WALLET_ADDRESS,
            spot_meta=spot_meta,
        )
        self.risk     = RiskManager()
        self.notifier = TelegramNotifier()
        self.open_positions: Dict[str, Position] = {}
        self.trade_history: List[dict] = []
        self.running  = False

        # Dynamisch: ontdek alle perp coins met een spot pair
        self.spot_pair_map: Dict[str, str] = {}
        self._discover_spot_pairs()

        self._load_trade_history()
        logger.info(f"Netwerk: {'TESTNET' if TESTNET else 'MAINNET'}")
        logger.info(f"Wallet:  {WALLET_ADDRESS[:10]}...{WALLET_ADDRESS[-6:]}")
        logger.info(f"Tradeable assets: {len(self.spot_pair_map)} coins met perp+spot")
        logger.info(f"Min OI filter: ${MIN_OPEN_INTEREST_USD:,.0f}")
        logger.info(f"Entry drempel: {FUNDING_ENTRY_THRESHOLD}% ann. (alleen positieve funding)")
        logger.info("Hyperliquid connectie OK")

    # ------------------------------------------------------------------
    # Asset discovery
    # ------------------------------------------------------------------

    def _discover_spot_pairs(self):
        try:
            meta = info_post({"type": "metaAndAssetCtxs"})
            perp_names = set(a["name"] for a in meta[0]["universe"])

            spot_meta = info_post({"type": "spotMeta"})
            tokens = {t["index"]: t["name"] for t in spot_meta["tokens"]}

            found = {}
            for pair in spot_meta["universe"]:
                base_name = tokens.get(pair["tokens"][0], "")
                quote_name = tokens.get(pair["tokens"][1], "")
                if quote_name != "USDC":
                    continue

                # Gebruik het name veld als coin identifier (bijv. "PURR/USDC" of "@32")
                spot_id = pair.get("name", f"@{pair['index']}")

                if base_name.startswith("U") and base_name[1:] in perp_names:
                    found[base_name[1:]] = spot_id
                elif base_name in perp_names:
                    if base_name not in found:
                        found[base_name] = spot_id

            # Sanity check: perp en spot prijs moeten binnen 5% van elkaar liggen.
            # Vangt naamcollisies (bv. UWLD spot @ $1.75 vs WLD perp @ $0.32).
            try:
                mids = info_post({"type": "allMids"})
            except Exception as e:
                logger.warning(f"Sanity-check mids ophalen mislukt: {e}")
                mids = {}
            filtered = {}
            for asset, spot_id in found.items():
                perp_px = float(mids.get(asset, 0) or 0)
                spot_px = float(mids.get(spot_id, 0) or 0)
                if perp_px <= 0 or spot_px <= 0:
                    logger.warning(f"  Skip mapping {asset} -> {spot_id}: prijs niet beschikbaar (perp={perp_px}, spot={spot_px})")
                    continue
                diff_pct = abs(perp_px - spot_px) / perp_px * 100
                if diff_pct > 5.0:
                    logger.warning(f"  Skip mapping {asset} -> {spot_id}: prijs-divergentie {diff_pct:.1f}% (perp=${perp_px:.4f}, spot=${spot_px:.4f})")
                    continue
                filtered[asset] = spot_id

            self.spot_pair_map = filtered
            logger.info(f"Discovery: {len(filtered)} perp<->spot paren gevonden (na sanity check)")
            for name, sid in sorted(filtered.items()):
                logger.info(f"  {name:>8} -> {sid}")

        except Exception as e:
            logger.warning(f"Discovery mislukt: {e} — fallback naar hardcoded pairs")
            self.spot_pair_map = dict(FALLBACK_SPOT_PAIR)

    # ------------------------------------------------------------------
    # Hulpmethoden
    # ------------------------------------------------------------------

    def _fetch_spot_meta(self):
        try:
            r = requests.post(f"{BASE_URL}/info", json={"type": "spotMeta"}, timeout=10)
            r.raise_for_status()
            return r.json()
        except Exception as e:
            logger.warning(f"Spot meta ophalen mislukt: {e}")
            return None

    def get_account_balance(self):
        try:
            spot = info_post({"type": "spotClearinghouseState", "user": WALLET_ADDRESS})
            usdc = next((b for b in spot.get("balances", []) if b["coin"] == "USDC"), None)
            return float(usdc.get("total", 0)) if usdc else 0.0
        except Exception as e:
            logger.error(f"Balans ophalen mislukt: {e}")
            return 0.0

    def get_funding_rates(self):
        rates = {}
        try:
            data     = info_post({"type": "metaAndAssetCtxs"})
            universe = data[0].get("universe", [])
            ctxs     = data[1]
            for i, asset in enumerate(universe):
                name = asset.get("name", "")
                if name in self.spot_pair_map:
                    try:
                        funding_8h = float(ctxs[i].get("funding", 0))
                        oi = float(ctxs[i].get("openInterest", 0))
                        mark_px = float(ctxs[i].get("markPx", 0))
                        oi_usd = oi * mark_px
                        rates[name] = {
                            "rate": funding_8h * 3 * 365 * 100,
                            "oi_usd": oi_usd,
                        }
                    except (IndexError, KeyError, ValueError):
                        pass
        except Exception as e:
            logger.error(f"Funding rates ophalen mislukt: {e}")
        return rates

    def get_current_price(self, asset):
        try:
            data = info_post({"type": "allMids"})
            return float(data.get(asset, 0))
        except Exception as e:
            logger.error(f"Prijs ophalen mislukt voor {asset}: {e}")
            return 0.0

    def get_spot_price(self, asset):
        spot_coin = self.spot_pair_map.get(asset)
        if not spot_coin:
            return 0.0
        try:
            data = info_post({"type": "allMids"})
            price = float(data.get(spot_coin, 0))
            # Fallback: probeer ASSET/USDC als @index niet werkt
            if price <= 0:
                price = float(data.get(f"{asset}/USDC", 0))
            return price
        except Exception as e:
            logger.error(f"Spot prijs ophalen mislukt voor {asset}: {e}")
            return 0.0

    def get_sz_decimals(self, asset):
        try:
            data = info_post({"type": "meta"})
            for coin in data.get("universe", []):
                if coin.get("name") == asset:
                    return coin.get("szDecimals", 3)
        except Exception:
            pass
        return 3

    # ------------------------------------------------------------------
    # Positie openen — bidirectioneel
    # ------------------------------------------------------------------

    def _fill_sz(self, result):
        """Haal totale gefilled grootte uit een order response."""
        try:
            statuses = result.get("response", {}).get("data", {}).get("statuses", [])
            total = 0.0
            for s in statuses:
                if "filled" in s:
                    total += float(s["filled"].get("totalSz", 0))
            return total
        except Exception:
            return 0.0

    def _cancel_open_orders(self, asset):
        """Annuleer alle openstaande orders voor een asset voordat we een nieuwe positie openen."""
        try:
            open_orders = info_post({"type": "openOrders", "user": WALLET_ADDRESS})
            asset_orders = [o for o in open_orders if o.get("coin") == asset]
            if not asset_orders:
                return
            cancel_requests = [{"coin": asset, "oid": int(o["oid"])} for o in asset_orders]
            result = self.exchange.bulk_cancel(cancel_requests)
            logger.info(f"Open orders geannuleerd voor {asset}: {len(cancel_requests)} orders, result: {result}")
        except Exception as e:
            logger.warning(f"Fout bij annuleren open orders voor {asset}: {e}")

    def open_position(self, asset, funding_rate):
        """
        Alleen positieve funding: SHORT perp + LONG spot.
        Longs betalen shorts -> wij ontvangen funding op de short perp.
        HL heeft geen spot shorting, dus negatieve funding is niet tradeable.

        NB: Er worden geen traditionele SL orders geplaatst. Dit is bewust: de strategie
        is delta-neutraal (short perp + long spot), waardoor het prijsrisico gehedged is.
        Het enige risico is basis risk (verschil perp vs spot prijs), niet directioneel
        prijsrisico. Funding rate daling wordt bewaakt via de exit threshold.
        """
        can_open, reason = self.risk.can_open_position(len(self.open_positions))
        if not can_open:
            logger.warning(f"Positie geblokkeerd: {reason}")
            return False
        if asset in self.open_positions:
            logger.info(f"Positie al open voor {asset}, skip")
            return False
        if asset not in self.spot_pair_map:
            logger.warning(f"Geen spot pair beschikbaar voor {asset}, skip")
            return False
        if funding_rate <= 0:
            logger.info(f"Skip {asset}: negatieve funding ({funding_rate:+.2f}%), HL heeft geen spot shorting")
            return False

        perp_price = self.get_current_price(asset)
        spot_price = self.get_spot_price(asset)
        if perp_price <= 0 or spot_price <= 0:
            logger.error(f"Ongeldige prijzen voor {asset}: perp={perp_price} spot={spot_price}")
            return False

        balance = self.get_account_balance()
        if balance <= 0:
            return False

        position_size_usd = round(balance * POSITION_SIZE_PCT, 2)
        sz_decimals       = self.get_sz_decimals(asset)

        perp_size = round(position_size_usd / perp_price, sz_decimals)
        spot_size = round(position_size_usd / spot_price, sz_decimals)

        if perp_size <= 0 or spot_size <= 0:
            return False

        # Minimale positie grootte check ($10 notional)
        if perp_size * perp_price < 10:
            logger.warning(f"Positie te klein: ${perp_size * perp_price:.2f} < $10 minimum")
            return False

        # Annuleer eventuele openstaande orders voor deze asset
        self._cancel_open_orders(asset)

        spot_pair = self.spot_pair_map[asset]
        direction = "SHORT_PERP"

        logger.info(
            f"Delta-neutraal paar openen: {asset} | SHORT perp + LONG spot | "
            f"${position_size_usd:.2f} | Funding: {funding_rate:+.2f}% ann."
        )
        logger.info(f"  Stap 1: SHORT perp {asset} {perp_size} @ ~${perp_price:,.2f}")
        logger.info(f"  Stap 2: LONG  spot {spot_pair} {spot_size} @ ~${spot_price:,.2f}")

        # --- Stap 1: SHORT perp ---
        try:
            result = self.exchange.market_open(asset, is_buy=False, sz=perp_size, slippage=0.01)
            if result.get("status") != "ok":
                logger.error(f"Perp short mislukt: {result}")
                return False
            logger.info(f"Perp short OK: {asset} {perp_size}")
        except Exception as e:
            logger.error(f"Perp short exceptie voor {asset}: {e}")
            return False

        # --- Stap 2: LONG spot ---
        try:
            result = self.exchange.market_open(spot_pair, is_buy=True, sz=spot_size, slippage=0.01)
            if result.get("status") != "ok":
                logger.error(f"Spot buy mislukt: {result} — perp wordt teruggedraaid")
                self._close_perp(asset)
                return False
            # Verifieer fill: illiquide spots kunnen "ok" terugkeren zonder te vullen.
            filled_sz = self._fill_sz(result)
            min_required = spot_size * 0.95
            if filled_sz < min_required:
                logger.error(
                    f"Spot fill te klein voor {asset}: {filled_sz} < {min_required:.6f} (gevraagd {spot_size}) "
                    f"— partial spot verkopen en perp terugdraaien"
                )
                if filled_sz > 0:
                    try:
                        self.exchange.market_open(spot_pair, is_buy=False, sz=filled_sz, slippage=0.01)
                    except Exception as e:
                        logger.error(f"Partial spot verkoop mislukt: {e} — handmatig controleren")
                self._close_perp(asset)
                return False
            logger.info(f"Spot buy OK: {spot_pair} filled={filled_sz} (gevraagd {spot_size})")
        except Exception as e:
            logger.error(f"Spot buy exceptie voor {asset}: {e} — perp wordt teruggedraaid")
            self._close_perp(asset)
            return False

        self.open_positions[asset] = Position(
            asset=asset,
            direction=direction,
            size_usd=position_size_usd,
            perp_entry_price=perp_price,
            spot_entry_price=spot_price,
            perp_size=perp_size,
            spot_size=spot_size,
            funding_at_entry=funding_rate,
        )
        logger.info(
            f"Positie geopend: {asset} SHORT_PERP | "
            f"Perp @ ${perp_price:,.2f} | Spot @ ${spot_price:,.2f} | "
            f"Funding: {funding_rate:+.2f}% ann."
        )
        self.notifier.notify_position_open(asset, direction, position_size_usd, perp_price, funding_rate)
        return True

    # ------------------------------------------------------------------
    # Positie sluiten — bidirectioneel
    # ------------------------------------------------------------------

    def close_position(self, asset, reason):
        if asset not in self.open_positions:
            return False
        position = self.open_positions[asset]

        perp_price = self.get_current_price(asset)
        spot_price = self.get_spot_price(asset)
        spot_pair  = self.spot_pair_map.get(asset, "")

        logger.info(f"Positie sluiten: {asset} {position.direction} | Reden: {reason}")

        perp_ok = False
        spot_ok = False

        # Sluit perp
        try:
            result = self.exchange.market_close(asset, sz=None, slippage=0.01)
            if result.get("status") == "ok":
                perp_ok = True
                logger.info(f"Perp close OK: {asset}")
            else:
                logger.error(f"Perp close mislukt: {result}")
        except Exception as e:
            logger.error(f"Perp close exceptie: {e}")

        # Sluit spot (verkoop — we hadden LONG spot)
        try:
            result = self.exchange.market_open(spot_pair, is_buy=False, sz=position.spot_size, slippage=0.01)
            if result.get("status") == "ok":
                spot_ok = True
                logger.info(f"Spot sell OK: {spot_pair} {position.spot_size}")
            else:
                logger.error(f"Spot sell mislukt: {result}")
        except Exception as e:
            logger.error(f"Spot sell exceptie: {e}")

        if not perp_ok or not spot_ok:
            logger.warning(
                f"Positie {asset} gedeeltelijk gesloten — "
                f"perp={'OK' if perp_ok else 'MISLUKT'} spot={'OK' if spot_ok else 'MISLUKT'}. "
                f"Controleer de wallet handmatig."
            )

        # PnL berekening (SHORT perp + LONG spot)
        perp_pnl = (position.perp_entry_price - perp_price) / position.perp_entry_price * position.size_usd
        spot_pnl = (spot_price - position.spot_entry_price) / position.spot_entry_price * position.size_usd

        price_pnl = perp_pnl + spot_pnl
        total_pnl = price_pnl + position.funding_collected

        self.risk.record_trade_close(total_pnl, position.funding_collected)
        self.trade_history.append({
            **position.to_dict(),
            "close_perp_price": perp_price,
            "close_spot_price": spot_price,
            "close_reason": reason,
            "closed_at": datetime.utcnow().isoformat(),
            "perp_pnl": perp_pnl,
            "spot_pnl": spot_pnl,
            "total_pnl": total_pnl,
        })
        self._save_trade_history()
        del self.open_positions[asset]

        logger.info(
            f"Positie gesloten: {asset} {position.direction} | "
            f"Perp PnL: ${perp_pnl:+.4f} | Spot PnL: ${spot_pnl:+.4f} | "
            f"Funding: ${position.funding_collected:+.4f} | Totaal: ${total_pnl:+.4f} | "
            f"Reden: {reason}"
        )
        self.notifier.notify_position_close(asset, position.direction, total_pnl, position.funding_collected, reason)
        return True

    def _close_perp(self, asset):
        try:
            result = self.exchange.market_close(asset, sz=None, slippage=0.01)
            logger.info(f"Perp teruggedraaid voor {asset}: {result.get('status')}")
        except Exception as e:
            logger.error(f"Perp terugdraaien mislukt voor {asset}: {e}")

    # ------------------------------------------------------------------
    # Funding incasso bijhouden
    # ------------------------------------------------------------------

    def _update_funding_collected(self):
        if not self.open_positions:
            return
        try:
            earliest_ms = min(
                int(datetime.fromisoformat(p.opened_at).timestamp() * 1000)
                for p in self.open_positions.values()
            )
            data = info_post({
                "type": "userFunding",
                "user": WALLET_ADDRESS,
                "startTime": earliest_ms,
            })
            asset_funding: Dict[str, float] = {}
            for entry in data:
                delta = entry.get("delta", {})
                coin  = delta.get("coin", "")
                if coin in self.open_positions:
                    usdc = float(delta.get("usdc", 0))
                    asset_funding[coin] = asset_funding.get(coin, 0.0) + usdc
            for asset, total in asset_funding.items():
                self.open_positions[asset].funding_collected = total
        except Exception as e:
            logger.warning(f"Funding betalingen ophalen mislukt: {e}")

    # ------------------------------------------------------------------
    # Controleer open posities — bidirectioneel
    # ------------------------------------------------------------------

    def check_open_positions(self, funding_rates):
        self._update_funding_collected()
        for asset in list(self.open_positions.keys()):
            info = funding_rates.get(asset)
            current_funding = info["rate"] if info else 0

            # Funding onder exit drempel -> sluiten
            if current_funding < FUNDING_EXIT_THRESHOLD:
                self.close_position(asset, f"Funding te laag ({current_funding:+.2f}% < {FUNDING_EXIT_THRESHOLD}%)")
                continue

    # ------------------------------------------------------------------
    # NeuraIntel regime check
    # ------------------------------------------------------------------

    def _get_regime_multiplier(self, bot_key: str) -> float:
        """Get size multiplier from NeuraIntel. Fail open = 1.0"""
        try:
            directives = _data_client.get_directives()
            if not directives:
                return 1.0
            bot_directive = directives.get("bots", {}).get(bot_key, {})
            if not bot_directive.get("active", True):
                logger.info("[NeuraIntel] Bot paused by regime: %s",
                            directives.get("regime", "unknown"))
                return 0.0
            return float(bot_directive.get("size_multiplier", 1.0))
        except Exception as e:
            logger.warning("[NeuraIntel] get_directives failed, running normally: %s", e)
            return 1.0

    # ------------------------------------------------------------------
    # Scan voor nieuwe kansen — bidirectioneel
    # ------------------------------------------------------------------

    def scan_for_opportunities(self, funding_rates):
        """
        Scant alle coins op positieve funding rate.
        Positieve funding >= drempel -> SHORT perp + LONG spot.
        Negatieve funding wordt geskipt (HL heeft geen spot shorting).
        """
        ranked = sorted(
            funding_rates.items(),
            key=lambda x: x[1]["rate"],
            reverse=True,
        )

        hot_coins = []
        for asset, info in ranked:
            rate = info["rate"]
            oi = info["oi_usd"]

            if rate < FUNDING_ENTRY_THRESHOLD:
                continue

            if oi < MIN_OPEN_INTEREST_USD:
                logger.info(f"  Skip {asset}: {rate:+.2f}% ann. maar OI ${oi:,.0f} < ${MIN_OPEN_INTEREST_USD:,.0f}")
                continue

            # Jarvis: skip als funding dalend is (trend < -2% ann.)
            try:
                trend = _data_client.get_funding_trend(asset)
                if trend is not None and trend < -2.0:
                    logger.info(f"  Skip {asset}: {rate:+.2f}% ann. maar funding DALEND ({trend:+.1f}% ann. trend)")
                    continue
            except Exception:
                pass

            hot_coins.append((asset, rate, oi))

        if hot_coins:
            # NeuraIntel regime check
            multiplier = self._get_regime_multiplier("funding_bot")
            if multiplier == 0.0:
                return  # paused by regime

            logger.info(f"Hot coins gevonden: {len(hot_coins)}")
            import config as _cfg
            original_pct = _cfg.POSITION_SIZE_PCT
            _cfg.POSITION_SIZE_PCT = original_pct * multiplier
            try:
                for asset, rate, oi in hot_coins:
                    logger.info(
                        f"  Opportuniteit: {asset} | Funding: {rate:+.2f}% ann. | "
                        f"OI: ${oi:,.0f} -> SHORT perp + LONG spot"
                    )
                    self.open_position(asset, rate)
            finally:
                _cfg.POSITION_SIZE_PCT = original_pct

    # ------------------------------------------------------------------
    # Status afdrukken
    # ------------------------------------------------------------------

    def print_status(self, funding_rates):
        logger.info("-" * 55)
        logger.info(f"FUNDING RATES - {datetime.utcnow().strftime('%H:%M:%S')} UTC")
        logger.info(f"Scanning {len(funding_rates)} coins met spot pair")

        ranked = sorted(
            funding_rates.items(),
            key=lambda x: abs(x[1]["rate"]),
            reverse=True,
        )[:10]

        for asset, info in ranked:
            rate = info["rate"]
            oi = info["oi_usd"]
            flag = "HOT" if abs(rate) >= FUNDING_ENTRY_THRESHOLD else "   "
            oi_str = f"${oi/1e6:.1f}M" if oi >= 1e6 else f"${oi/1e3:.0f}K"

            if asset in self.open_positions:
                pos = self.open_positions[asset]
                perp_price = self.get_current_price(asset)
                spot_price = self.get_spot_price(asset)
                perp_pnl = (pos.perp_entry_price - perp_price) / pos.perp_entry_price * pos.size_usd
                spot_pnl = (spot_price - pos.spot_entry_price) / pos.spot_entry_price * pos.size_usd
                unrealized = perp_pnl + spot_pnl + pos.funding_collected
                logger.info(
                    f"  {flag} {asset:<8} {rate:+8.2f}% ann.  OI {oi_str:>8}  "
                    f"[OPEN {pos.direction}] "
                    f"PnL: ${unrealized:+.4f} "
                    f"(perp: ${perp_pnl:+.4f} | spot: ${spot_pnl:+.4f} | funding: ${pos.funding_collected:+.4f})"
                )
            else:
                logger.info(f"  {flag} {asset:<8} {rate:+8.2f}% ann.  OI {oi_str:>8}")

        s = self.risk.get_status_report()
        logger.info(f"Dag PnL (gerealiseerd): ${s['daily_pnl']:+.4f} | Funding: ${s['funding_earned_today']:.4f}")
        logger.info("-" * 55)

    # ------------------------------------------------------------------
    # Hoofdlus
    # ------------------------------------------------------------------

    def run(self):
        logger.info("Bot starten...")
        balance = self.get_account_balance()
        self.risk.set_initial_balance(balance)
        logger.info(f"Account balans: ${balance:.2f}")
        self.notifier.notify_startup(list(self.spot_pair_map.keys()), TESTNET)
        self.running      = True
        scan_count        = 0
        daily_report_hour = -1
        logger.info(f"Scanning elke {FUNDING_SCAN_INTERVAL} seconden...")
        while self.running:
            try:
                self.risk.check_daily_reset()
                funding_rates = self.get_funding_rates()
                if not funding_rates:
                    logger.warning("Geen funding rates, opnieuw proberen...")
                    time.sleep(30)
                    continue
                if self.open_positions:
                    self.check_open_positions(funding_rates)
                if not self.risk.kill_switch:
                    self.scan_for_opportunities(funding_rates)
                if scan_count % 5 == 0:
                    self.print_status(funding_rates)
                if scan_count % 10 == 0:
                    self.risk.update_balance(self.get_account_balance())
                if scan_count > 0 and scan_count % 360 == 0:
                    logger.info("Periodieke spot pair herscanning...")
                    self._discover_spot_pairs()
                current_hour = datetime.utcnow().hour
                if current_hour == 0 and daily_report_hour != 0:
                    s = self.risk.get_status_report()
                    self.notifier.notify_daily_summary(
                        s["daily_pnl"], s["funding_earned_today"],
                        s["daily_trades"], s["win_rate"]
                    )
                    daily_report_hour = 0
                elif current_hour != 0:
                    daily_report_hour = -1
                scan_count += 1
                time.sleep(FUNDING_SCAN_INTERVAL)
            except KeyboardInterrupt:
                self._graceful_shutdown("Handmatig gestopt")
                break
            except Exception as e:
                logger.error(f"Fout in hoofdlus: {e}", exc_info=True)
                time.sleep(30)

    def _graceful_shutdown(self, reason):
        logger.info(f"Graceful shutdown: {reason}")
        for asset in list(self.open_positions.keys()):
            self.close_position(asset, f"Bot shutdown: {reason}")
        self.running = False
        s = self.risk.get_status_report()
        logger.info(
            f"Sessie: PnL ${s['total_pnl']:+.4f} | "
            f"Funding ${s['total_funding_earned']:.4f} | "
            f"Trades {s['total_trades']}"
        )
        self.notifier.notify_shutdown(reason)

    def _load_trade_history(self):
        os.makedirs(os.path.dirname(DATA_FILE), exist_ok=True)
        if os.path.exists(DATA_FILE):
            try:
                with open(DATA_FILE) as f:
                    self.trade_history = json.load(f)
                logger.info(f"Trade history geladen: {len(self.trade_history)} trades")
                for trade in self.trade_history:
                    pnl     = trade.get("total_pnl", 0.0)
                    funding = trade.get("funding_collected", 0.0)
                    self.risk.record_trade_close(pnl, funding)
            except Exception:
                self.trade_history = []

    def _save_trade_history(self):
        try:
            with open(DATA_FILE, "w") as f:
                json.dump(self.trade_history, f, indent=2)
        except Exception as e:
            logger.error(f"Trade history opslaan mislukt: {e}")
