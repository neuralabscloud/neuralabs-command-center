# NeuraLabs Command Center — Complete Installatie Handleiding

> Van een lege VPS naar een volledig draaiend AI-gestuurd Command Center.
> Deze handleiding leidt je stap voor stap door het hele proces.

---

## Inhoudsopgave

1. [VPS Aanschaffen](#1-vps-aanschaffen)
2. [Verbinden met je VPS (SSH)](#2-verbinden-met-je-vps-ssh)
3. [VPS Voorbereiden](#3-vps-voorbereiden)
4. [Command Center Installeren](#4-command-center-installeren)
5. [Setup Wizard — Configuratie via Dashboard](#5-setup-wizard--configuratie-via-dashboard)
6. [Command Center Overzicht](#6-command-center-overzicht)
7. [Dagelijks Gebruik](#7-dagelijks-gebruik)
8. [Instellingen Aanpassen](#8-instellingen-aanpassen)
9. [Trading Bots Addon](#9-trading-bots-addon)
10. [Eigen Domein Koppelen](#10-eigen-domein-koppelen)
11. [Updaten](#11-updaten)
12. [Troubleshooting](#12-troubleshooting)
13. [Veelgestelde Vragen](#13-veelgestelde-vragen)

---

## Wat je nodig hebt

| Item | Waar te krijgen | Kosten |
|------|----------------|--------|
| VPS server (Ubuntu 22.04+, 2GB RAM) | Hostinger / Hetzner / DigitalOcean | ~€10-20/maand |
| SSH client | Terminal (Mac/Linux) of PuTTY (Windows) | Gratis |
| GitHub account | https://github.com | Gratis |

**Optioneel (configureer je later via de setup wizard):**
- Anthropic API key (voor AI functies) — https://console.anthropic.com
- Telegram bot token (voor notificaties)
- HeyGen API key (voor AI avatar video's)
- Stripe account (voor revenue tracking)
- Composio API key (voor Google Calendar integratie)
- Apify API token (voor social media scraping & performance tracking)
- Canva account (voor design generatie via de Designer agent)

---

## 1. VPS Aanschaffen

### Wat is een VPS?

Een VPS (Virtual Private Server) is een server in de cloud die 24/7 draait. Je Command Center draait hier continu, ook als je laptop uit staat.

### Aanbevolen specificaties

| Specificatie | Minimum | Aanbevolen |
|-------------|---------|------------|
| OS | Ubuntu 22.04 LTS | Ubuntu 24.04 LTS |
| RAM | 2 GB | 4 GB |
| CPU | 1 vCPU | 2 vCPU |
| Opslag | 20 GB SSD | 40 GB SSD |
| Locatie | Europa | Amsterdam / Frankfurt |

### Stap voor stap: VPS bestellen (voorbeeld: Hostinger)

1. Ga naar [hostinger.com](https://www.hostinger.com/vps-hosting)
2. Kies **KVM 2** of hoger (4 GB RAM aanbevolen)
3. Kies **Ubuntu 22.04** of **Ubuntu 24.04** als besturingssysteem
4. Kies een locatie dichtbij je (Amsterdam of Frankfurt)
5. Stel een **root wachtwoord** in — **bewaar dit goed!**
6. Rond de bestelling af

Na bestelling krijg je:
- Een **IP-adres** (bijv. `185.123.45.67`)
- Je **root wachtwoord** (dat je net hebt ingesteld)

---

## 2. Verbinden met je VPS (SSH)

### Op Mac / Linux

Open je **Terminal** en typ:

```bash
ssh root@JOUW_IP_ADRES
```

Vervang `JOUW_IP_ADRES` met het IP dat je van je VPS provider hebt gekregen.

Voorbeeld:
```bash
ssh root@185.123.45.67
```

- De eerste keer vraagt hij: *"Are you sure you want to continue connecting?"* — typ `yes`
- Voer je root wachtwoord in (je ziet geen tekens tijdens het typen, dat is normaal)

### Op Windows

1. Download en installeer [PuTTY](https://www.putty.org/)
2. Open PuTTY
3. Bij "Host Name" vul je je IP-adres in
4. Klik **Open**
5. Login als `root` met je wachtwoord

### Verbinding testen

Als je dit ziet ben je verbonden:
```
root@server:~#
```

---

## 3. VPS Voorbereiden

Kopieer en plak deze commando's een voor een:

### 3.1 Systeem updaten

```bash
apt update && apt upgrade -y
```

Dit kan 2-5 minuten duren. Als er een paars/blauw scherm verschijnt met vragen, druk gewoon op **Enter**.

### 3.2 Essentials installeren

```bash
apt install -y git curl wget unzip build-essential
```

---

## 4. Command Center Installeren

### 4.1 Repository downloaden

```bash
cd /root
git clone https://github.com/neuralabscloud/neuralabs-command-center.git
cd neuralabs-command-center
```

Als je om een wachtwoord wordt gevraagd, gebruik je GitHub username en een **Personal Access Token** als wachtwoord. Maak een token aan via: https://github.com/settings/tokens/new (selecteer de `repo` scope).

### 4.2 Installer starten

```bash
chmod +x install.sh
sudo ./install.sh
```

De installer stelt twee vragen:

```
> Dashboard login password:
```
Kies een sterk wachtwoord — hiermee log je later in op het Command Center.

```
> Install directory [/opt/commandcenter]:
```
Druk op **Enter** voor de standaard locatie.

De installer doet nu automatisch:
1. Node.js, Python, Redis installeren
2. Claude Code installeren
3. Node.js packages installeren
4. Systemd service configureren en starten

Dit duurt **2-5 minuten**.

### 4.3 Installatie klaar!

Als alles goed gaat zie je:

```
╔══════════════════════════════════════════╗
║   Installation Complete!                  ║
╚══════════════════════════════════════════╝

  ▸ VOLGENDE STAP:
  Open http://185.123.45.67:3004 in je browser
```

### Firewall openzetten

Als het dashboard niet laadt, moet je de poort openzetten:
```bash
ufw allow 3004
```

---

## 5. Setup Wizard — Configuratie via Dashboard

Open je browser en ga naar:

```
http://JOUW_IP:3004
```

Log in met het wachtwoord dat je tijdens de installatie hebt gekozen.

De **Setup Wizard** verschijnt automatisch en begeleidt je in 4 stappen:

### Stap 1: Branding

- **Company Name** — Je bedrijfsnaam (wordt getoond in de UI en Telegram berichten)
- **AI Assistant Name** — Naam van je AI assistant (bijv. "Jarvis", "Atlas")
- **Tagline** — Korte omschrijving van je platform
- **Primary Color** — Sleep de slider om je merkkleur te kiezen

### Stap 2: AI (Anthropic API) — optioneel

- **Anthropic API Key** — Vereist voor alle AI functies (research, design, analyse)

Als je dit nog niet hebt, klik op **Skip**. Je kunt het later instellen via Settings.

**API key aanmaken:**
1. Ga naar https://console.anthropic.com
2. Maak een account aan (of log in)
3. Ga naar **API Keys** in de sidebar
4. Klik **Create Key**
5. Kopieer de key (begint met `sk-ant-...`)

### Stap 3: Telegram Notifications — optioneel

Om notificaties te ontvangen bij voltooide taken, rapporten en alerts heb je een Telegram bot nodig.

**Bot aanmaken:**
1. Open Telegram en zoek **@BotFather**
2. Typ `/newbot`
3. Geef je bot een naam (bijv. "Mijn Platform Bot")
4. Geef je bot een username (bijv. `mijn_platform_bot`)
5. Je krijgt een **Bot Token** — kopieer dit (ziet er zo uit: `1234567890:ABCdefGHIjklMNOpqrsTUVwxyz`)

**Chat ID vinden:**
1. Open een chat met je nieuwe bot in Telegram
2. Stuur een bericht (bijv. "hallo")
3. Open deze URL in je browser (vervang JOUW_TOKEN):
```
https://api.telegram.org/botJOUW_TOKEN/getUpdates
```
4. Zoek in de tekst naar `"chat":{"id":` — het getal erachter is je **Chat ID**

Vul beide velden in de wizard in:
- **Bot Token** — Het token van @BotFather
- **Chat ID** — Het getal dat je net hebt gevonden

Na het instellen kun je via Telegram direct met je AI assistant chatten. Stuur een bericht naar je bot en je krijgt antwoord van Claude — dezelfde AI die ook in het Command Center draait.

**Telegram commando's:**
| Commando | Wat het doet |
|----------|-------------|
| `/start` | Begroeting en uitleg wat de bot kan |
| `/status` | Bot status en account equity (als trading bots geinstalleerd) |
| `/clear` | Chat history wissen |
| *Elk ander bericht* | AI assistant antwoordt via Claude |

Klik op **Skip** als je dit later wilt instellen. Je kunt het altijd toevoegen via Settings.

### Stap 4: Integrations — optioneel

- **HeyGen API Key** — Voor AI avatar video generatie. Key ophalen via [app.heygen.com/settings](https://app.heygen.com/settings)
- **Stripe Secret Key** — Voor revenue & subscription tracking. Key vind je in je [Stripe Dashboard](https://dashboard.stripe.com/apikeys) (begint met `sk_live_` of `sk_test_`)
- **Inference.sh API Key** — Voor AI image generatie (Nano Banana / Google Gemini). Gebruikt door de Designer agent. Key ophalen via [inference.sh](https://inference.sh) (begint met `1nfsh-`)
- **Composio API Key** — Voor Google Calendar integratie. Aanmaken via [app.composio.dev](https://app.composio.dev)
- **Apify API Token** — Voor social media scraping (TikTok, Instagram, X). Token ophalen via [console.apify.com](https://console.apify.com/account/integrations)

Alle velden zijn optioneel. Klik op **Finish** of **Skip** om door te gaan.

### Na de wizard: Canva koppelen (optioneel)

Canva wordt gebruikt door de Designer agent voor design generatie. Canva gebruikt OAuth (geen API key):

1. Ga naar **Settings** in het Command Center
2. Zoek **Canva** in de integratielijst
3. Klik **Connect** en log in met je Canva account
4. Autoriseer de koppeling

Na het koppelen kan de Designer agent rechtstreeks designs maken en bewerken in Canva.

> **Dat is alles!** Je Command Center is nu klaar voor gebruik.

---

## 6. Command Center Overzicht

Na de setup wizard kom je op het Command Center dashboard. In de sidebar vind je alle pagina's:

### Pagina's

| Pagina | Wat je er vindt |
|--------|----------------|
| **Overview** | Dashboard met overzicht van alle agents, recente taken en quick actions |
| **Research** | Marktonderzoek, trend analyse, concurrentie analyse, dagelijkse rapporten |
| **Performance** | KPI's, revenue (Stripe), social media analytics (Apify), groei metrics |
| **Agents** | Overzicht en beheer van alle AI agents en hun taken |
| **Video Editor** | Video's bewerken, knippen, samenvoegen en exporteren via Remotion |
| **Designer** | Social media content maken: carousels, thumbnails, banners, infographics. Gebruikt Claude AI, Canva, en Nano Banana (Inference.sh) |
| **Content Creator** | AI avatar video's genereren via HeyGen |
| **Script Writer** | Scripts schrijven voor video's, social media posts en content |
| **Marketeer** | Marketing strategie, campagne planning en content kalender |
| **Calendar** | Google Calendar beheer via Composio integratie |
| **Settings** | Branding, API keys, integraties en systeem configuratie |

### AI Agents

Elke agent is een gespecialiseerde AI die zelfstandig taken uitvoert:

| Agent | Wat het doet | Vereist |
|-------|-------------|---------|
| **Designer** | Maakt social media content: carousels, thumbnails, banners | Anthropic API key |
| **Researcher** | Marktonderzoek, trend analyse, concurrentie analyse | Anthropic API key |
| **Video Editor** | Video's maken en bewerken via Remotion (React-based video framework) | — (ingebouwd) |
| **Content Creator** | AI avatar video's maken | HeyGen API key |
| **Script Writer** | Scripts voor video's en content | Anthropic API key |
| **Marketeer** | Marketing strategie en campagne planning | Anthropic API key |
| **Calendar** | Google Calendar beheer | Composio API key |

---

## 7. Dagelijks Gebruik

### Werken met Agents

Elke agent voert taken voor je uit. Je maakt een taak aan, de agent verwerkt het, en je krijgt het resultaat terug — in het dashboard en optioneel via Telegram.

**Designer — Social media content**

Ga naar de Designer pagina en maak een nieuwe taak aan. Je kunt kiezen uit:
- **Carousel** — Meerdere slides voor Instagram, LinkedIn, etc.
- **Thumbnail** — YouTube of video thumbnails
- **Banner** — Headers voor social media of website
- **Infographic** — Data visualisaties

Geef een beschrijving van wat je wilt (bijv. "5-slide carousel over AI trends in 2026") en kies een engine:
- **Claude AI** — Genereert design via code (altijd beschikbaar met Anthropic key)
- **Nano Banana** — Genereert images via Google Gemini (vereist Inference.sh key)
- **Canva** — Maakt designs in Canva (vereist Canva koppeling)

**Researcher — Marktonderzoek**

Ga naar de Research pagina en maak een nieuw onderzoek aan. Voorbeelden:
- "Analyseer de top 5 concurrenten in de AI SaaS markt"
- "Wat zijn de trending topics op social media deze week?"
- "Maak een rapport over de crypto markt ontwikkelingen"

De Researcher gebruikt Claude AI om informatie te verzamelen, analyseren en een rapport te genereren.

**Content Creator — AI Video's**

Ga naar Content Creator om AI avatar video's te maken via HeyGen:
- Kies een avatar en stem
- Schrijf of genereer een script
- De video wordt automatisch gegenereerd

**Script Writer — Scripts en teksten**

Laat de Script Writer content schrijven:
- Video scripts voor YouTube, TikTok, Instagram Reels
- Social media captions en copy
- Blog posts en artikelen

**Marketeer — Strategie**

De Marketeer helpt met marketing planning:
- Content kalender opstellen
- Campagne ideeen genereren
- Doelgroep analyse

**Calendar — Agenda beheer**

Als Composio is gekoppeld kun je via de Calendar pagina:
- Afspraken inzien en aanmaken
- Meetings plannen
- Agenda overzicht bekijken

### Automatische taken instellen

Je kunt taken inplannen die automatisch op vaste tijden worden uitgevoerd. Ga naar de **Agents** pagina en maak een nieuw schema aan:

| Veld | Uitleg |
|------|--------|
| **Name** | Naam van het schema (bijv. "Dagelijkse Instagram post") |
| **Agent** | Welke agent de taak uitvoert (designer, researcher, scriptwriter, content_creator) |
| **Hour / Minute** | Tijdstip in UTC waarop de taak wordt uitgevoerd |
| **Days** | Op welke dagen (ma-zo) |
| **Payload** | Wat de agent moet doen (beschrijving, type, etc.) |

**Voorbeelden van automatische taken:**

- Elke werkdag om 09:00 een Instagram carousel genereren
- Elke maandag om 08:00 een marktonderzoek rapport
- Dagelijks om 10:00 een video script schrijven
- Elke vrijdag om 16:00 een weekoverzicht onderzoek

Taken worden automatisch uitgevoerd en het resultaat verschijnt in het dashboard. Als Telegram is ingesteld krijg je een notificatie als de taak klaar is.

### Telegram AI Assistant

Als je Telegram hebt ingesteld, kun je je AI assistant ook via Telegram bereiken. Stuur gewoon een bericht naar je bot:

| Commando | Wat het doet |
|----------|-------------|
| `/start` | Begroeting en uitleg |
| `/status` | Bot status en equity (als trading bots geinstalleerd) |
| `/clear` | Chat history wissen |
| *Elk bericht* | Claude AI antwoordt — stel vragen, geef opdrachten, vraag om analyses |

Je kunt via Telegram dezelfde dingen doen als in het Command Center — agents aansturen, vragen stellen, rapporten opvragen.

### Claude Code in de terminal

Claude Code is een AI assistent die direct op je server draait. Start het wanneer je wilt:

```bash
claude
```

Voorbeelden:

| Wat je vraagt | Wat Claude doet |
|--------------|-----------------|
| *"Maak een carousel post over AI trends"* | Stuurt een design taak naar de Designer agent |
| *"Wat zijn de trending topics vandaag?"* | Doet marktonderzoek via de Researcher |
| *"Toon mijn revenue deze maand"* | Haalt Stripe data op en maakt een rapport |
| *"Plan een meeting morgen om 10u"* | Beheert je Google Calendar via Composio |
| *"Pas de branding kleur aan naar blauw"* | Wijzigt de configuratie |
| *"Toon de logs van het Command Center"* | Opent en analyseert de log bestanden |

---

## 8. Instellingen Aanpassen

### Via het Dashboard

1. Ga naar **Settings** in de sidebar van het Command Center
2. Bovenaan zie je twee secties:

**Branding** — pas aan:
- Company Name, AI Assistant Name, Tagline
- Primary Color (met live preview)

**API Keys & Integrations** — pas aan:
- Anthropic API Key
- Telegram Bot Token + Chat ID
- HeyGen, Stripe, Composio, Apify keys

3. Klik **Save Changes**

Wijzigingen worden direct doorgevoerd.

### Telegram instellen (als je het eerder hebt overgeslagen)

**Stap 1: Telegram bot aanmaken**

1. Open Telegram en zoek **@BotFather**
2. Typ `/newbot`
3. Geef je bot een naam (bijv. "Mijn Platform Bot")
4. Geef je bot een username (bijv. `mijn_platform_bot`)
5. Je krijgt een **Bot Token** — kopieer dit

Het token ziet er zo uit: `1234567890:ABCdefGHIjklMNOpqrsTUVwxyz`

**Stap 2: Chat ID vinden**

1. Open een chat met je nieuwe bot in Telegram
2. Stuur een bericht (bijv. "hallo")
3. Open deze URL in je browser (vervang JOUW_TOKEN):

```
https://api.telegram.org/botJOUW_TOKEN/getUpdates
```

4. Zoek in de tekst naar `"chat":{"id":` — het getal erachter is je **Chat ID**

**Stap 3: Invullen in Command Center**

1. Ga naar Settings in het Command Center
2. Vul **Telegram Bot Token** en **Chat ID** in
3. Klik **Save Changes**

---

## 9. Trading Bots Addon

Trading bots zijn een aparte installatie die je later kunt toevoegen. De bots draaien onafhankelijk van het Command Center.

### Installeren

```bash
cd /root
git clone https://github.com/neuralabscloud/neuralabs-trading-bots.git
cd neuralabs-trading-bots
chmod +x install.sh
sudo ./install.sh
```

Na installatie open je `http://JOUW_IP:3000` en volg je de setup wizard om je wallets en private keys te configureren.

Zie de **NeuraLabs Trading Bots — Installatie Handleiding** voor de volledige stap-voor-stap guide.

---

## 10. Eigen Domein Koppelen

Je kunt een eigen domein koppelen aan je Command Center zodat je het bereikt via bijv. `https://mijnbedrijf.com` in plaats van `http://185.123.45.67:3004`.

### Stap 1: DNS instellen

Bij je domeinregistrar (Cloudflare, Namecheap, etc.):
- Maak een **A record** aan dat wijst naar je VPS IP-adres

### Stap 2: Nginx installeren

```bash
apt install -y nginx
```

### Stap 3: Nginx configureren

```bash
nano /etc/nginx/sites-available/commandcenter
```

Plak dit (vervang `jouwdomein.com`):

```nginx
server {
    listen 80;
    server_name jouwdomein.com;

    location / {
        proxy_pass http://127.0.0.1:3004;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Activeer en herstart:
```bash
ln -s /etc/nginx/sites-available/commandcenter /etc/nginx/sites-enabled/
nginx -t
systemctl restart nginx
```

### Stap 4: HTTPS instellen (gratis SSL)

```bash
apt install -y certbot python3-certbot-nginx
certbot --nginx -d jouwdomein.com
```

Volg de instructies. Certbot regelt automatisch een SSL certificaat en verlengt het elke 90 dagen.

Je Command Center is nu bereikbaar via `https://jouwdomein.com`.

---

## 11. Updaten

Als er updates beschikbaar zijn:

```bash
cd /root/neuralabs-command-center
bash update.sh
```

Dat is alles. Het script:
1. Haalt de laatste versie op van GitHub
2. Kopieert nieuwe code naar je installatie
3. Behoudt je `.env` configuratie
4. Herstart alle services

> **Je instellingen en data worden NOOIT overschreven.**

---

## 12. Troubleshooting

### Service checken

```bash
systemctl status command-center
```

### Logs bekijken

```bash
journalctl -u command-center -f
```

### Service herstarten

```bash
systemctl restart command-center
```

### Veelvoorkomende problemen

**"Dashboard laadt niet in browser"**
```bash
# Check of service draait
systemctl status command-center

# Open firewall poort
ufw allow 3004

# Check logs
journalctl -u command-center -n 30
```

**"Login werkt niet"**
- Controleer je wachtwoord
- Het wachtwoord is wat je hebt ingesteld tijdens de installatie
- Je kunt het wijzigen in `/opt/commandcenter/.env` (veld `CC_PASSWORD`)

**"AI functies werken niet"**
- Controleer of je Anthropic API key is ingesteld via Settings
- Test de key: ga naar Settings → klik "Test Connection" bij Anthropic

**"Telegram berichten komen niet aan"**
- Controleer of token en chat ID correct zijn via Settings
- Stuur `/start` naar je bot in Telegram
- Test handmatig:

```bash
curl -s "https://api.telegram.org/botJOUW_TOKEN/sendMessage" \
  -d "chat_id=JOUW_CHAT_ID&text=Test"
```

**"Redis fout"**
```bash
systemctl restart redis-server
redis-cli ping
# Moet PONG tonen
```

---

## 13. Veelgestelde Vragen

**Hoeveel kost het per maand?**
- VPS: €10-20/maand
- Anthropic API: ~€5-20/maand afhankelijk van gebruik
- Totaal: **~€15-40/maand** (zonder optionele integraties)

**Heb ik trading bots nodig?**

Nee. Het Command Center werkt volledig zelfstandig voor content creatie, research, marketing en analyse. Trading bots zijn een optionele addon die je later kunt installeren.

**Kan ik meerdere gebruikers toevoegen?**

Op dit moment gebruikt het Command Center een gedeeld wachtwoord. Iedereen met het wachtwoord heeft volledige toegang.

**Welke AI functies zijn beschikbaar zonder API keys?**

Zonder Anthropic API key werken de AI agents niet (Designer, Researcher, Analyst, etc.). De UI en Settings pagina werken wel. Je kunt op elk moment een API key toevoegen via Settings.

**Kan ik een eigen domein gebruiken?**

Ja, zie sectie 10. Met nginx en Let's Encrypt heb je gratis HTTPS op je eigen domein.

**Wat als mijn VPS herstart?**

Het Command Center start automatisch opnieuw via systemd. Je hoeft niks te doen.

**Hoe update ik?**
```bash
cd /root/neuralabs-command-center
bash update.sh
```

---

## Snelle Referentie

| Actie | Hoe |
|-------|-----|
| Command Center | `http://JOUW_IP:3004` |
| Eerste keer setup | Setup wizard (automatisch na login) |
| Instellingen wijzigen | Settings pagina in Command Center |
| Claude Code starten | `claude` in terminal |
| SSH naar server | `ssh root@JOUW_IP` |
| Service status | `systemctl status command-center` |
| Logs bekijken | `journalctl -u command-center -f` |
| Platform updaten | `cd /root/neuralabs-command-center && bash update.sh` |
| Trading Bots addon | Zie sectie 9 |

---

*Hulp nodig? Start Claude Code met `claude` en stel je vraag in het Nederlands. Je AI assistent kent je hele setup en helpt met alles.*
