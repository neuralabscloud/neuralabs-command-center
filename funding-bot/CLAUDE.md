# NeuraLabs Bot 1 — Funding Rate Bot

Dit is **neuralabs-bot (Bot 1)**: de funding rate arbitrage bot voor Hyperliquid perpetuals.

## Werkomgeving
- **Directory:** `/root/neuralabs-bot/`
- **Venv:** `/root/neuralabs-bot/venv/` (gedeeld met bot 2 en 3)
- **Activeren:** `source /root/neuralabs-bot/venv/bin/activate`

## Starten
```bash
cd /root/neuralabs-bot
source venv/bin/activate
python run.py          # bot draaien
python run.py --check  # verbinding testen
```

## Kernbestanden
- `config.py` — configuratie (API keys, parameters)
- `funding_bot.py` — hoofdlogica
- `risk_manager.py` — risicobeheer
- `notifier.py` — Telegram notificaties
- `logs/` — logbestanden

## Opmerkingen
- Alle logberichten zijn in het Nederlands
- Geen unicode/emoji in code (terminalcompatibiliteit)
- `TESTNET = True` in config.py voor testnet
