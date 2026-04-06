# NeuraLabs Command Center — Installatie Handleiding

## Trading Bot Platform — Complete Installatie Handleiding

Van een lege VPS naar een volledig draaiend AI-gestuurd trading command center. Deze handleiding leidt je stap voor stap door het hele proces.

---

## Inhoudsopgave

1. VPS Aanschaffen
2. Verbinden met je VPS (SSH)
3. VPS Voorbereiden
4. Claude Code Installeren
5. Trading Platform Installeren
6. Platform Configureren
7. Bots Configureren & Starten
8. Dagelijks Gebruik
9. Optionele Integraties
10. Troubleshooting
11. Veelgestelde Vragen

---

## Wat je nodig hebt

Voordat je begint, zorg dat je het volgende bij de hand hebt:

| Item | Waar te krijgen | Kosten |
|---|---|---|
| VPS server (Ubuntu 22.04+, 4GB RAM) | Hostinger / Hetzner / DigitalOcean | ~€10-20/maand |
| Anthropic API key | https://console.anthropic.com | Pay-per-use |
| Hyperliquid wallet(s) | https://app.hyperliquid.xyz | Gratis |
| Private key(s) van je wallet(s) | Je wallet (MetaMask / Rabby) | — |
| SSH client | Terminal (Mac/Linux) of PuTTY (Windows) | Gratis |
| GitHub account | https://github.com | Gratis |

**Optioneel:**

- Telegram bot token (voor notificaties)
- HeyGen API key (voor AI avatar video generatie)
- Stripe account (voor revenue tracking)
- Composio API key (voor Google Calendar integratie)
- Apify API token (voor social media scraping & performance tracking)
- Inference.sh account (voor AI image generatie — Nano Banana / Gemini)
- Canva account (voor design generatie via de Designer agent)

---

## 1. VPS Aanschaffen

### Wat is een VPS?

Een VPS (Virtual Private Server) is een server in de cloud die 24/7 draait. Je bots draaien hier continu, ook als je laptop uit staat.

### Aanbevolen specificaties

| Specificatie | Minimum | Aanbevolen |
|---|---|---|
| OS | Ubuntu 22.04 LTS | Ubuntu 24.04 LTS |
| RAM | 2 GB | 4 GB |
| CPU | 1 vCPU | 2 vCPU |
| Opslag | 20 GB SSD | 40 GB SSD |
| Locatie | Europa | Amsterdam / Frankfurt |

### Stap voor stap: VPS bestellen (voorbeeld: Hostinger)

1. Ga naar hostinger.com
2. Kies **KVM 2** of hoger (4 GB RAM)
3. Kies **Ubuntu 22.04** of **Ubuntu 24.04** als besturingssysteem
4. Kies een locatie dichtbij je (Amsterdam of Frankfurt)
5. Stel een **root wachtwoord** in — bewaar dit goed!
6. Rond de bestelling af

Na bestelling krijg je:
- Een **IP-adres** (bijv. `185.123.45.67`)
- Je **root wachtwoord** (dat je net hebt ingesteld)

---

## 2. Verbinden met je VPS (SSH)

### Op Mac / Linux

Open je Terminal en typ:

```
ssh root@JOUW_IP_ADRES
```

Vervang `JOUW_IP_ADRES` met het IP dat je van je VPS provider hebt gekregen.

Voorbeeld:
```
ssh root@185.123.45.67
```

- De eerste keer vraagt hij: *"Are you sure you want to continue connecting?"* — typ `yes`
- Voer je root wachtwoord in (je ziet geen tekens tijdens het typen, dat is normaal)

### Op Windows

1. Download en installeer **PuTTY**
2. Open PuTTY
3. Bij "Host Name" vul je je IP-adres in
4. Klik **Open**
5. Login als `root` met je wachtwoord

### Verbinding testen

Als je dit ziet ben je verbonden:
```
root@server:~#
```

Typ dit om te checken dat alles werkt:
```
uname -a
```

Je zou iets moeten zien als: `Linux server 6.x.x-xxx-generic ... Ubuntu ...`

---

## 3. VPS Voorbereiden

Nu je verbonden bent, gaan we de server updaten. Kopieer en plak deze commando's een voor een:

### 3.1 Systeem updaten

```
apt update && apt upgrade -y
```

Dit kan 2-5 minuten duren. Als er een paars/blauw scherm verschijnt met vragen, druk gewoon op **Enter**.

### 3.2 Essentials installeren

```
apt install -y git curl wget unzip build-essential
```

### 3.3 Node.js installeren

```
curl -fsSL https://deb.nodesource.com/setup_18.x | bash -
apt install -y nodejs
```

Controleer:
```
node --version
# Moet v18.x.x of hoger tonen
```

### 3.4 Python controleren

Ubuntu heeft Python standaard. Controleer:
```
python3 --version
# Moet 3.10+ tonen
```

Als Python ontbreekt:
```
apt install -y python3 python3-venv python3-pip
```

### 3.5 Redis installeren

Redis is de database voor realtime marktdata:
```
apt install -y redis-server
systemctl enable redis-server
systemctl start redis-server
```

Controleer:
```
redis-cli ping
# Moet "PONG" tonen
```

---

## 4. Claude Code Installeren

Claude Code is je AI assistent die direct op de server draait. Hiermee kun je je bots beheren, code aanpassen, en analyses uitvoeren via de terminal.

### 4.1 Claude Code installeren

```
npm install -g @anthropic-ai/claude-code
```

### 4.2 Anthropic API key instellen

Je hebt een API key nodig van Anthropic:

1. Ga naar https://console.anthropic.com
2. Maak een account aan (of log in)
3. Ga naar **API Keys** in de sidebar
4. Klik **Create Key**
5. Kopieer de key (begint met `sk-ant-...`)

Stel de key in op je server:
```
export ANTHROPIC_API_KEY="sk-ant-JOUW_KEY_HIER"
```

Maak het permanent (zodat het na herstart blijft werken):
```
echo 'export ANTHROPIC_API_KEY="sk-ant-JOUW_KEY_HIER"' >> ~/.bashrc
source ~/.bashrc
```

### 4.3 Claude Code starten

```
claude
```

Je ziet nu de Claude Code interface. Test het door te typen:

> Hallo, kun je me vertellen welke Node.js versie er draait?

Claude voert het commando uit en geeft je het antwoord.

### 4.4 Claude Code afsluiten

Typ `/exit` of druk op `Ctrl+C` om Claude Code af te sluiten.

> **Tip:** Je kunt Claude Code altijd opnieuw starten door `claude` te typen in de terminal.

---

## 5. Trading Platform Installeren

### 5.1 Platform downloaden

Je hebt toegang nodig tot de GitHub repository. Als je die hebt:

```
cd /root
git clone https://github.com/neuralabscloud/neuralabs-command-center.git
cd neuralabs-command-center
```

> Als je om credentials wordt gevraagd, gebruik je GitHub username en een **Personal Access Token** als wachtwoord. Maak een token aan via: https://github.com/settings/tokens/new (selecteer `repo` scope)

### 5.2 Installer starten

```
chmod +x install.sh
./install.sh
```

De installer stelt je een reeks vragen. Hieronder leggen we elke vraag uit.

---

## 6. Platform Configureren

De installer vraagt stap voor stap om je configuratie. Hier is wat elke vraag betekent:

### BRANDING

**> Company/platform name [MyTradingCo]:**

De naam van je trading platform. Dit verschijnt in de dashboard UI, Telegram berichten, en de AI assistent. Bijvoorbeeld: *AlphaTrading* of *CryptoVault*.

**> AI assistant name [Assistant]:**

De naam van je AI assistent in het Command Center. Bijvoorbeeld: *Nova*, *Atlas*, of *Jarvis*.

**> Tagline [Your Trading Platform]:**

Een korte slogan. Bijvoorbeeld: *Smart Trading, Zero Emotion*.

**> Primary color hue (0-360) [264]:**

De hoofdkleur van je dashboard. Voorbeelden:
- 264 = Paars
- 210 = Blauw
- 142 = Groen
- 0 = Rood
- 30 = Oranje

### AUTHENTICATION

**> Dashboard login password:**

Het wachtwoord waarmee je inlogt op het web dashboard. Kies een sterk wachtwoord! Dit wordt niet getoond terwijl je typt.

### AI API KEY

**> Anthropic Claude API key:**

Je Anthropic API key (dezelfde als in stap 4.2). Begint met `sk-ant-...`.

### FUNDING BOT

**> Funding bot private key:**

De private key van de Hyperliquid wallet die je wilt gebruiken voor de Funding Rate bot.

**Hoe vind je je private key:**
1. Open MetaMask of Rabby wallet
2. Klik op de 3 puntjes naast je account
3. Klik "Account details" → "Show private key"
4. Voer je wachtwoord in
5. Kopieer de key (begint met `0x...`)

> **LET OP:** Gebruik een APARTE wallet voor je bots, niet je hoofdwallet! Stuur alleen het bedrag dat je wilt traden naar deze wallet.

**> Funding bot wallet address:**

Het adres van dezelfde wallet (begint met `0x...`). Dit is het publieke adres, niet de private key.

### TREND BOT

Zelfde vragen als de Funding Bot, maar dan voor een tweede wallet voor de Trend bot.

> **Tip:** Je kunt dezelfde wallet gebruiken voor beide bots, of aparte wallets. Aparte wallets is aan te raden voor overzicht.

### OPTIONELE INTEGRATIES

Al deze vragen kun je overslaan door op **Enter** te drukken:

**> Telegram bot token:**
Voor push notificaties via Telegram. Zie sectie 9.1 voor setup instructies.

**> HeyGen API key:**
Voor AI avatar video generatie. Alleen nodig als je de video features wilt gebruiken.

**> Stripe secret key:**
Voor revenue tracking in het dashboard. Alleen nodig als je een Stripe account hebt.

**> Composio API key:**
Voor Google Calendar integratie. Zie sectie 9.4 voor setup instructies.

**> Apify API token:**
Voor social media scraping en performance tracking (Instagram, TikTok, X volgers en engagement). Zie sectie 9.5 voor setup instructies.

### INSTALLATION DIRECTORY

**> Install directory [/opt/commandcenter]:**

Waar het platform geinstalleerd wordt. De standaard (`/opt/commandcenter`) is prima voor de meeste gebruikers. Druk op **Enter**.

### Installatie afwachten

De installer doet nu automatisch:
1. Dependencies installeren (Node.js packages, Python packages)
2. Virtual environments aanmaken voor de bots
3. Systemd services configureren
4. Cron jobs instellen
5. Alles starten

Dit duurt 3-10 minuten. Je ziet de voortgang in de terminal.

### Installatie klaar!

Als alles goed gaat zie je:

```
╔══════════════════════════════════════════╗
║   Installation Complete!                  ║
╚══════════════════════════════════════════╝

Command Center:    http://185.123.45.67:3004
Trading Dashboard: http://185.123.45.67:3000
Login password:    (the one you set)
```

Open de Command Center URL in je browser en log in met je wachtwoord!

> **Post-install tip:** Na de installatie kun je extra integraties instellen via **Settings > Integrations** in het Command Center, of handmatig in de `.env` file. Zie hoofdstuk 9 voor alle details.

---

## 7. Bots Configureren & Starten

### 7.1 Command Center openen

Open je browser en ga naar:
```
http://JOUW_IP:3004
```

Log in met het wachtwoord dat je tijdens de installatie hebt ingesteld.

### 7.2 Dashboard verkennen

Na het inloggen zie je het Command Center met:

- **Overview** — Overzicht van alle systemen
- **Research** — Dagelijkse crypto research rapporten
- **Performance** — Bot en social media performance
- **Agents** — AI agents (Designer, Video Editor, Content Creator, Analyst, etc.)
- **Chat** — Chat met je AI assistent
- **Analyst** — Trading bot analyse
- **Trading Dashboard** — Live bot data, orderbook, terminal

### 7.3 Bots starten via de Trading Dashboard

1. Open `http://JOUW_IP:3000`
2. Je ziet de status van je bots (Funding Bot, Trend Bot)
3. Gebruik de terminal tab om bots te starten:

```
cd /opt/commandcenter/funding-bot
source venv/bin/activate
python run.py --check
```

Als de check slaagt, start de bot:
```
python run.py
```

Hetzelfde voor de Trend Bot:
```
cd /opt/commandcenter/trend-bot
source venv/bin/activate
python run.py --check
python run.py
```

### 7.4 Bot parameters aanpassen

De bot parameters kun je aanpassen in de config bestanden:

**Funding Bot** — `/opt/commandcenter/funding-bot/config.py`:
- `FUNDING_ENTRY_THRESHOLD` — Minimale funding rate om in te stappen (standaard: 8%)
- `POSITION_SIZE_PCT` — Positiegrootte als % van balance (standaard: 25%)
- `MAX_OPEN_POSITIONS` — Max aantal posities tegelijk (standaard: 3)

**Trend Bot** — `/opt/commandcenter/trend-bot/config.py`:
- `ASSETS` — Welke coins te traden (standaard: BTC, ETH, SOL, etc.)
- `LEVERAGE` — Hefboom (standaard: 5x)
- `POSITION_SIZE_PCT` — Positiegrootte (standaard: 15%)
- `TAKE_PROFIT_PCT` — Take profit percentage (standaard: 1.2%)
- `STOP_LOSS_PCT` — Stop loss percentage (standaard: 0.65%)

> **Tip:** Gebruik Claude Code om parameters aan te passen! Start `claude` in de terminal en vraag: *"Pas de take profit van de trend bot aan naar 1.5%"*

### 7.5 Bots als achtergrondproces draaien

Om bots permanent te laten draaien (ook na sluiten van je terminal), gebruik **screen**:

```
apt install -y screen

# Funding Bot starten
screen -S funding-bot
cd /opt/commandcenter/funding-bot
source venv/bin/activate
python run.py
# Druk Ctrl+A, dan D om te detachen

# Trend Bot starten
screen -S trend-bot
cd /opt/commandcenter/trend-bot
source venv/bin/activate
python run.py
# Druk Ctrl+A, dan D om te detachen
```

Terug naar een screen sessie:
```
screen -r funding-bot
# of: screen -r trend-bot
```

---

## 8. Dagelijks Gebruik

### 8.1 Automatische dagelijkse rapporten

Het platform draait elke dag automatisch om 08:00 (CET):

1. **Bot diagnostiek** — Checkt of alle bots draaien, scant op fouten
2. **Performance analyse** — Berekent PnL, winrate, en key metrics
3. **Research rapport** — AI-gegenereerde crypto markt analyse

Deze rapporten worden:
- Naar Telegram gestuurd (als geconfigureerd)
- Opgeslagen in het Command Center (Research pagina)

### 8.2 AI Assistent gebruiken

Open de **Chat** pagina in het Command Center. Je kunt je assistent vragen:

- *"Hoe presteren mijn bots vandaag?"*
- *"Maak een Instagram carousel over Bitcoin"*
- *"Analyseer de funding rates"*
- *"Schrijf een script voor een TikTok video"*
- *"Welke coins hebben de hoogste funding rate?"*

### 8.3 Agents gebruiken

Via de **Agents** pagina kun je taken aanmaken voor:

| Agent | Wat doet het |
|---|---|
| **Designer** | Maakt social media designs via Canva of AI image generatie (Nano Banana) |
| **Video Editor** | Bewerkt en rendert video's met scenes, tekst, transitions en muziek (Remotion) |
| **Content Creator** | Genereert AI avatar video's (HeyGen) |
| **Script Writer** | Schrijft video scripts en content |
| **Researcher** | Dagelijkse crypto trend research |
| **Analyst** | Trading bot analyse en rapportage |
| **Marketeer** | Marketing strategie en copywriting |
| **Calendar** | Google Calendar beheer (Composio) |

#### Designer Agent — Design Engines

De Designer agent ondersteunt meerdere engines:

| Engine | Beschrijving | Vereist |
|---|---|---|
| **Nano Banana** (standaard) | AI image generatie via Gemini — genereert foto-realistische designs | Inference.sh CLI (zie 9.7) |
| **Playwright** | HTML-naar-afbeelding rendering — snelle, template-gebaseerde designs | Geen extra setup |
| **Claude / Canva** | Designs aanmaken in je Canva account via MCP | Canva OAuth (zie 9.6) |

#### Video Editor Agent

De Video Editor is een volledige video bewerkingsomgeving gebouwd met **Remotion** (React-based video rendering). Hiermee kun je:

- **Scenes samenstellen** — Voeg meerdere scenes toe met tekst, afbeeldingen en achtergronden
- **Transitions toevoegen** — Fade, slide, zoom en andere overgangen tussen scenes
- **Tekst animeren** — Titels, ondertitels en overlays met animatie-effecten
- **Muziek/audio toevoegen** — Achtergrondmuziek en voice-overs
- **Exporteren** — Render de video als MP4

Je vindt de Video Editor via de sidebar in het Command Center, of via de Agents pagina. De Video Editor werkt direct zonder extra API keys — het draait volledig op de server.

### 8.4 Claude Code op de server

SSH naar je server en typ `claude` om Claude Code te starten. Hiermee kun je:

- Bot code aanpassen
- Configuratie wijzigen
- Logs bekijken en debuggen
- Nieuwe features toevoegen
- Alles wat je maar wilt

Voorbeeld:
```
> claude
Je: "Toon me de laatste 20 trades van de funding bot"
Je: "Waarom is de trend bot gestopt?"
Je: "Voeg DOGE toe aan de trend bot assets"
```

---

## 9. Optionele Integraties

### 9.1 Telegram Notificaties

Telegram stuurt je automatisch berichten over bot performance, trades, en fouten.

**Setup:**

1. Open Telegram en zoek **@BotFather**
2. Typ `/newbot`
3. Geef je bot een naam (bijv. "MyCrypto Bot")
4. Geef je bot een username (bijv. `mycrypto_trading_bot`)
5. Je krijgt een **Bot Token** — kopieer dit (ziet eruit als `1234567890:ABCdefGHIjklMNOpqrsTUVwxyz`)

**Chat ID vinden:**

1. Start een chat met je nieuwe bot in Telegram
2. Stuur een bericht (bijv. "hallo")
3. Open deze URL in je browser (vervang TOKEN):
   `https://api.telegram.org/botJOUW_TOKEN/getUpdates`
4. Zoek `"chat":{"id":XXXXXXXX}` — dat getal is je Chat ID

**In je platform instellen:**

```
nano /opt/commandcenter/.env
```

Vul in:
```
TELEGRAM_BOT_TOKEN=1234567890:ABCdefGHIjklMNOpqrsTUVwxyz
TELEGRAM_CHAT_ID=123456789
```

Herstart de services:
```
systemctl restart command-center
```

### 9.2 HeyGen (AI Avatar Video)

HeyGen genereert professionele AI avatar video's. De **Content Creator** agent gebruikt HeyGen om video's te maken met een realistische AI-presentator.

**Setup:**

1. Ga naar https://www.heygen.com
2. Maak een account aan
3. Ga naar **Settings → API → Generate API Key**
4. Voeg toe aan je `.env`:

```
HEYGEN_API_KEY=jouw_key_hier
```

5. Herstart: `systemctl restart command-center`

### 9.3 Stripe (Revenue Tracking)

Stripe koppelt je betalingsdata aan het Performance dashboard. Je ziet omzet, abonnementen en trends.

**Setup:**

1. Ga naar https://dashboard.stripe.com/apikeys
2. Kopieer je **Secret key** (begint met `sk_live_` of `sk_test_`)
3. Voeg toe aan je `.env`:

```
STRIPE_SECRET_KEY=sk_live_jouw_key_hier
```

4. Herstart: `systemctl restart command-center`

### 9.4 Composio (Google Calendar)

Composio koppelt Google Calendar aan het Command Center. De **Calendar** agent kan afspraken bekijken, aanmaken en beheren via je AI assistent.

**Setup:**

1. Ga naar https://app.composio.dev en maak een account aan
2. Ga naar **Settings → API Keys**
3. Klik **Generate API Key** en kopieer de key
4. Voeg toe aan je `.env`:

```
COMPOSIO_API_KEY=jouw_key_hier
```

5. Herstart: `systemctl restart command-center`
6. Open het Command Center en ga naar de **Calendar** pagina
7. Klik op **Connect Google Calendar** — je wordt doorgestuurd naar Google om toestemming te geven

> **Let op:** Composio fungeert als brug tussen het Command Center en Google. Je geeft Composio toestemming om namens jou Google Calendar te lezen en schrijven.

### 9.5 Apify (Social Media Scraping)

Apify scrapt social media platformen voor performance data. Het **Performance** dashboard gebruikt Apify om automatisch je volgers, likes, comments en engagement te tracken van Instagram, TikTok en X (Twitter).

**Setup:**

1. Ga naar https://apify.com en maak een account aan (gratis plan beschikbaar)
2. Ga naar https://console.apify.com/account/integrations
3. Kopieer je **Personal API Token**
4. Voeg toe aan je `.env`:

```
APIFY_API_KEY=apify_api_jouw_token_hier
```

5. Herstart: `systemctl restart command-center`

**Wat het doet:**

- Scrapt automatisch Instagram profielen voor volgers, posts en engagement rate
- Scrapt TikTok accounts voor views, likes en volgers
- Scrapt X/Twitter profielen voor followers en impressies
- Data wordt getoond in het **Performance** dashboard naast je bot performance

> **Kosten:** Apify heeft een gratis plan met beperkte credits. Voor dagelijks scrapen is het betaalde plan (~$49/maand) aan te raden. Elke scrape-run kost een paar cent.

### 9.6 Canva (Designer Agent)

Canva wordt gebruikt door de **Designer** agent om professionele designs te maken in je eigen Canva account. Dit werkt via OAuth — je geeft het Command Center toestemming om designs aan te maken in jouw Canva workspace.

**Setup:**

1. Ga naar https://www.canva.com en maak een account aan (gratis of Pro)
2. Open het Command Center en ga naar **Settings > Integrations**
3. Zoek de **Canva** integratie en klik op **Connect**
4. Er opent een popup/nieuw venster van Canva — klik op **Allow** om toestemming te geven
5. Na toestemming zie je de status veranderen naar **Connected**

> **Geen API key nodig in `.env`** — Canva gebruikt OAuth met automatische token-vernieuwing. De verbinding wordt opgeslagen in het Command Center.

**Gebruik:**

- Ga naar de **Designer** pagina of de **Agents** pagina
- Kies engine **"Claude / Canva"** bij het aanmaken van een design
- De AI maakt het design direct aan in je Canva account
- Je krijgt een link naar het design in Canva, waar je het verder kunt bewerken

**Canva Pro voordelen:**

- Meer templates en design elementen
- Brand Kit met je eigen kleuren, fonts en logo's
- Achtergrond-verwijder tool
- Meer opslagruimte

### 9.7 Inference.sh — Nano Banana (AI Image Generatie)

Inference.sh (ook bekend als **Nano Banana**) is een CLI tool die AI image generatie mogelijk maakt via Google Gemini. De **Designer** agent gebruikt dit als standaard engine om foto-realistische social media designs te genereren. Het wordt ook gebruikt voor **AI video generatie** met beeldmateriaal.

**Setup:**

1. Installeer de CLI tool:

```
npm install -g inference.sh
```

2. Log in met je account:

```
infsh login
```

Dit opent een browser venster (of geeft een URL) waar je inlogt met je account. De credentials worden lokaal opgeslagen in `~/.inferencesh/config.json`.

3. Test of het werkt:

```
infsh app sample google/gemini-3-1-flash-image-preview
```

Je zou een test-afbeelding moeten zien genereren.

> **Geen `.env` wijziging nodig** — de CLI slaat credentials op in zijn eigen config bestand. Het Command Center detecteert automatisch of inference.sh is geinstalleerd en geconfigureerd.

**Gebruik:**

- De Designer agent gebruikt Nano Banana als **standaard engine**
- Wanneer je een design aanmaakt (bijv. Instagram carousel, thumbnail, banner), genereert Gemini de afbeelding op basis van je prompt
- Resultaten worden opgeslagen in `/opt/commandcenter/command-center/public/generated-images/`
- Je kunt de engine ook instellen op een andere optie (Playwright of Canva) als je dat prefereert

**Verificatie:**

Na installatie kun je in het Command Center controleren of alles werkt:

1. Ga naar **Settings > Integrations**
2. Zoek **Inference.sh (Nano Banana)**
3. Status moet **Connected** tonen
4. Klik op **Test** om een test-afbeelding te genereren

---

## 10. Troubleshooting

### Services checken

```
# Status van alle services
systemctl status command-center
systemctl status trading-dashboard
systemctl status data-hub

# Logs bekijken (live)
journalctl -u command-center -f
journalctl -u trading-dashboard -f
journalctl -u data-hub -f
```

### Service herstarten

```
systemctl restart command-center
systemctl restart trading-dashboard
systemctl restart data-hub
```

### Veelvoorkomende problemen

**"Kan niet verbinden met Command Center"**
- Check of de service draait: `systemctl status command-center`
- Check de firewall: `ufw allow 3004` en `ufw allow 3000`
- Check logs: `journalctl -u command-center -n 50`

**"Bot start niet"**
- Check de config: `cat /opt/commandcenter/funding-bot/config.py`
- Check of private key klopt: `cd /opt/commandcenter/funding-bot && source venv/bin/activate && python run.py --check`
- Check logs in de `logs/` map

**"Geen Telegram berichten"**
- Check of token en chat ID kloppen in `.env`
- Test handmatig:
```
curl -s "https://api.telegram.org/botJOUW_TOKEN/sendMessage" \
  -d "chat_id=JOUW_CHAT_ID&text=Test"
```

**"Redis error"**
```
systemctl restart redis-server
systemctl status redis-server
```

**"npm install faalt"**
```
cd /opt/commandcenter/command-center
rm -rf node_modules package-lock.json
npm install
systemctl restart command-center
```

**"Canva verbinding werkt niet"**
- Ga naar **Settings > Integrations** en klik opnieuw op **Connect** bij Canva
- De OAuth token verloopt af en toe — opnieuw verbinden vernieuwt de token
- Check logs: `journalctl -u command-center -n 50 | grep -i canva`

**"Nano Banana / Inference.sh geeft errors"**
- Check of de CLI geinstalleerd is: `which infsh`
- Check of je ingelogd bent: `cat ~/.inferencesh/config.json`
- Opnieuw inloggen: `infsh login`
- Test handmatig: `infsh app sample google/gemini-3-1-flash-image-preview`

**"Apify scraping werkt niet"**
- Check of de API key klopt in `.env`
- Test handmatig: `curl -s "https://api.apify.com/v2/acts?token=JOUW_TOKEN&limit=1"`
- Check je Apify credits op https://console.apify.com/billing

### Configuratie wijzigen na installatie

```
# Open het configuratiebestand
nano /opt/commandcenter/.env

# Na wijzigingen: regenereer configs en herstart
bash /opt/commandcenter/config/generate-configs.sh
systemctl restart command-center trading-dashboard data-hub
```

### Platform updaten

```
cd /root/neuralabs-command-center
git pull
cp -r command-center/ /opt/commandcenter/
cp -r funding-bot/ /opt/commandcenter/
cp -r trend-bot/ /opt/commandcenter/
cp -r trading-dashboard/ /opt/commandcenter/
cp -r data-hub/ /opt/commandcenter/
cp -r scripts/ /opt/commandcenter/
bash /opt/commandcenter/config/generate-configs.sh
systemctl restart command-center trading-dashboard data-hub
```

---

## 11. Veelgestelde Vragen

**Hoeveel kost het om de bots te draaien?**
- VPS: €10-20/maand
- Anthropic API: ~€5-20/maand (afhankelijk van gebruik)
- Hyperliquid: geen trading fees (alleen funding)
- Totaal: ~€15-40/maand

**Is mijn geld veilig?**
- De bots handelen alleen op Hyperliquid via je eigen wallet
- Niemand anders heeft toegang tot je private keys
- Je keys staan alleen op jouw server in een beveiligd `.env` bestand
- **Gebruik ALTIJD een aparte wallet met alleen je trading kapitaal**

**Kan ik de bots uitzetten?**

Ja, op elk moment:
```
# Via screen
screen -r funding-bot
# Dan Ctrl+C

# Of als het een process is
pkill -f "python run.py"
```

**Hoeveel kapitaal heb ik nodig?**
- Funding Bot: minimaal $500 aanbevolen (delta-neutraal, laag risico)
- Trend Bot: minimaal $1000 aanbevolen (gebruikt leverage)
- Je kunt met minder beginnen, maar de winsten zijn dan ook kleiner

**Kan ik meerdere bots op dezelfde wallet draaien?**

Ja, maar aparte wallets is aanbevolen. Zo houd je overzicht over de performance per strategie.

**Wat als mijn VPS uitvalt?**
- De bots stoppen automatisch bij een crash
- Na herstart van de VPS komen de services automatisch terug (systemd)
- Open posities op Hyperliquid blijven bestaan — check ze handmatig

**Hoe update ik het platform?**

Zie sectie 10: "Platform updaten". Het is een kwestie van `git pull` en services herstarten.

**Welke integraties heb ik echt nodig?**
- **Essentieel:** Anthropic API key (voor AI), Hyperliquid wallet(s) (voor trading)
- **Sterk aanbevolen:** Telegram (voor notificaties), Inference.sh (voor Designer)
- **Optioneel:** Canva (alternatieve design engine), Apify (social media tracking), HeyGen (avatar video's), Stripe (revenue), Composio (calendar)

---

## Snelle Referentie

| Actie | Commando |
|---|---|
| SSH naar server | `ssh root@JOUW_IP` |
| Claude Code starten | `claude` |
| Command Center openen | `http://JOUW_IP:3004` |
| Trading Dashboard | `http://JOUW_IP:3000` |
| Bot status checken | `systemctl status command-center` |
| Logs bekijken | `journalctl -u command-center -f` |
| Services herstarten | `systemctl restart command-center trading-dashboard data-hub` |
| Config aanpassen | `nano /opt/commandcenter/.env` |
| Configs regenereren | `bash /opt/commandcenter/config/generate-configs.sh` |
| Inference.sh testen | `infsh app sample google/gemini-3-1-flash-image-preview` |
| Canva verbinden | Settings > Integrations > Canva > Connect |

---

**Heb je hulp nodig?** Open Claude Code op je server (`claude`) en stel je vraag. Je AI assistent helpt je met alles.
