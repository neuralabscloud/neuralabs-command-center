# Command Center — Complete Installation Guide

> From a blank VPS to a fully running AI-powered Command Center.
> This guide walks you through the entire process step by step.

---

## Table of Contents

1. [Purchase a VPS](#1-purchase-a-vps)
2. [Connect to your VPS (SSH)](#2-connect-to-your-vps-ssh)
3. [Prepare your VPS](#3-prepare-your-vps)
4. [Install the Command Center](#4-install-the-command-center)
5. [Setup Wizard — Configuration via Dashboard](#5-setup-wizard--configuration-via-dashboard)
6. [Command Center Overview](#6-command-center-overview)
7. [Daily Usage](#7-daily-usage)
8. [Adjusting Settings](#8-adjusting-settings)
9. [Trading Bots Addon](#9-trading-bots-addon)
10. [Connect a Custom Domain](#10-connect-a-custom-domain)
11. [Updating](#11-updating)
12. [Troubleshooting](#12-troubleshooting)
13. [Frequently Asked Questions](#13-frequently-asked-questions)

---

## What you need

| Item | Where to get it | Cost |
|------|----------------|------|
| VPS server (Ubuntu 22.04+, 2GB RAM) | Hostinger / Hetzner / DigitalOcean | ~€10-20/month |
| SSH client | Terminal (Mac/Linux) or PuTTY (Windows) | Free |
| GitHub account | https://github.com | Free |

**Optional (configure later via the setup wizard):**
- Anthropic API key (for AI features) — https://console.anthropic.com
- Telegram bot token (for notifications)
- HeyGen API key (for AI avatar videos)
- Stripe account (for revenue tracking)
- Composio API key (for Google Calendar integration)
- Meta Developer App (for Instagram performance tracking via Graph API — connect via Settings → Social Connections)
- Canva account (for design generation via the Designer agent)

---

## 1. Purchase a VPS

### What is a VPS?

A VPS (Virtual Private Server) is a server in the cloud that runs 24/7. Your Command Center runs here continuously, even when your laptop is off.

### Recommended specifications

| Specification | Minimum | Recommended |
|--------------|---------|-------------|
| OS | Ubuntu 22.04 LTS | Ubuntu 24.04 LTS |
| RAM | 2 GB | 4 GB |
| CPU | 1 vCPU | 2 vCPU |
| Storage | 20 GB SSD | 40 GB SSD |
| Location | Europe | Amsterdam / Frankfurt |

### Step by step: ordering a VPS (example: Hostinger)

1. Go to [hostinger.com](https://www.hostinger.com/vps-hosting)
2. Choose **KVM 2** or higher (4 GB RAM recommended)
3. Choose **Ubuntu 22.04** or **Ubuntu 24.04** as the operating system
4. Choose a location close to you (Amsterdam or Frankfurt)
5. Set a **root password** — **keep this safe!**
6. Complete the order

After ordering you will receive:
- An **IP address** (e.g. `185.123.45.67`)
- Your **root password** (the one you just set)

---

## 2. Connect to your VPS (SSH)

### On Mac / Linux

Open your **Terminal** and type:

```bash
ssh root@YOUR_IP_ADDRESS
```

Replace `YOUR_IP_ADDRESS` with the IP you received from your VPS provider.

Example:
```bash
ssh root@185.123.45.67
```

- The first time it asks: *"Are you sure you want to continue connecting?"* — type `yes`
- Enter your root password (you won't see any characters while typing — that's normal)

### On Windows

1. Download and install [PuTTY](https://www.putty.org/)
2. Open PuTTY
3. In "Host Name" enter your IP address
4. Click **Open**
5. Log in as `root` with your password

### Testing the connection

If you see this, you are connected:
```
root@server:~#
```

---

## 3. Prepare your VPS

Copy and paste these commands one by one:

### 3.1 Update the system

```bash
apt update && apt upgrade -y
```

This may take 2-5 minutes. If a purple/blue screen appears with questions, simply press **Enter**.

### 3.2 Install essentials

```bash
apt install -y git curl wget unzip build-essential
```

---

## 4. Install the Command Center

### 4.1 Download the repository

```bash
cd /root
git clone https://github.com/neuralabscloud/neuralabs-command-center.git
cd neuralabs-command-center
```

If prompted for a password, use your GitHub username and a **Personal Access Token** as the password. Create a token at: https://github.com/settings/tokens/new (select the `repo` scope).

### 4.2 Start the installer

```bash
chmod +x install.sh
sudo ./install.sh
```

The installer asks two questions:

```
> Dashboard login password:
```
Choose a strong password — this is what you will use to log in to the Command Center.

```
> Install directory [/opt/commandcenter]:
```
Press **Enter** for the default location.

The installer will now automatically:
1. Install Node.js, Python, Redis
2. Install Claude Code
3. Install Node.js packages
4. Configure and start the systemd service

This takes **2-5 minutes**.

### 4.3 Installation complete!

If everything goes well you will see:

```
╔══════════════════════════════════════════╗
║   Installation Complete!                  ║
╚══════════════════════════════════════════╝

  ▸ NEXT STEP:
  Open http://185.123.45.67:3004 in your browser
```

### Open the firewall

If the dashboard does not load, you need to open the port:
```bash
ufw allow 3004
```

---

## 5. Setup Wizard — Configuration via Dashboard

Open your browser and go to:

```
http://YOUR_IP:3004
```

Log in with the password you chose during installation.

The **Setup Wizard** appears automatically and guides you through 4 steps:

### Step 1: Branding

- **Company Name** — Your company name (shown in the UI and Telegram messages)
- **AI Assistant Name** — Name of your AI assistant (e.g. "Jarvis", "Atlas")
- **Tagline** — Short description of your platform
- **Primary Color** — Drag the slider to choose your brand color

### Step 2: AI (Anthropic API) — optional

- **Anthropic API Key** — Required for all AI features (research, design, analysis)

If you don't have this yet, click **Skip**. You can set it later via Settings.

**Create an API key:**
1. Go to https://console.anthropic.com
2. Create an account (or log in)
3. Go to **API Keys** in the sidebar
4. Click **Create Key**
5. Copy the key (starts with `sk-ant-...`)

### Step 3: Telegram Notifications — optional

To receive notifications for completed tasks, reports, and alerts, you need a Telegram bot.

**Create a bot:**
1. Open Telegram and search for **@BotFather**
2. Type `/newbot`
3. Give your bot a name (e.g. "My Platform Bot")
4. Give your bot a username (e.g. `my_platform_bot`)
5. You will receive a **Bot Token** — copy it (it looks like this: `1234567890:ABCdefGHIjklMNOpqrsTUVwxyz`)

**Find your Chat ID:**
1. Open a chat with your new bot in Telegram
2. Send a message (e.g. "hello")
3. Open this URL in your browser (replace YOUR_TOKEN):
```
https://api.telegram.org/botYOUR_TOKEN/getUpdates
```
4. Look in the text for `"chat":{"id":` — the number after it is your **Chat ID**

Fill in both fields in the wizard:
- **Bot Token** — The token from @BotFather
- **Chat ID** — The number you just found

After setting this up, you can chat directly with your AI assistant via Telegram. Send a message to your bot and you will get a response from Claude — the same AI running inside the Command Center.

**Telegram commands:**
| Command | What it does |
|---------|-------------|
| `/start` | Greeting and explanation of what the bot can do |
| `/status` | Bot status and account equity (if trading bots are installed) |
| `/clear` | Clear chat history |
| *Any other message* | AI assistant responds via Claude |

Click **Skip** if you want to set this up later. You can always add it via Settings.

### Step 4: Integrations — optional

- **HeyGen API Key** — For AI avatar video generation. Retrieve your key at [app.heygen.com/settings](https://app.heygen.com/settings)
- **Stripe Secret Key** — For revenue & subscription tracking. Find your key in your [Stripe Dashboard](https://dashboard.stripe.com/apikeys) (starts with `sk_live_` or `sk_test_`)
- **Inference.sh API Key** — For AI image generation (Nano Banana / Google Gemini). Used by the Designer agent. Retrieve your key at [inference.sh](https://inference.sh) (starts with `1nfsh-`)
- **Composio API Key** — For Google Calendar integration. Create one at [app.composio.dev](https://app.composio.dev)

All fields are optional. Click **Finish** or **Skip** to continue.

> **Social media accounts** (Instagram, TikTok, X, YouTube) are connected later via **Settings → Social Connections** using OAuth — no API keys needed.

### After the wizard: Connect Canva (optional)

Canva is used by the Designer agent for design generation. Canva uses OAuth (no API key):

1. Go to **Settings** in the Command Center
2. Find **Canva** in the integrations list
3. Click **Connect** and log in with your Canva account
4. Authorize the connection

Once connected, the Designer agent can create and edit designs directly in Canva.

> **That's it!** Your Command Center is now ready to use.

---

## 6. Command Center Overview

After the setup wizard you arrive at the Command Center dashboard. In the sidebar you will find all pages:

### Pages

| Page | What you'll find |
|------|----------------|
| **Overview** | Dashboard with an overview of all agents, recent tasks, and quick actions |
| **Research** | Market research, trend analysis, competitor analysis, daily reports |
| **Performance** | KPIs, revenue (Stripe), social media analytics (Instagram Graph API, YouTube Data API), growth metrics |
| **Agents** | Overview and management of all AI agents and their tasks |
| **Video Editor** | Edit, cut, merge, and export videos via Remotion |
| **Designer** | Create social media content: carousels, thumbnails, banners, infographics. Uses Claude AI, Canva, and Nano Banana (Inference.sh) |
| **Content Creator** | Generate AI avatar videos via HeyGen |
| **Script Writer** | Write scripts for videos, social media posts, and content |
| **Marketeer** | Marketing strategy, campaign planning, and content calendar |
| **Calendar** | Google Calendar management via Composio integration |
| **Settings** | Branding, API keys, integrations, and system configuration |

### AI Agents

Each agent is a specialized AI that performs tasks independently:

| Agent | What it does | Requires |
|-------|-------------|---------|
| **Designer** | Creates social media content: carousels, thumbnails, banners | Anthropic API key |
| **Researcher** | Market research, trend analysis, competitor analysis | Anthropic API key |
| **Video Editor** | Create and edit videos via Remotion (React-based video framework) | — (built-in) |
| **Content Creator** | Create AI avatar videos | HeyGen API key |
| **Script Writer** | Scripts for videos and content | Anthropic API key |
| **Marketeer** | Marketing strategy and campaign planning | Anthropic API key |
| **Calendar** | Google Calendar management | Composio API key |

---

## 7. Daily Usage

### Working with Agents

Each agent performs tasks for you. You create a task, the agent processes it, and you get the result back — in the dashboard and optionally via Telegram.

**Designer — Social media content**

Go to the Designer page and create a new task. You can choose from:
- **Carousel** — Multiple slides for Instagram, LinkedIn, etc.
- **Thumbnail** — YouTube or video thumbnails
- **Banner** — Headers for social media or website
- **Infographic** — Data visualizations

Provide a description of what you want (e.g. "5-slide carousel about AI trends in 2026") and choose an engine:
- **Claude AI** — Generates design via code (always available with Anthropic key)
- **Nano Banana** — Generates images via Google Gemini (requires Inference.sh key)
- **Canva** — Creates designs in Canva (requires Canva connection)

**Researcher — Market Research**

Go to the Research page and create a new research task. Examples:
- "Analyze the top 5 competitors in the AI SaaS market"
- "What are the trending topics on social media this week?"
- "Create a report on market developments in your niche"

The Researcher uses Claude AI to gather, analyze, and generate a report.

**Content Creator — AI Videos**

Go to Content Creator to create AI avatar videos via HeyGen:
- Choose an avatar and voice
- Write or generate a script
- The video is generated automatically

**Script Writer — Scripts and copy**

Let the Script Writer create content:
- Video scripts for YouTube, TikTok, Instagram Reels
- Social media captions and copy
- Blog posts and articles

**Marketeer — Strategy**

The Marketeer helps with marketing planning:
- Building a content calendar
- Generating campaign ideas
- Target audience analysis

**Calendar — Schedule management**

If Composio is connected you can use the Calendar page to:
- View and create appointments
- Schedule meetings
- View your agenda overview

### Setting up automated tasks

You can schedule tasks that are executed automatically at fixed times. Go to the **Agents** page and create a new schedule:

| Field | Explanation |
|-------|------------|
| **Name** | Name of the schedule (e.g. "Daily Instagram post") |
| **Agent** | Which agent performs the task (designer, researcher, scriptwriter, content_creator) |
| **Hour / Minute** | Time in UTC at which the task is executed |
| **Days** | On which days (Mon-Sun) |
| **Payload** | What the agent should do (description, type, etc.) |

**Examples of automated tasks:**

- Generate an Instagram carousel every weekday at 09:00
- Generate a market research report every Monday at 08:00
- Write a video script daily at 10:00
- Run a weekly overview research every Friday at 16:00

Tasks are executed automatically and the result appears in the dashboard. If Telegram is configured, you will receive a notification when the task is complete.

### Telegram AI Assistant

If you have Telegram set up, you can also reach your AI assistant via Telegram. Simply send a message to your bot:

| Command | What it does |
|---------|-------------|
| `/start` | Greeting and explanation |
| `/status` | Bot status and equity (if trading bots are installed) |
| `/clear` | Clear chat history |
| *Any message* | Claude AI responds — ask questions, give instructions, request analyses |

You can do the same things via Telegram as in the Command Center — direct agents, ask questions, request reports.

### Claude Code in the terminal

Claude Code is an AI assistant that runs directly on your server. Start it whenever you want:

```bash
claude
```

Examples:

| What you ask | What Claude does |
|-------------|-----------------|
| *"Create a carousel post about AI trends"* | Sends a design task to the Designer agent |
| *"What are the trending topics today?"* | Does market research via the Researcher |
| *"Show my revenue this month"* | Retrieves Stripe data and creates a report |
| *"Schedule a meeting tomorrow at 10am"* | Manages your Google Calendar via Composio |
| *"Change the branding color to blue"* | Updates the configuration |
| *"Show the Command Center logs"* | Opens and analyzes the log files |

---

## 8. Adjusting Settings

### Via the Dashboard

1. Go to **Settings** in the Command Center sidebar
2. At the top you will see two sections:

**Branding** — adjust:
- Company Name, AI Assistant Name, Tagline
- Primary Color (with live preview)

**API Keys & Integrations** — adjust:
- Anthropic API Key
- Telegram Bot Token + Chat ID
- HeyGen, Stripe, Composio keys
- Meta App ID/Secret (for Instagram Graph API), YouTube Data API key

3. Click **Save Changes**

Changes take effect immediately.

### Setting up Telegram (if you skipped it earlier)

**Step 1: Create a Telegram bot**

1. Open Telegram and search for **@BotFather**
2. Type `/newbot`
3. Give your bot a name (e.g. "My Platform Bot")
4. Give your bot a username (e.g. `my_platform_bot`)
5. You will receive a **Bot Token** — copy it

The token looks like this: `1234567890:ABCdefGHIjklMNOpqrsTUVwxyz`

**Step 2: Find your Chat ID**

1. Open a chat with your new bot in Telegram
2. Send a message (e.g. "hello")
3. Open this URL in your browser (replace YOUR_TOKEN):

```
https://api.telegram.org/botYOUR_TOKEN/getUpdates
```

4. Look in the text for `"chat":{"id":` — the number after it is your **Chat ID**

**Step 3: Enter in Command Center**

1. Go to Settings in the Command Center
2. Fill in **Telegram Bot Token** and **Chat ID**
3. Click **Save Changes**

---

## 9. Trading Bots Addon

Trading bots are a separate installation that you can add to your Command Center later.

### What you get

The Trading Bots addon includes:
- **Funding Rate Bot** — Delta-neutral funding rate arbitrage on Hyperliquid
- **Trend Bot** — Mean-reversion strategy with RSI + Bollinger Bands
- **Trading Dashboard** — Live monitoring with positions, PnL, order book, liquidations
- **Data Hub (Jarvis)** — Central market data service for real-time prices and funding rates
- **Analytics page** — Performance overview with daily AI reports

### Installing

```bash
cd /root
git clone https://github.com/neuralabscloud/neuralabs-trading-bots.git
cd neuralabs-trading-bots
chmod +x install.sh
sudo ./install.sh
```

After installation, open `http://YOUR_IP:3000` and follow the setup wizard to configure your wallets and private keys.

See the **Trading Bots — Installation Guide** for the complete step-by-step guide.

### Standalone or integrated

The trading bots work fully **standalone** via their own Trading Dashboard on port 3000. You do not need the Command Center to run the bots.

But if you also have the Command Center installed, they are automatically **integrated**:

| What changes in the Command Center | Explanation |
|------------------------------------|------------|
| **Sidebar** | A link to the Trading Dashboard appears |
| **Overview page** | Trading bots are shown with live status and PnL |
| **AI Team (Overview)** | The Analyst agent appears as a team member |
| **Agents page** | Analyst agent card is added |
| **Analyst page** | New page in the sidebar for bot performance analysis, trade history, and reports |
| **Telegram** | `/status` command shows bot equity and open positions |

The integration works automatically — the Command Center detects the trading bots via the Trading Dashboard API on `localhost:3000`. No additional configuration is needed.

---

## 10. Connect a Custom Domain

You can connect a custom domain to your Command Center so you can reach it via e.g. `https://yourcompany.com` instead of `http://185.123.45.67:3004`.

### Step 1: Configure DNS

At your domain registrar (Cloudflare, Namecheap, etc.):
- Create an **A record** pointing to your VPS IP address

### Step 2: Install Nginx

```bash
apt install -y nginx
```

### Step 3: Configure Nginx

```bash
nano /etc/nginx/sites-available/commandcenter
```

Paste this (replace `yourdomain.com`):

```nginx
server {
    listen 80;
    server_name yourdomain.com;

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

Activate and restart:
```bash
ln -s /etc/nginx/sites-available/commandcenter /etc/nginx/sites-enabled/
nginx -t
systemctl restart nginx
```

### Step 4: Set up HTTPS (free SSL)

```bash
apt install -y certbot python3-certbot-nginx
certbot --nginx -d yourdomain.com
```

Follow the instructions. Certbot automatically arranges an SSL certificate and renews it every 90 days.

Your Command Center is now accessible via `https://yourdomain.com`.

---

## 11. Updating

When updates are available:

```bash
cd /root/neuralabs-command-center
bash update.sh
```

That's all. The script:
1. Fetches the latest version from GitHub
2. Copies new code to your installation
3. Preserves your `.env` configuration
4. Restarts all services

> **Your settings and data will NEVER be overwritten.**

---

## 12. Troubleshooting

### Check the service

```bash
systemctl status command-center
```

### View logs

```bash
journalctl -u command-center -f
```

### Restart the service

```bash
systemctl restart command-center
```

### Common issues

**"Dashboard doesn't load in browser"**
```bash
# Check if service is running
systemctl status command-center

# Open firewall port
ufw allow 3004

# Check logs
journalctl -u command-center -n 30
```

**"Login doesn't work"**
- Check your password
- The password is what you set during installation
- You can change it in `/opt/commandcenter/.env` (field `CC_PASSWORD`)

**"AI features don't work"**
- Check that your Anthropic API key is set via Settings
- Test the key: go to Settings → click "Test Connection" next to Anthropic

**"Telegram messages aren't arriving"**
- Check that the token and chat ID are correct via Settings
- Send `/start` to your bot in Telegram
- Test manually:

```bash
curl -s "https://api.telegram.org/botYOUR_TOKEN/sendMessage" \
  -d "chat_id=YOUR_CHAT_ID&text=Test"
```

**"Redis error"**
```bash
systemctl restart redis-server
redis-cli ping
# Should show PONG
```

---

## 13. Frequently Asked Questions

**How much does it cost per month?**
- VPS: €10-20/month
- Anthropic API: ~€5-20/month depending on usage
- Total: **~€15-40/month** (without optional integrations)

**Do I need trading bots?**

No. The Command Center works fully standalone for content creation, research, marketing, and analysis. Trading bots are an optional addon that you can install later.

**Can I add multiple users?**

Currently the Command Center uses a shared password. Everyone with the password has full access.

**Which AI features are available without API keys?**

Without an Anthropic API key, the AI agents do not work (Designer, Researcher, Analyst, etc.). The UI and Settings page do work. You can add an API key at any time via Settings.

**Can I use a custom domain?**

Yes, see section 10. With nginx and Let's Encrypt you get free HTTPS on your own domain.

**What if my VPS restarts?**

The Command Center restarts automatically via systemd. You don't need to do anything.

**How do I update?**
```bash
cd /root/neuralabs-command-center
bash update.sh
```

---

## Quick Reference

| Action | How |
|--------|-----|
| Command Center | `http://YOUR_IP:3004` |
| First-time setup | Setup wizard (automatically after login) |
| Change settings | Settings page in Command Center |
| Start Claude Code | `claude` in terminal |
| SSH to server | `ssh root@YOUR_IP` |
| Service status | `systemctl status command-center` |
| View logs | `journalctl -u command-center -f` |
| Update platform | `cd /root/neuralabs-command-center && bash update.sh` |
| Trading Bots addon | See section 9 |

---

*Need help? Start Claude Code with `claude` and ask your question. Your AI assistant knows your entire setup and can help with anything.*
